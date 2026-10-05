use std::sync::Mutex;

// (busy, total) jiffies of the last call
static LAST: Mutex<Option<(u64, u64)>> = Mutex::new(None);

fn cpu_jiffies() -> Option<(u64, u64)> {
    let stat = std::fs::read_to_string("/proc/stat").ok()?;
    let fields: Vec<u64> = stat.lines().next()?.split_whitespace().skip(1).filter_map(|v| v.parse().ok()).collect();
    let total: u64 = fields.iter().take(8).sum();
    // idle and iowait
    let idle = fields.get(3)? + fields.get(4).unwrap_or(&0);
    Some((total - idle, total))
}

// same shape as the windows sample, only what /proc has without root. null on the first call
pub fn sample() -> serde_json::Value {
    let now = cpu_jiffies();
    let previous = std::mem::replace(&mut *LAST.lock().unwrap(), now);
    let busy = match (previous, now) {
        (Some((busy_a, total_a)), Some((busy_b, total_b))) if total_b > total_a => {
            Some(((busy_b - busy_a) as f64 * 1000.0 / (total_b - total_a) as f64).round() / 10.0)
        }
        _ => return serde_json::Value::Null,
    };
    serde_json::json!({
        "cpuSpeed": null,
        "cpuBusy": busy,
        "cpuLimit": null,
        "thermalLimit": null,
        "temperature": null,
        "gpu": {},
        "nvidia": null,
    })
}
