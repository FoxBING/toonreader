import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";

/* ---------- types (mirror the Rust side) ---------- */

interface ImageInfo {
  index: number;
  name: string;
  w: number;
  h: number;
  status: string;
  src: string;
  upscaled: boolean;
  error?: string;
}

interface Manifest {
  folder: string;
  total: number;
  cached: number;
  last_index: number;
  last_frac: number;
  images: ImageInfo[];
}

interface Config {
  upscale_enabled: boolean;
  waifu2x_path: string;
  model_dir: string;
  noise: number;
  scale: number;
  preload: number;
  gpu_id: number;
  tile: number;
  upscale_all: boolean;
}

interface HistoryEntry {
  folder: string;
  name: string;
  cover: string;
  index: number;
  total: number;
  updated: number;
}

interface Stats {
  total: number;
  done: number;
  running: boolean;
  enabled: boolean;
  configured: boolean;
}

/* ---------- app ---------- */

export default function App() {
  const [settings, setSettings] = useState<Config | null>(null);
  const [images, setImages] = useState<ImageInfo[]>([]);
  const [cur, setCur] = useState(-1);
  const [range, setRange] = useState({ a: 0, b: -1 });
  const [recents, setRecents] = useState<HistoryEntry[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [toastMsg, setToastMsg] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [width, setWidth] = useState(0);
  // Reading strip width as % of the viewer; persisted across sessions.
  const [stripPct, setStripPct] = useState(() => {
    const v = +(localStorage.getItem("stripPct") || 100);
    return Number.isFinite(v) ? Math.max(30, Math.min(100, v)) : 100;
  });
  const [widthPanel, setWidthPanel] = useState(false);
  // index -> [naturalWidth, naturalHeight] when the real ratio differs from metadata
  const [dimsFix, setDimsFix] = useState<Record<number, [number, number]>>({});

  const viewerRef = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const preloading = useRef(new Set<string>());
  const pendingTarget = useRef<{ index: number; frac: number } | null>(null);
  const heightsRef = useRef<number[]>([]);
  const prevWidth = useRef(0);
  const curRef = useRef(-1);
  const fracRef = useRef(0);
  const offsetsRef = useRef<number[]>([]);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const toast = useCallback((msg: string) => {
    setToastMsg(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastMsg(""), 2600);
  }, []);

  /* ---------- layout: heights & offsets ---------- */

  const { heights, offsets } = useMemo(() => {
    const W = Math.max(1, width);
    const hs: number[] = [];
    const os: number[] = [];
    let y = 0;
    images.forEach((im, i) => {
      const [w, h] = dimsFix[i] ?? [im.w, im.h];
      const dh = Math.max(1, (W * h) / Math.max(1, w));
      hs.push(dh);
      os.push(y);
      y += dh;
    });
    os.push(y);
    return { heights: hs, offsets: os };
  }, [images, width, dimsFix]);

  offsetsRef.current = offsets;
  heightsRef.current = heights;
  curRef.current = cur;

  // Largest i such that offsets[i] <= top + 1.
  const indexAt = useCallback((top: number) => {
    const os = offsetsRef.current;
    if (images.length === 0) return 0;
    let lo = 0,
      hi = images.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (os[mid] <= top + 1) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }, [images.length]);

  const updateRange = useCallback(() => {
    const el = viewerRef.current;
    if (!el || images.length === 0) return;
    const top = el.scrollTop;
    const bot = top + el.clientHeight;
    const a = Math.max(0, indexAt(top) - 2);
    const b = Math.min(images.length - 1, indexAt(bot) + 2);
    setRange((r) => (r.a === a && r.b === b ? r : { a, b }));
  }, [images.length, indexAt]);

  /* ---------- scroll position preservation ---------- */
  // After a layout change (folder load or window resize), snap the scroll
  // back to the current page so resizing never jumps the reading position.
  useEffect(() => {
    const el = viewerRef.current;
    if (!el || images.length === 0 || offsets.length <= images.length) return;
    if (pendingTarget.current !== null) {
      const { index, frac } = pendingTarget.current;
      const t = Math.min(index, images.length - 1);
      el.scrollTop = (offsets[t] ?? 0) + Math.max(0, Math.min(1, frac)) * (heights[t] ?? 0);
      setCur(t);
      pendingTarget.current = null;
      updateRange();
    } else if (prevWidth.current !== width && curRef.current >= 0) {
      // Width changed (window resize or strip width control): restore the
      // exact mid-image position instead of snapping to the image top.
      const i = curRef.current;
      el.scrollTop = (offsets[i] ?? 0) + fracRef.current * (heights[i] ?? 0);
      updateRange();
    }
    prevWidth.current = width;
  }, [offsets, images.length, width, updateRange]);

  /* ---------- reader position -> backend ---------- */

  useEffect(() => {
    if (cur < 0) return;
    // Report not just which image is on top but how far into it we scrolled,
    // so resume lands mid-image instead of snapping to its top edge.
    const el = viewerRef.current;
    let frac = 0;
    if (el) {
      const os = offsetsRef.current;
      const hs = heightsRef.current;
      const dh = hs[cur] ?? 0;
      frac = dh > 0 ? Math.max(0, Math.min(1, (el.scrollTop - (os[cur] ?? 0)) / dh)) : 0;
    }
    fracRef.current = frac;
    invoke("set_current", { index: cur, frac }).catch(() => {});
    // Warm the webview image cache ahead of the reading position.
    const n = Math.max(1, settings?.preload ?? 10);
    for (let i = cur; i < Math.min(images.length, cur + n); i++) {
      const key = images[i]?.src;
      if (!key || preloading.current.has(key)) continue;
      preloading.current.add(key);
      const warm = new Image();
      warm.onload = warm.onerror = () => preloading.current.delete(key);
      warm.src = convertFileSrc(key);
    }
  }, [cur, images, settings?.preload]);

  /* ---------- events from backend ---------- */

  useEffect(() => {
    const unsubs: Promise<() => void>[] = [
      listen<Manifest>("opened", (e) => e.payload && loadManifest(e.payload)),
      listen<{ index: number; ok: boolean; msg?: string }>("upscaled", async (e) => {
        const { index, ok, msg } = e.payload ?? {};
        if (ok === false && msg) toast(`放大失败：${msg}`);
        if (index === undefined) return refreshStats();
        try {
          const info = await invoke<ImageInfo>("get_image", { index });
          if (!info.upscaled) return;
          setImages((prev) => {
            if (!prev[index]) return prev;
            const next = prev.slice();
            preloading.current.delete(next[index].src);
            next[index] = info;
            return next;
          });
        } catch {
          /* folder may have changed */
        }
      }),
      listen<string>("toast", (e) => toast(String(e.payload))),
    ];
    return () => unsubs.forEach((u) => u.then((f) => f()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toast]);

  /* ---------- init ---------- */

  const refreshRecents = useCallback(() => {
    invoke<HistoryEntry[]>("get_history")
      .then(setRecents)
      .catch(() => {});
  }, []);

  const refreshStats = useCallback(() => {
    invoke<Stats>("get_stats")
      .then(setStats)
      .catch(() => {});
  }, []);

  const refreshSources = useCallback(async () => {
    if (images.length === 0) return;
    const infos = await invoke<ImageInfo[]>("refresh_sources");
    preloading.current.clear();
    setImages((prev) => prev.map((p, i) => infos[i] ?? p));
  }, [images.length]);

  const loadManifest = useCallback(
    (m: Manifest) => {
      preloading.current.clear();
      setDimsFix({});
      setImages(m.images);
      const target = m.last_index > 0 && m.last_index < m.images.length ? m.last_index : 0;
      pendingTarget.current = { index: target, frac: m.last_frac ?? 0 };
      setCur(-1);
      if (target > 0) toast(`已回到上次进度：第 ${target + 1} / ${m.images.length} 张`);
      if (m.cached > 0) toast(`已放大缓存命中 ${m.cached}/${m.total} 张`);
      refreshStats();
    },
    [toast, refreshStats]
  );

  const openFolder = useCallback(
    async (path: string) => {
      try {
        const m = await invoke<Manifest>("open_folder", { path });
        loadManifest(m);
      } catch (e) {
        toast(String(e));
      }
    },
    [loadManifest, toast]
  );

  useEffect(() => {
    invoke<Config>("get_settings")
      .then((cfg) => setSettings(cfg))
      .catch(() => setSettings({ preload: 10 } as Config));
    invoke<Manifest | null>("take_startup")
      .then((m) => m && m.images && loadManifest(m))
      .catch(() => {});
    const unsub = getCurrentWebview().onDragDropEvent((ev) => {
      const p = ev.payload as { type: string; paths?: string[] };
      if (p.type === "enter" || p.type === "over") setDragging(true);
      else if (p.type === "leave") setDragging(false);
      else if (p.type === "drop") {
        setDragging(false);
        const path = p.paths?.[0];
        if (path) openFolder(path);
      }
    });
    const iv = setInterval(refreshStats, 2000);
    refreshStats();
    refreshRecents();
    return () => {
      unsub.then((f) => f());
      clearInterval(iv);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---------- scroll / resize observers ---------- */

  useEffect(() => {
    const el = viewerRef.current;
    const strip = stripRef.current;
    if (!el || !strip) return;
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        if (images.length === 0) return;
        const i = indexAt(el.scrollTop);
        // Keep the in-image offset fresh every frame: the width-change
        // restore below uses it, and a stale value would jump the view.
        const os = offsetsRef.current;
        const dh = heightsRef.current[i] ?? 0;
        fracRef.current =
          dh > 0 ? Math.max(0, Math.min(1, (el.scrollTop - (os[i] ?? 0)) / dh)) : 0;
        setCur((c) => (c === i ? c : i));
        updateRange();
      });
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    // Measure the strip, not the viewer: the strip is capped at 1100px and
    // centered, so beyond that width the two disagree and slots would get
    // wrong aspect ratios. Use the fractional rect — clientWidth rounds to
    // integers and sub-pixel height errors show up as seams between pages.
    const ro = new ResizeObserver(() => {
      setWidth(strip.getBoundingClientRect().width);
      updateRange();
    });
    ro.observe(strip);
    setWidth(strip.getBoundingClientRect().width);
    return () => {
      el.removeEventListener("scroll", onScroll);
      ro.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [images.length, indexAt, updateRange]);

  // Re-pick the render window when the layout or data changes without a scroll.
  useEffect(() => {
    updateRange();
  }, [images, offsets, updateRange]);

  // Close the width popover when clicking anywhere outside it.
  useEffect(() => {
    if (!widthPanel) return;
    const close = (e: PointerEvent) => {
      const t = e.target as HTMLElement;
      if (!t.closest("#wpop") && !t.closest("#wbtn")) setWidthPanel(false);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [widthPanel]);

  /* ---------- mode toggle ---------- */
  const toggleMode = useCallback(async () => {
    if (!settings) return;
    const next = { ...settings, upscale_enabled: !settings.upscale_enabled };
    setSettings(next);
    try {
      await invoke("save_settings", { config: next });
      await refreshSources();
      toast(next.upscale_enabled ? "已开启 AI 放大 ×2" : "已切换为原图模式");
    } catch (e) {
      setSettings(settings);
      toast(String(e));
    }
    refreshStats();
  }, [settings, refreshSources, toast, refreshStats]);

  /* ---------- home ---------- */

  const goHome = useCallback(() => {
    preloading.current.clear();
    setImages([]);
    setDimsFix({});
    setCur(-1);
    setRange({ a: 0, b: -1 });
    refreshRecents();
  }, [refreshRecents]);

  /* ---------- keyboard ---------- */

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA")) return;
      if (e.key === "Escape") {
        if (settingsOpen) setSettingsOpen(false);
        else if (curRef.current >= 0) goHome();
        return;
      }
      if (e.key === "s" || e.key === "S") {
        setSettingsOpen(true);
        return;
      }
      if (e.key === "a" || e.key === "A") {
        toggleMode();
        return;
      }
      if (e.key === "f" || e.key === "F") {
        if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
        else document.documentElement.requestFullscreen().catch(() => {});
        return;
      }
      const el = viewerRef.current;
      if (!el || images.length === 0) return;
      if (e.key === "Home") el.scrollTop = 0;
      else if (e.key === "End") el.scrollTop = offsetsRef.current[images.length];
      else if (e.key === "PageDown") {
        e.preventDefault();
        el.scrollBy({ top: el.clientHeight * 0.9 });
      } else if (e.key === "PageUp") {
        e.preventDefault();
        el.scrollBy({ top: -el.clientHeight * 0.9 });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [images.length, settingsOpen, toggleMode, goHome]);

  /* ---------- derived UI ---------- */

  const reading = images.length > 0;
  const statText = (() => {
    if (!stats) return { text: "…", cls: "" };
    if (!stats.enabled) return { text: "原图模式", cls: "" };
    if (!stats.configured) return { text: "未找到 waifu2x · 暂用原图", cls: "warn" };
    if (stats.total === 0) return { text: "waifu2x 就绪", cls: "on" };
    return {
      text: `已放大 ${stats.done}/${stats.total}${stats.running ? " · 处理中…" : ""}`,
      cls: stats.done >= stats.total ? "on" : "",
    };
  })();

  return (
    <>
      <div id="viewer" ref={viewerRef}>
        <div id="strip" ref={stripRef} style={{ width: `${stripPct}%` }}>
          {images.map((im, i) => (
            <div key={i} className={"slot" + (im.upscaled ? " hr" : "")} style={{ height: heights[i] }}>
              {i >= range.a && i <= range.b && (
                <Page
                  key={im.src}
                  im={im}
                  onDims={(w, h) => setDimsFix((d) => ({ ...d, [i]: [w, h] }))}
                />
              )}
            </div>
          ))}
        </div>
      </div>

      {!reading && (
        <div id="empty">
          <div className="box">
            <h2 className="recent-title">最近阅读</h2>
            <div id="wall">
              {recents.map((h) => (
                <div
                  key={h.folder}
                  className="poster"
                  title={h.folder}
                  onClick={() => openFolder(h.folder)}
                >
                  <div className="cover">
                    {h.cover ? (
                      <img src={convertFileSrc(h.cover)} alt="" draggable={false} />
                    ) : (
                      <span className="noimg">📁</span>
                    )}
                    <span className="prog">
                      第 {Math.min(h.index + 1, h.total)} / {h.total} 张
                    </span>
                  </div>
                  <div className="pname">{h.name || h.folder}</div>
                  <div className="ptime">{fmtTime(h.updated)}</div>
                </div>
              ))}
            </div>
            {recents.length === 0 && <p id="recent-empty">暂无阅读记录</p>}
            <p id="drag-hint">把漫画文件夹拖进窗口即可阅读</p>
          </div>
        </div>
      )}

      {dragging && (
        <div id="overlay">
          <div className="inner">松开鼠标，打开这个文件夹</div>
        </div>
      )}

      {reading && (
        <div id="hud">
          <button id="home" title="返回主页 (Esc)" onClick={goHome}>
            ⌂
          </button>
          <span id="pos">
            {cur + 1} / {images.length}
          </span>
          <button
            id="mode"
            className={settings?.upscale_enabled ? "on" : ""}
            title={settings?.upscale_enabled ? "AI 放大已开启，点击关闭" : "AI 放大已关闭，点击开启"}
            onClick={toggleMode}
          >
            AI ×2
          </button>
          <span id="stat" className={statText.cls}>
            {statText.text}
          </span>
          <button
            id="wbtn"
            title="调整图片宽度"
            className={widthPanel ? "on" : ""}
            onClick={() => setWidthPanel((o) => !o)}
          >
            ↔ {stripPct}%
          </button>
          {widthPanel && (
            <div id="wpop">
              <span>图片宽度 {stripPct}%</span>
              <input
                type="range"
                min={30}
                max={100}
                step={5}
                value={stripPct}
                onChange={(e) => {
                  const v = +e.target.value;
                  setStripPct(v);
                  localStorage.setItem("stripPct", String(v));
                }}
              />
            </div>
          )}
          <button id="gear" title="设置 (S)" onClick={() => setSettingsOpen(true)}>
            ⚙
          </button>
        </div>
      )}

      {settingsOpen && settings && (
        <SettingsModal
          settings={settings}
          onClose={() => setSettingsOpen(false)}
          onSaved={(cfg) => {
            setSettings(cfg);
            setSettingsOpen(false);
            toast("设置已保存");
            refreshSources().catch(() => {});
            refreshStats();
          }}
          toast={toast}
        />
      )}

      {toastMsg && <div id="toast">{toastMsg}</div>}
    </>
  );
}

/* ---------- single page image ---------- */

function Page({ im, onDims }: { im: ImageInfo; onDims: (w: number, h: number) => void }) {
  const [loaded, setLoaded] = useState(false);
  return (
    <img
      draggable={false}
      alt={im.name}
      src={convertFileSrc(im.src)}
      className={loaded ? "loaded" : ""}
      onLoad={(e) => {
        setLoaded(true);
        const el = e.currentTarget;
        // Snap the slot to the real pixel ratio on any difference, however
        // small: a slot aspect that is even slightly off makes object-fit:
        // contain letterbox and shows a seam between pages.
        if (
          el.naturalWidth > 0 &&
          Math.abs(el.naturalWidth / el.naturalHeight - im.w / im.h) > 1e-4
        ) {
          onDims(el.naturalWidth, el.naturalHeight);
        }
      }}
      onError={(e) => e.currentTarget.classList.add("error")}
    />
  );
}

/* ---------- settings modal ---------- */

function SettingsModal({
  settings,
  onClose,
  onSaved,
  toast,
}: {
  settings: Config;
  onClose: () => void;
  onSaved: (cfg: Config) => void;
  toast: (m: string) => void;
}) {
  const [cfg, setCfg] = useState<Config>(settings);
  const [detect, setDetect] = useState("");
  const set = <K extends keyof Config>(k: K, v: Config[K]) => setCfg((c) => ({ ...c, [k]: v }));

  useEffect(() => {
    invoke<Stats>("get_stats")
      .then((s) =>
        setDetect(
          s.configured
            ? "✓ 已找到 waifu2x（自动检测或手动配置）"
            : "✗ 未找到 waifu2x —— 请填写完整路径，或把 waifu2x-ncnn-vulkan.exe 放在程序目录旁的 waifu2x\\ 文件夹里"
        )
      )
      .catch(() => setDetect("检测失败"));
  }, []);

  const save = async () => {
    const out: Config = {
      ...cfg,
      waifu2x_path: cfg.waifu2x_path.trim(),
      model_dir: cfg.model_dir.trim(),
      preload: Math.max(1, Math.min(50, cfg.preload || 10)),
      scale: 2,
    };
    try {
      await invoke("save_settings", { config: out });
      onSaved(out);
    } catch (e) {
      toast(String(e));
    }
  };

  return (
    <div id="settings" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="card">
        <h2>设置</h2>
        <label className="chk">
          <input
            type="checkbox"
            checked={cfg.upscale_enabled}
            onChange={(e) => set("upscale_enabled", e.target.checked)}
          />{" "}
          启用 AI 放大（waifu2x ×2，默认关闭，可随时点顶栏按钮切换）
        </label>
        <label>
          waifu2x 程序路径（留空 = 自动检测同目录）
          <input
            type="text"
            placeholder="waifu2x-ncnn-vulkan.exe"
            spellCheck={false}
            value={cfg.waifu2x_path}
            onChange={(e) => set("waifu2x_path", e.target.value)}
          />
        </label>
        <label>
          模型目录（留空 = 程序目录下的 models-cunet）
          <input
            type="text"
            placeholder="models-cunet"
            spellCheck={false}
            value={cfg.model_dir}
            onChange={(e) => set("model_dir", e.target.value)}
          />
        </label>
        <div className="row">
          <label>
            降噪级别
            <select value={cfg.noise} onChange={(e) => set("noise", +e.target.value)}>
              <option value={-1}>-1 不降噪</option>
              <option value={0}>0</option>
              <option value={1}>1</option>
              <option value={2}>2</option>
              <option value={3}>3</option>
            </select>
          </label>
          <label>
            预加载张数
            <input
              type="number"
              min={1}
              max={50}
              value={cfg.preload}
              onChange={(e) => set("preload", +e.target.value)}
            />
          </label>
          <label>
            GPU 序号
            <input
              type="number"
              min={-1}
              max={8}
              value={cfg.gpu_id}
              onChange={(e) => set("gpu_id", +e.target.value)}
            />
          </label>
          <label>
            Tile 大小
            <input
              type="number"
              min={0}
              max={1024}
              value={cfg.tile}
              onChange={(e) => set("tile", +e.target.value)}
            />
          </label>
        </div>
        <label className="chk">
          <input
            type="checkbox"
            checked={cfg.upscale_all}
            onChange={(e) => set("upscale_all", e.target.checked)}
          />{" "}
          空闲时继续放大整本（预加载窗口跑完后不停）
        </label>
        <p id="s-detect" className="dim">
          {detect}
        </p>
        <p className="dim">
          放大结果缓存在程序旁的 cache 文件夹（按文件夹区分），重新打开同一本秒加载。jpg
          有压缩噪点时建议降噪 1~2。
        </p>
        <div className="btns">
          <button className="primary" onClick={save}>
            保存
          </button>
          <button onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  );
}

/* ---------- misc ---------- */

function fmtTime(unix: number) {
  const d = new Date(unix * 1000);
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}
