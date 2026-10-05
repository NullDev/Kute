use super::sys;
use std::fs;

pub fn overlay_name() -> Option<String> {
    None
}

// (laptop, on battery) from /sys/class/power_supply
pub fn battery() -> (bool, bool) {
    let Ok(entries) = fs::read_dir("/sys/class/power_supply") else {
        return (false, false);
    };
    let mut laptop = false;
    let mut on_ac = false;
    let mut has_ac = false;
    for entry in entries.flatten() {
        let path = entry.path();
        match sys::read_trimmed(path.join("type")).as_deref() {
            Some("Battery") if sys::read_trimmed(path.join("scope")).as_deref() != Some("Device") => laptop = true,
            Some("Mains") => {
                has_ac = true;
                on_ac |= sys::read_trimmed(path.join("online")).as_deref() == Some("1");
            }
            _ => {}
        }
    }
    (laptop, laptop && has_ac && !on_ac)
}

// TODO: power-profiles-daemon "performance" while kute runs, like the windows overlay
pub fn boost() {}

pub fn put_back() -> bool {
    false
}

pub fn restore() {}
