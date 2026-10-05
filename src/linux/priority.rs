use super::sys;
use crate::utils::config;

// raising priority needs CAP_SYS_NICE, so High and Above Normal only work for a user allowed to renice
fn nice_of(level: &str) -> i32 {
    match level {
        "High" => -10,
        "Above Normal" => -5,
        "Below Normal" => 5,
        "Low" | "Idle" => 19,
        _ => 0,
    }
}

fn renice(tid: i32, nice: i32) {
    unsafe {
        libc::setpriority(libc::PRIO_PROCESS, tid as libc::id_t, nice);
    }
}

pub fn high_qos_self() {}

pub fn prefer_cache_cores() {}

// before the subprocess spawns threads, they inherit it
pub fn apply_to_self() {
    let level = config("webviewPriority", "Normal".to_string());
    if level != "Normal" {
        renice(0, nice_of(&level));
    }
}

pub fn set(level: impl AsRef<str>) {
    let nice = nice_of(level.as_ref());
    let own = std::process::id() as i32;
    for pid in std::iter::once(own).chain(sys::child_pids()) {
        for tid in sys::thread_ids(pid) {
            renice(tid, nice);
        }
    }
}
