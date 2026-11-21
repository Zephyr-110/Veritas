use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde_json::Value;

use super::util::repo_root;

fn probe(bin: &Path, launcher_args: &[&str]) -> bool {
    let mut cmd = Command::new(bin);
    cmd.args(launcher_args);
    cmd.args(["-c", "print(1)"]);
    cmd.stdout(Stdio::null());
    cmd.stderr(Stdio::null());
    cmd.status().map(|s| s.success()).unwrap_or(false)
}

fn push_unique(cands: &mut Vec<PathBuf>, p: PathBuf) {
    if p.as_os_str().is_empty() {
        return;
    }
    if !cands.iter().any(|x| x == &p) {
        cands.push(p);
    }
}

fn from_where(names: &[&str]) -> Vec<PathBuf> {
    let finder = if cfg!(windows) { "where.exe" } else { "which" };
    let mut out = Vec::new();
    for name in names {
        if let Ok(o) = Command::new(finder).arg(name).output() {
            if !o.status.success() {
                continue;
            }
            for line in String::from_utf8_lossy(&o.stdout).lines() {
                let t = line.trim();
                if t.is_empty() {
                    continue;
                }
                let lower = t.to_ascii_lowercase();
                if lower.contains("not found") || lower.contains("info:") {
                    continue;
                }
                out.push(PathBuf::from(t));
            }
        }
    }
    out
}

pub fn find_python() -> PathBuf {
    find_python_opt().unwrap_or_else(|| {
        panic!(
            "no python interpreter found; needed for oracle/pm_amm_math.py. Set PYTHON to a working interpreter."
        )
    })
}

pub fn find_python_opt() -> Option<PathBuf> {
    let mut cands: Vec<PathBuf> = Vec::new();
    if let Ok(p) = std::env::var("PYTHON") {
        push_unique(&mut cands, PathBuf::from(p));
    }
    for key in ["VIRTUAL_ENV", "CONDA_PREFIX", "PYTHONHOME"] {
        if let Ok(root) = std::env::var(key) {
            let root = PathBuf::from(root);
            push_unique(&mut cands, root.join("Scripts/python.exe"));
            push_unique(&mut cands, root.join("python.exe"));
            push_unique(&mut cands, root.join("bin/python3"));
            push_unique(&mut cands, root.join("bin/python"));
        }
    }
    for found in from_where(&[
        "python",
        "python3",
        "py",
        "python.exe",
        "python3.exe",
        "py.exe",
    ]) {
        push_unique(&mut cands, found);
    }
    if let Ok(path) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path) {
            for name in [
                "python.exe",
                "python3.exe",
                "py.exe",
                "python",
                "python3",
                "py",
            ] {
                push_unique(&mut cands, dir.join(name));
            }
        }
    }
    if cfg!(windows) {
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            let base = PathBuf::from(local);
            let mut dirs = Vec::new();
            for sub in ["Python", "Programs/Python"] {
                if let Ok(entries) = std::fs::read_dir(base.join(sub)) {
                    for entry in entries.flatten() {
                        let p = entry.path();
                        if p.is_dir() {
                            dirs.push(p);
                        }
                    }
                }
            }
            dirs.sort();
            dirs.reverse();
            for dir in dirs {
                push_unique(&mut cands, dir.join("python.exe"));
            }
        }
    }
    for p in ["/usr/bin/python3", "/usr/local/bin/python3"] {
        push_unique(&mut cands, PathBuf::from(p));
    }
    push_unique(&mut cands, PathBuf::from("python"));
    push_unique(&mut cands, PathBuf::from("python3"));
    push_unique(&mut cands, PathBuf::from("py"));
    push_unique(&mut cands, PathBuf::from("py.exe"));

    for c in &cands {
        let name = c
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        let is_py = name == "py" || name == "py.exe";
        if is_py {
            if probe(c, &["-3"]) {
                return Some(c.clone());
            }
            continue;
        }
        if probe(c, &[]) {
            return Some(c.clone());
        }
    }
    None
}

pub fn python_sim(req: &Value) -> Value {
    let py = find_python();
    let script = repo_root().join("oracle/protocol_sim.py");
    let mut cmd = Command::new(&py);
    let name = py
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if name == "py" || name == "py.exe" {
        cmd.arg("-3");
    }
    eprintln!("oracle python={py:?} script={}", script.display());
    let mut child = cmd
        .arg(&script)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap_or_else(|e| panic!("spawn python {py:?}: {e}"));
    child
        .stdin
        .take()
        .unwrap()
        .write_all(req.to_string().as_bytes())
        .unwrap();
    let out = child.wait_with_output().unwrap();
    if !out.status.success() {
        panic!(
            "python sim failed: {}\n{}",
            String::from_utf8_lossy(&out.stderr),
            String::from_utf8_lossy(&out.stdout)
        );
    }
    serde_json::from_slice(&out.stdout)
        .unwrap_or_else(|e| panic!("python json: {e}\n{}", String::from_utf8_lossy(&out.stdout)))
}

pub fn f64_of(v: &Value) -> f64 {
    v.as_f64()
        .or_else(|| v.as_i64().map(|x| x as f64))
        .or_else(|| v.as_u64().map(|x| x as f64))
        .unwrap_or(0.0)
}
