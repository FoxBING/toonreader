use std::fs;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use tauri::Emitter;

use crate::state::{Config, FolderData, Reader, St};

pub fn spawn(reader: Arc<Reader>) {
    std::thread::spawn(move || loop {
        match next_job(&reader) {
            Some(job) => run_job(&reader, job),
            None => {
                let guard = reader.folder.lock().unwrap();
                let _ = reader.cv.wait_timeout(guard, Duration::from_secs(2));
            }
        }
    });
}

struct Job {
    epoch: u64,
    index: usize,
    input: std::path::PathBuf,
    output: std::path::PathBuf,
}

fn find_pending(fd: &FolderData, from: usize, to: usize) -> Option<usize> {
    let to = to.min(fd.entries.len());
    if from >= to {
        return None;
    }
    fd.entries[from..to]
        .iter()
        .enumerate()
        .find(|(_, e)| matches!(e.status, St::Pending))
        .map(|(i, _)| from + i)
}

/// Pick the highest-priority pending image: first inside the preload window
/// [current, current + preload), otherwise (optionally) the whole folder.
fn next_job(r: &Reader) -> Option<Job> {
    let cfg = r.cfg.lock().unwrap().clone();
    if !cfg.upscale_enabled {
        return None;
    }
    cfg.resolve_exe()?; // resolve once to validate config; run_job resolves again
    let mut guard = r.folder.lock().unwrap();
    let fd = guard.as_mut()?;
    let cur = r.current.load(Ordering::SeqCst);
    let end = cur.saturating_add(cfg.preload.max(1));
    let target = find_pending(fd, cur, end)
        .or_else(|| if cfg.upscale_all { find_pending(fd, 0, usize::MAX) } else { None })?;
    let e = &mut fd.entries[target];
    e.status = St::Running;
    let input = e.path.clone();
    let output = fd.cache_dir.join(format!("{:05}.png", target));
    Some(Job { epoch: fd.epoch, index: target, input, output })
}


fn run_job(r: &Reader, job: Job) {
    let cfg = r.cfg.lock().unwrap().clone();
    let result = cfg.resolve_exe().map_or(Err("找不到 waifu2x".into()), |exe| {
        run_waifu2x(r, &cfg, &exe, &job.input, &job.output)
    });

    let mut f = r.folder.lock().unwrap();
    match f.as_mut() {
        Some(fd) if fd.epoch == job.epoch => {
            let e = &mut fd.entries[job.index];
            match result {
                Ok(()) if job.output.is_file() => {
                    e.status = St::Done(job.output.clone());
                    crate::state::write_manifest(fd);
                    let _ = r.app.emit("upscaled", serde_json::json!({ "index": job.index, "ok": true }));
                }
                Err(msg) => {
                    let _ = fs::remove_file(&job.output);
                    e.status = St::Failed(msg.clone());
                    let _ = r.app.emit(
                        "upscaled",
                        serde_json::json!({ "index": job.index, "ok": false, "msg": msg }),
                    );
                }
                Ok(()) => {
                    // process reported success but no output file appeared
                    let _ = fs::remove_file(&job.output);
                    e.status = St::Failed("waifu2x 没有产出文件".into());
                    let _ = r.app.emit(
                        "upscaled",
                        serde_json::json!({ "index": job.index, "ok": false, "msg": "没有产出文件" }),
                    );
                }
            }
        }
        _ => {
            // Folder changed mid-job: discard the stale output.
            let _ = fs::remove_file(&job.output);
        }
    }
    drop(f);
    r.cv.notify_all();
}

fn run_waifu2x(
    r: &Reader,
    cfg: &Config,
    exe: &Path,
    input: &Path,
    output: &Path,
) -> Result<(), String> {
    let model_dir = cfg.resolve_model_dir(exe);
    let mut cmd = Command::new(exe);
    cmd.arg("-i").arg(input)
        .arg("-o").arg(output)
        .arg("-n").arg(cfg.noise.to_string())
        .arg("-s").arg(cfg.scale.to_string())
        .arg("-m").arg(&model_dir)
        .arg("-j").arg("1:1:1")
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    if cfg.gpu_id >= 0 {
        cmd.arg("-g").arg(cfg.gpu_id.to_string());
    }
    if cfg.tile > 0 {
        cmd.arg("-t").arg(cfg.tile.to_string());
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let child = cmd.spawn().map_err(|e| format!("启动 waifu2x 失败: {e}"))?;
    // Publish the child so open_folder can kill it, then take it back to wait.
    *r.child.lock().unwrap() = Some(child);
    let child = match r.child.lock().unwrap().take() {
        Some(c) => c,
        None => return Err("任务已取消".into()),
    };
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&out.stderr);
        Err(format!("waifu2x 退出码 {:?}: {}", out.status.code(), stderr.chars().take(300).collect::<String>()))
    }
}
