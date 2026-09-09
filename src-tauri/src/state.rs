use std::collections::HashMap;
use std::fs;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::path::{Path, PathBuf};
use std::process::Child;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::natural::natural_cmp;

#[derive(Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Config {
    /// Master switch for AI upscaling. Default off: pure original reading.
    pub upscale_enabled: bool,
    /// Full path to waifu2x-ncnn-vulkan(.exe). Empty = auto-detect near the app.
    pub waifu2x_path: String,
    /// Model directory. Empty = <exe dir>/models-cunet
    pub model_dir: String,
    /// -1 none, 0..3
    pub noise: i32,
    pub scale: u32,
    /// How many images ahead of the reading position to upscale.
    pub preload: usize,
    /// GPU id, -1 = auto
    pub gpu_id: i32,
    /// Tile size, 0 = auto
    pub tile: i32,
    /// Keep upscaling the whole folder after the preload window is satisfied.
    pub upscale_all: bool,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            upscale_enabled: false,
            waifu2x_path: String::new(),
            model_dir: String::new(),
            noise: 0,
            scale: 2,
            preload: 10,
            gpu_id: -1,
            tile: 0,
            upscale_all: false,
        }
    }
}

impl Config {
    /// Resolve the waifu2x executable: explicit path first, then probe
    /// `<root>/waifu2x/` and `<root>/` for cwd / exe ancestors so the
    /// repo-local copy works with zero config.
    pub fn resolve_exe(&self) -> Option<PathBuf> {
        let raw = self.waifu2x_path.trim();
        if !raw.is_empty() {
            let p = PathBuf::from(raw);
            return p.is_file().then_some(p);
        }
        let mut roots: Vec<PathBuf> = Vec::new();
        if let Ok(cwd) = std::env::current_dir() {
            roots.push(cwd);
        }
        if let Ok(exe) = std::env::current_exe() {
            let mut cur = exe.parent().map(|p| p.to_path_buf());
            for _ in 0..5 {
                match cur {
                    Some(d) => {
                        roots.push(d.clone());
                        cur = d.parent().map(|p| p.to_path_buf());
                    }
                    None => break,
                }
            }
        }
        roots
            .iter()
            .flat_map(|r| {
                [
                    r.join("waifu2x").join("waifu2x-ncnn-vulkan.exe"),
                    r.join("waifu2x-ncnn-vulkan.exe"),
                ]
            })
            .find(|p| p.is_file())
    }

    pub fn resolve_model_dir(&self, exe: &Path) -> PathBuf {
        let raw = self.model_dir.trim();
        if !raw.is_empty() {
            return PathBuf::from(raw);
        }
        exe.parent().unwrap_or(Path::new(".")).join("models-cunet")
    }
}

#[derive(Clone, Serialize)]
pub struct ImageInfo {
    pub index: usize,
    pub name: String,
    pub w: u32,
    pub h: u32,
    /// pending | running | done | failed
    pub status: String,
    /// Path the frontend should load (upscaled when done, original otherwise).
    pub src: String,
    pub upscaled: bool,
    /// Failure reason when status == "failed".
    pub error: Option<String>,
}

#[derive(Clone)]
pub enum St {
    Pending,
    Running,
    Done(PathBuf),
    Failed(String),
}

impl St {
    pub fn as_str(&self) -> &'static str {
        match self {
            St::Pending => "pending",
            St::Running => "running",
            St::Done(_) => "done",
            St::Failed(_) => "failed",
        }
    }
}

pub struct Entry {
    pub name: String,
    pub path: PathBuf,
    pub size: u64,
    pub mtime: u64,
    pub w: u32,
    pub h: u32,
    pub status: St,
}

pub struct FolderData {
    pub path: PathBuf,
    /// Hash key shared by the cache dir and the history entry.
    pub hash: String,
    pub cache_dir: PathBuf,
    pub entries: Vec<Entry>,
    /// Bumped on every folder change so in-flight jobs can detect staleness.
    pub epoch: u64,
}

#[derive(Clone, Serialize)]
pub struct Manifest {
    pub folder: String,
    pub total: usize,
    pub cached: usize,
    /// Reading position saved from a previous session (0 = none).
    pub last_index: usize,
    /// How far into last_index the reader was, 0..1.
    pub last_frac: f64,
    pub images: Vec<ImageInfo>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct HistoryEntry {
    pub folder: String,
    pub name: String,
    /// Path of the first image, used as the poster on the welcome page.
    #[serde(default)]
    pub cover: String,
    pub index: usize,
    pub total: usize,
    /// Position inside the remembered image, 0..1 (0 = top edge).
    #[serde(default)]
    pub frac: f64,
    pub updated: u64,
}

#[derive(Serialize, Clone)]
pub struct Stats {
    pub total: usize,
    pub done: usize,
    pub running: bool,
    pub enabled: bool,
    pub configured: bool,
}

pub struct Reader {
    pub app: AppHandle,
    pub cfg: Mutex<Config>,
    /// Guarded by `cv`. Worker waits on this mutex when idle.
    pub folder: Mutex<Option<FolderData>>,
    pub current: AtomicUsize,
    pub cv: Condvar,
    pub child: Mutex<Option<Child>>,
    /// Folder opened via CLI arg, pulled by the frontend once it is ready.
    pub pending: Mutex<Option<Manifest>>,
    /// Reading progress per folder hash, persisted to history.json.
    pub history: Mutex<HashMap<String, HistoryEntry>>,
    /// Unix seconds of the last history flush (throttle disk writes).
    pub last_flush: AtomicU64,
}

impl Reader {
    pub fn new(app: AppHandle) -> Arc<Reader> {
        let cfg = load_config(&app).unwrap_or_default();
        let history: HashMap<String, HistoryEntry> =
            fs::read_to_string(history_path(&app))
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_default();
        Arc::new(Reader {
            app,
            cfg: Mutex::new(cfg),
            folder: Mutex::new(None),
            current: AtomicUsize::new(0),
            cv: Condvar::new(),
            child: Mutex::new(None),
            pending: Mutex::new(None),
            history: Mutex::new(history),
            last_flush: AtomicU64::new(0),
        })
    }

    pub fn get_config(&self) -> Config {
        self.cfg.lock().unwrap().clone()
    }

    pub fn save_config(&self, cfg: Config) -> Result<(), String> {
        let json = serde_json::to_string_pretty(&cfg).map_err(|e| e.to_string())?;
        fs::write(config_path(&self.app), json).map_err(|e| e.to_string())?;
        {
            let mut c = self.cfg.lock().unwrap();
            *c = cfg;
        }
        // Settings changed: give failed images another chance.
        {
            let mut f = self.folder.lock().unwrap();
            if let Some(fd) = f.as_mut() {
                for e in fd.entries.iter_mut() {
                    if matches!(e.status, St::Failed(_)) {
                        e.status = St::Pending;
                    }
                }
            }
        }
        self.kick();
        Ok(())
    }

    /// Wake the worker thread.
    pub fn kick(&self) {
        let _guard = self.folder.lock().unwrap();
        self.cv.notify_all();
    }

    pub fn set_current(&self, index: usize, frac: f64) {
        self.current.store(index, Ordering::SeqCst);
        let frac = frac.clamp(0.0, 1.0);
        let now = now_secs();
        {
            let f = self.folder.lock().unwrap();
            if let Some(fd) = f.as_ref() {
                let mut h = self.history.lock().unwrap();
                let total = fd.entries.len();
                let e = h.entry(fd.hash.clone()).or_insert(HistoryEntry {
                    folder: String::new(),
                    name: String::new(),
                    cover: String::new(),
                    index,
                    total,
                    frac,
                    updated: now,
                });
                e.folder = fd.path.to_string_lossy().to_string();
                e.name = fd
                    .path
                    .file_name()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_else(|| e.folder.clone());
                if e.cover.is_empty() {
                    e.cover = fd
                        .entries
                        .first()
                        .map(|en| en.path.to_string_lossy().to_string())
                        .unwrap_or_default();
                }
                e.index = index;
                e.total = total;
                e.frac = frac;
                e.updated = now;
            }
        }
        self.kick();
        // Persist at most every 2 s; the close handler flushes the tail.
        if now.saturating_sub(self.last_flush.load(Ordering::SeqCst)) >= 2 {
            self.flush_history();
        }
    }

    /// Force-write the history map to disk (window close, etc.).
    pub fn flush_history(&self) {
        let h = self.history.lock().unwrap().clone();
        if let Ok(json) = serde_json::to_string(&h) {
            let _ = fs::write(history_path(&self.app), json);
        }
        self.last_flush.store(now_secs(), Ordering::SeqCst);
    }

    /// Most recently read folders, newest first.
    pub fn recents(&self) -> Vec<HistoryEntry> {
        let h = self.history.lock().unwrap();
        let mut v: Vec<_> = h.values().cloned().collect();
        v.sort_by(|a, b| b.updated.cmp(&a.updated));
        v.truncate(20);
        v
    }

    pub fn open_folder(&self, path: &str) -> Result<Manifest, String> {
        let dir = PathBuf::from(path);
        if !dir.is_dir() {
            return Err("请拖入文件夹（不要拖单个文件）".into());
        }

        let mut files: Vec<PathBuf> = Vec::new();
        let rd = fs::read_dir(&dir).map_err(|e| format!("读取文件夹失败: {e}"))?;
        for entry in rd.flatten() {
            let p = entry.path();
            if p.is_file() && is_image(&p) {
                files.push(p);
            }
        }
        files.sort_by(|a, b| {
            let an = a.file_name().map(|s| s.to_string_lossy()).unwrap_or_default();
            let bn = b.file_name().map(|s| s.to_string_lossy()).unwrap_or_default();
            natural_cmp(&an, &bn)
        });
        if files.is_empty() {
            return Err("文件夹里没有图片（支持 jpg / png / webp / bmp）".into());
        }

        // Cancel any in-flight upscale from the previous folder.
        if let Some(mut c) = self.child.lock().unwrap().take() {
            let _ = c.kill();
            let _ = c.wait();
        }

        let hash = folder_hash(&dir);
        let cache_dir = project_cache_dir().join(&hash);
        fs::create_dir_all(&cache_dir).map_err(|e| e.to_string())?;

        // name -> (size, mtime) of images already upscaled in a previous session
        let known: std::collections::HashMap<String, (u64, u64)> = fs::read_to_string(
            cache_dir.join("manifest.json"),
        )
        .ok()
        .and_then(|s| serde_json::from_str::<HashMap<String, (u64, u64)>>(&s).ok())
        .unwrap_or_default();

        let mut entries = Vec::with_capacity(files.len());
        for (i, p) in files.iter().enumerate() {
            let name = p.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
            let (size, mtime) = file_meta(p);
            let (w, h) = imagesize::size(p)
                .map(|d| (d.width as u32, d.height as u32))
                .unwrap_or((800, 1200));
            let out = cache_dir.join(format!("{:05}.png", i));
            let hit = known
                .get(&name)
                .map(|(s, m)| *s == size && *m == mtime)
                .unwrap_or(false);
            let status = if hit && out.is_file() {
                St::Done(out.clone())
            } else {
                let _ = fs::remove_file(&out);
                St::Pending
            };
            entries.push(Entry { name, path: p.clone(), size, mtime, w, h, status });
        }

        let cached = entries.iter().filter(|e| matches!(e.status, St::Done(_))).count();
        let use_hr = self.cfg.lock().unwrap().upscale_enabled;
        let images: Vec<_> = entries
            .iter()
            .enumerate()
            .map(|(i, e)| image_info(i, e, use_hr))
            .collect();

        let (last_index, last_frac) = self
            .history
            .lock()
            .unwrap()
            .get(&hash)
            .map(|h| (h.index.min(entries.len() - 1), h.frac.clamp(0.0, 1.0)))
            .unwrap_or((0, 0.0));

        {
            let mut f = self.folder.lock().unwrap();
            let epoch = f.as_ref().map(|fd| fd.epoch + 1).unwrap_or(1);
            *f = Some(FolderData {
                path: dir.clone(),
                hash,
                cache_dir,
                entries,
                epoch,
            });
        }
        self.current.store(0, Ordering::SeqCst);
        self.kick();

        Ok(Manifest {
            folder: dir.to_string_lossy().to_string(),
            total: images.len(),
            cached,
            last_index,
            last_frac,
            images,
        })
    }

    pub fn get_image(&self, index: usize) -> Result<ImageInfo, String> {
        let use_hr = self.cfg.lock().unwrap().upscale_enabled;
        let f = self.folder.lock().unwrap();
        let fd = f.as_ref().ok_or("尚未打开文件夹")?;
        let e = fd.entries.get(index).ok_or("索引越界")?;
        Ok(image_info(index, e, use_hr))
    }

    /// Fresh ImageInfo list honoring the current upscale mode; called by the
    /// frontend right after toggling the mode so visible pages swap src.
    pub fn refresh_sources(&self) -> Result<Vec<ImageInfo>, String> {
        let use_hr = self.cfg.lock().unwrap().upscale_enabled;
        let f = self.folder.lock().unwrap();
        let fd = f.as_ref().ok_or("尚未打开文件夹")?;
        Ok(fd.entries
            .iter()
            .enumerate()
            .map(|(i, e)| image_info(i, e, use_hr))
            .collect())
    }

    pub fn stats(&self) -> Stats {
        let cfg = self.cfg.lock().unwrap().clone();
        let f = self.folder.lock().unwrap();
        let mut total = 0;
        let mut done = 0;
        let mut running = false;
        if let Some(fd) = f.as_ref() {
            total = fd.entries.len();
            for e in &fd.entries {
                match e.status {
                    St::Done(_) => done += 1,
                    St::Running => running = true,
                    _ => {}
                }
            }
        }
        Stats {
            total,
            done,
            running,
            enabled: cfg.upscale_enabled,
            configured: cfg.resolve_exe().is_some(),
        }
    }
}

pub fn image_info(index: usize, e: &Entry, use_hr: bool) -> ImageInfo {
    let upscaled = use_hr && matches!(e.status, St::Done(_));
    let src = match (&e.status, upscaled) {
        (St::Done(out), true) => out.to_string_lossy().to_string(),
        _ => e.path.to_string_lossy().to_string(),
    };
    ImageInfo {
        index,
        name: e.name.clone(),
        w: e.w,
        h: e.h,
        status: e.status.as_str().to_string(),
        src,
        upscaled,
        error: match &e.status {
            St::Failed(msg) => Some(msg.clone()),
            _ => None,
        },
    }
}

/// Persist which (name, size, mtime) have finished upscales so cache survives restarts.
pub fn write_manifest(fd: &FolderData) {
    let map: HashMap<String, (u64, u64)> = fd
        .entries
        .iter()
        .filter(|e| matches!(e.status, St::Done(_)))
        .map(|e| (e.name.clone(), (e.size, e.mtime)))
        .collect();
    if let Ok(json) = serde_json::to_string(&map) {
        let _ = fs::write(fd.cache_dir.join("manifest.json"), json);
    }
}

fn data_dir(app: &AppHandle) -> PathBuf {
    let dir = app.path().app_data_dir().unwrap_or_else(|_| PathBuf::from("."));
    let _ = fs::create_dir_all(&dir);
    dir
}

/// Upscale cache root: the project folder in dev, the exe folder in release.
fn project_cache_dir() -> PathBuf {
    #[cfg(debug_assertions)]
    {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let dir = root.parent().map(|p| p.join("cache")).unwrap_or(root.join("cache"));
        let _ = fs::create_dir_all(&dir);
        return dir;
    }
    #[cfg(not(debug_assertions))]
    {
        let dir = std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|d| d.join("cache")))
            .unwrap_or_else(|| PathBuf::from("cache"));
        let _ = fs::create_dir_all(&dir);
        dir
    }
}

fn config_path(app: &AppHandle) -> PathBuf {
    data_dir(app).join("config.json")
}

fn history_path(app: &AppHandle) -> PathBuf {
    data_dir(app).join("history.json")
}

fn folder_hash(dir: &Path) -> String {
    let mut hasher = DefaultHasher::new();
    dir.to_string_lossy().hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn load_config(app: &AppHandle) -> Option<Config> {
    serde_json::from_str(&fs::read_to_string(config_path(app)).ok()?).ok()
}

fn file_meta(p: &Path) -> (u64, u64) {
    fs::metadata(p)
        .map(|m| {
            let mtime = m
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            (m.len(), mtime)
        })
        .unwrap_or((0, 0))
}

fn is_image(p: &Path) -> bool {
    let ext = p
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default();
    matches!(ext.as_str(), "jpg" | "jpeg" | "jfif" | "png" | "webp" | "bmp")
}
