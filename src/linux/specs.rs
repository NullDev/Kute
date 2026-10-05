use super::{power, sys};
use serde_json::{Value, json};

fn os_name() -> String {
    std::fs::read_to_string("/etc/os-release")
        .ok()
        .and_then(|text| {
            text.lines()
                .find_map(|line| line.strip_prefix("PRETTY_NAME=").map(|name| name.trim_matches('"').to_string()))
        })
        .unwrap_or_else(|| "Linux".to_string())
}

fn session_type() -> String {
    std::env::var("XDG_SESSION_TYPE").unwrap_or_default()
}

fn ram_mb() -> u64 {
    sys::proc_field("/proc/meminfo", "MemTotal")
        .and_then(|value| value.split_whitespace().next()?.parse::<u64>().ok())
        .map(|kb| kb / 1024)
        .unwrap_or(0)
}

// TODO: displays and gpus (drm sysfs or the gpu process' own info)
pub fn collect(_window: u64) -> Value {
    let (laptop, on_battery) = power::battery();
    let (user_flags, disabled_defaults) = crate::modules::flaglist::user_flag_names();
    json!({
        "platform": "linux",
        "osBuild": os_name(),
        "kernel": sys::read_trimmed("/proc/sys/kernel/osrelease"),
        "session": session_type(),
        "userFlags": user_flags,
        "disabledDefaults": disabled_defaults,
        "displays": [],
        "gpus": [],
        "renderAdapter": null,
        "hook": crate::app::hook_state(),
        "hybrid": null,
        "hybridSource": "unknown",
        "powerOverlay": null,
        "cpu": {
            "name": sys::proc_field("/proc/cpuinfo", "model name"),
            "threads": std::thread::available_parallelism().map(|n| n.get()).unwrap_or(0),
        },
        "ramMb": ram_mb(),
        "laptop": laptop,
        "onBattery": on_battery,
    })
}
