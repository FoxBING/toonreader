/* ToonReader frontend — vanilla JS, no build step. */

const T = window.__TAURI__;
if (!T) {
  document.body.innerHTML =
    '<p style="padding:40px">请在 Tauri 中运行本页面（cargo tauri dev）。</p>';
  throw new Error('no __TAURI__');
}

const { invoke, convertFileSrc } = T.core;
const { listen } = T.event;
const { getCurrentWebview } = T.webview;

const viewer = document.getElementById('viewer');
const strip = document.getElementById('strip');
const empty = document.getElementById('empty');
const overlay = document.getElementById('overlay');
const hud = document.getElementById('hud');
const posEl = document.getElementById('pos');
const statEl = document.getElementById('stat');
const modeBtn = document.getElementById('mode');
const bar = document.getElementById('bar');
const slider = document.getElementById('slider');
const settingsEl = document.getElementById('settings');
const toastEl = document.getElementById('toast');

let images = [];        // ImageInfo {index,name,w,h,status,src,upscaled}
let slots = [];         // slot divs
let heights = [];       // display height per image (px)
let offsets = [];       // cumulative top per image, offsets[n] = total height
let cur = -1;           // current top-most visible index
let settings = null;
let folderName = '';

const imgEls = new Map();   // index -> <img> currently mounted
const preloading = new Set(); // src keys already handed to Image()

init();

async function init() {
  settings = await invoke('get_settings').catch(() => ({ preload: 10 }));
  fillForm(settings);

  await listen('upscaled', onUpscaled);
  await listen('opened', takeStartup);
  await listen('toast', (e) => toast(String(e.payload)));
  await getCurrentWebview().onDragDropEvent(onDrag);
  await takeStartup();

  viewer.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', debounce(onResize, 150));
  window.addEventListener('keydown', onKey);

  slider.addEventListener('pointerdown', () => { sliderActive = true; });
  window.addEventListener('pointerup', () => { sliderActive = false; });
  slider.addEventListener('input', () => {
    const i = Math.min(images.length - 1, Math.max(0, +slider.value));
    if (offsets[i] !== undefined) viewer.scrollTop = offsets[i];
  });

  document.getElementById('gear').addEventListener('click', openSettings);
  modeBtn.addEventListener('click', toggleMode);
  document.getElementById('s-close').addEventListener('click', () => settingsEl.classList.add('hidden'));
  document.getElementById('s-save').addEventListener('click', saveSettings);
  settingsEl.addEventListener('click', (e) => {
    if (e.target === settingsEl) settingsEl.classList.add('hidden');
  });

  setInterval(refreshStats, 2000);
  refreshStats();
  updateModeUI();
  renderRecents();
}

/* ---------- recent folders (empty screen) ---------- */

async function renderRecents() {
  try {
    const list = await invoke('get_history');
    const ul = document.getElementById('recent-list');
    ul.innerHTML = '';
    for (const h of list) {
      const li = document.createElement('li');
      const d = new Date(h.updated * 1000);
      const p2 = (n) => String(n).padStart(2, '0');
      const ts = `${d.getMonth() + 1}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
      const fname = document.createElement('span');
      fname.className = 'fname';
      fname.textContent = h.name || h.folder;
      const fmeta = document.createElement('span');
      fmeta.className = 'fmeta';
      fmeta.textContent = `第 ${Math.min(h.index + 1, h.total)} / ${h.total} 张 · ${ts}`;
      li.append(fname, fmeta);
      li.title = h.folder;
      li.addEventListener('click', () => openFolder(h.folder));
      ul.appendChild(li);
    }
    document.getElementById('recent-empty').classList.toggle('hidden', list.length > 0);
  } catch { /* ignore */ }
}

/* ---------- upscale mode toggle ---------- */

function updateModeUI() {
  const on = !!(settings && settings.upscale_enabled);
  modeBtn.classList.toggle('on', on);
  modeBtn.title = on ? 'AI 放大已开启，点击关闭' : 'AI 放大已关闭，点击开启';
}

async function toggleMode() {
  if (!settings) return;
  settings.upscale_enabled = !settings.upscale_enabled;
  updateModeUI();
  try {
    await invoke('save_settings', { config: settings });
    await refreshSources();
    toast(settings.upscale_enabled ? '已开启 AI 放大 ×2' : '已切换为原图模式');
  } catch (e) {
    settings.upscale_enabled = !settings.upscale_enabled;
    updateModeUI();
    toast(String(e));
  }
  refreshStats();
}

// Re-resolve every image src after a mode switch (done items swap between
// the original and the cached upscaled file).
async function refreshSources() {
  if (!images.length) return;
  const infos = await invoke('refresh_sources');
  for (const info of infos) {
    const i = info.index;
    if (!images[i]) continue;
    images[i] = info;
    slots[i].classList.toggle('hr', !!info.upscaled);
    const el = imgEls.get(i);
    if (el) {
      const next = convertFileSrc(info.src);
      if (el.getAttribute('src') !== next) {
        el.classList.remove('loaded');
        el.src = next;
        el.addEventListener('load', () => el.classList.add('loaded'), { once: true });
      }
    }
  }
  preloading.clear();
  preloadAhead();
}

/* ---------- drag & drop ---------- */

function onDrag(ev) {
  const p = ev.payload || {};
  if (p.type === 'enter' || p.type === 'over') {
    overlay.classList.add('active');
  } else if (p.type === 'leave') {
    overlay.classList.remove('active');
  } else if (p.type === 'drop') {
    overlay.classList.remove('active');
    const path = (p.paths && p.paths[0]) || '';
    if (path) openFolder(path);
  }
}

async function openFolder(path) {
  try {
    const m = await invoke('open_folder', { path });
    loadManifest(m);
  } catch (e) {
    toast(String(e));
  }
}

/* ---------- layout ---------- */

function loadManifest(m) {
  for (const el of imgEls.values()) el.remove();
  imgEls.clear();
  preloading.clear();
  strip.innerHTML = '';

  folderName = m.folder;
  images = m.images;
  slots = images.map(() => {
    const d = document.createElement('div');
    d.className = 'slot';
    strip.appendChild(d);
    return d;
  });
  images.forEach((im, i) => slots[i].classList.toggle('hr', !!im.upscaled));

  computeLayout();
  empty.classList.add('hidden');
  hud.classList.remove('hidden');
  bar.classList.remove('hidden');
  slider.max = String(images.length - 1);

  // Resume where the reader left off last time.
  const target = (m.last_index > 0 && m.last_index < images.length) ? m.last_index : 0;
  viewer.scrollTop = 0;
  cur = -1;
  render();
  if (target > 0) {
    viewer.scrollTop = offsets[target];
    setCurrent(target);
    toast(`已回到上次进度：第 ${target + 1} / ${images.length} 张`);
  } else {
    setCurrent(0);
  }
  if (m.cached > 0) toast(`已放大缓存命中 ${m.cached}/${m.total} 张`);
}

function computeLayout() {
  const W = Math.max(1, strip.clientWidth);
  let y = 0;
  offsets = [];
  heights = images.map((im) => {
    // Fractional heights: rounding here is what creates visible seams
    // between consecutive images in the strip.
    const h = Math.max(1, (W * im.h) / im.w);
    offsets.push(y);
    y += h;
    return h;
  });
  offsets.push(y);
  slots.forEach((s, i) => { s.style.height = heights[i] + 'px'; });
}

// Largest i such that offsets[i] <= top + 1.
function indexAt(top) {
  let lo = 0, hi = images.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offsets[mid] <= top + 1) lo = mid; else hi = mid - 1;
  }
  return lo;
}

function fixHeight(i, nh) {
  if (heights[i] === nh) return;
  heights[i] = nh;
  slots[i].style.height = nh + 'px';
  let y = offsets[i];
  for (let j = i; j < images.length; j++) {
    offsets[j] = y;
    y += heights[j];
  }
  offsets[images.length] = y;
}

/* ---------- rendering (virtualized) ---------- */

function onScroll() {
  requestAnimationFrame(() => {
    if (!images.length) return;
    const i = indexAt(viewer.scrollTop);
    if (i !== cur) setCurrent(i);
    render();
    updateHud();
  });
}

function setCurrent(i) {
  cur = i;
  invoke('set_current', { index: i }).catch(() => {});
  preloadAhead();
  updateHud();
}

function render() {
  const top = viewer.scrollTop;
  const bot = top + viewer.clientHeight;
  let a = Math.max(0, indexAt(top) - 2);
  let b = Math.min(images.length - 1, indexAt(bot) + 2);
  for (let i = a; i <= b; i++) if (!imgEls.has(i)) mountImg(i);
  for (const [i, el] of imgEls) {
    if (i < a || i > b) { el.remove(); imgEls.delete(i); }
  }
}

function mountImg(i) {
  const im = images[i];
  const img = document.createElement('img');
  img.draggable = false;
  img.alt = im.name;
  img.src = convertFileSrc(im.src);
  img.addEventListener('load', () => {
    img.classList.add('loaded');
    const W = strip.clientWidth;
    if (img.naturalWidth > 0 &&
        Math.abs(img.naturalWidth / img.naturalHeight - im.w / im.h) > 0.02) {
      fixHeight(i, Math.max(1, (W * img.naturalHeight) / img.naturalWidth));
    }
  });
  img.addEventListener('error', () => img.classList.add('error'));
  slots[i].appendChild(img);
  imgEls.set(i, img);
}

// Warm the webview image cache for the next `preload` images.
function preloadAhead() {
  const n = Math.max(1, (settings && settings.preload) || 10);
  for (let i = cur; i < Math.min(images.length, cur + n); i++) {
    const key = images[i].src;
    if (preloading.has(key)) continue;
    preloading.add(key);
    const warm = new Image();
    warm.onload = warm.onerror = () => preloading.delete(key);
    warm.src = convertFileSrc(key);
  }
}

/* ---------- startup folder (CLI arg) ---------- */

async function takeStartup() {
  try {
    const m = await invoke('take_startup');
    if (m && m.images) loadManifest(m);
  } catch { /* ignore */ }
}

/* ---------- events from backend ---------- */

async function onUpscaled(ev) {
  const { index, ok, msg } = ev.payload || {};
  if (ok === false && msg) toast(`放大失败：${msg}`);
  if (index === undefined || !images[index]) { refreshStats(); return; }
  try {
    const info = await invoke('get_image', { index });
    if (!info.upscaled) return;
    const oldSrc = images[index].src;
    images[index] = info;
    slots[index].classList.add('hr');
    // Drop the stale preload marker so the new hi-res src gets warmed too.
    preloading.delete(oldSrc);
    const el = imgEls.get(index);
    if (el) {
      el.classList.remove('loaded');
      el.src = convertFileSrc(info.src);
      el.addEventListener('load', () => el.classList.add('loaded'), { once: true });
    } else {
      const warm = new Image();
      warm.src = convertFileSrc(info.src);
      preloading.add(info.src);
      warm.onload = warm.onerror = () => preloading.delete(info.src);
    }
  } catch { /* folder may have changed */ }
  if (!ok) refreshStats();
}

/* ---------- hud / stats ---------- */

let sliderActive = false;

function updateHud() {
  if (!images.length) return;
  posEl.textContent = `${cur + 1} / ${images.length}`;
  if (!sliderActive) slider.value = String(cur);
}

async function refreshStats() {
  try {
    const s = await invoke('get_stats');
    if (!s.enabled) {
      statEl.textContent = '原图模式';
      statEl.className = '';
    } else if (!s.configured) {
      statEl.textContent = '未找到 waifu2x · 暂用原图';
      statEl.className = 'warn';
    } else if (s.total === 0) {
      statEl.textContent = 'waifu2x 就绪';
      statEl.className = 'on';
    } else {
      statEl.textContent = `已放大 ${s.done}/${s.total}${s.running ? ' · 处理中…' : ''}`;
      statEl.className = s.done >= s.total ? 'on' : '';
    }
  } catch { /* ignore */ }
}

/* ---------- settings ---------- */

function fillForm(cfg) {
  document.getElementById('s-enabled').checked = !!cfg.upscale_enabled;
  document.getElementById('s-exe').value = cfg.waifu2x_path || '';
  document.getElementById('s-model').value = cfg.model_dir || '';
  document.getElementById('s-noise').value = String(cfg.noise ?? 0);
  document.getElementById('s-preload').value = cfg.preload || 10;
  document.getElementById('s-gpu').value = cfg.gpu_id ?? -1;
  document.getElementById('s-tile').value = cfg.tile || 0;
  document.getElementById('s-all').checked = !!cfg.upscale_all;
}

function openSettings() {
  settingsEl.classList.remove('hidden');
  refreshDetect();
}

async function refreshDetect() {
  const el = document.getElementById('s-detect');
  try {
    const s = await invoke('get_stats');
    if (s.configured) {
      el.textContent = '✓ 已找到 waifu2x（自动检测或手动配置）';
      el.style.color = 'var(--ok)';
    } else {
      el.textContent = '✗ 未找到 waifu2x —— 请在上方填写完整路径，或把 waifu2x-ncnn-vulkan.exe 放在程序目录旁的 waifu2x\\ 文件夹里';
      el.style.color = '#d8a63c';
    }
  } catch {
    el.textContent = '检测失败';
  }
}

async function saveSettings() {
  const cfg = {
    upscale_enabled: document.getElementById('s-enabled').checked,
    waifu2x_path: document.getElementById('s-exe').value.trim(),
    model_dir: document.getElementById('s-model').value.trim(),
    noise: parseInt(document.getElementById('s-noise').value, 10) || 0,
    scale: 2,
    preload: Math.max(1, Math.min(50, parseInt(document.getElementById('s-preload').value, 10) || 10)),
    gpu_id: parseInt(document.getElementById('s-gpu').value, 10) || -1,
    tile: parseInt(document.getElementById('s-tile').value, 10) || 0,
    upscale_all: document.getElementById('s-all').checked,
  };
  try {
    await invoke('save_settings', { config: cfg });
    settings = cfg;
    settingsEl.classList.add('hidden');
    toast('设置已保存');
    updateModeUI();
    await refreshSources().catch(() => {});
    refreshStats();
    if (cur >= 0) preloadAhead();
  } catch (e) {
    toast(String(e));
  }
}

/* ---------- misc ---------- */

function onResize() {
  if (!images.length) return;
  computeLayout();
  render();
}

function onKey(e) {
  if (!settingsEl.classList.contains('hidden')) {
    if (e.key === 'Escape') settingsEl.classList.add('hidden');
    return;
  }
  if (e.key === 's' || e.key === 'S') { openSettings(); return; }
  if (e.key === 'a' || e.key === 'A') { toggleMode(); return; }
  if (e.key === 'f' || e.key === 'F') {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else document.documentElement.requestFullscreen().catch(() => {});
    return;
  }
  if (!images.length) return;
  if (e.key === 'Home') viewer.scrollTop = 0;
  else if (e.key === 'End') viewer.scrollTop = offsets[images.length];
  else if (e.key === 'PageDown') { e.preventDefault(); viewer.scrollBy({ top: viewer.clientHeight * 0.9 }); }
  else if (e.key === 'PageUp') { e.preventDefault(); viewer.scrollBy({ top: -viewer.clientHeight * 0.9 }); }
}

let toastTimer = null;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.add('hidden'), 2600);
}

function debounce(fn, ms) {
  let t = null;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}
