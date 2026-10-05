use crate::bridge;

// TODO: auto-detect's input script through uinput or xtest. answers like a run that sent nothing
pub fn start(_window: u64, browser_id: i32, _ms: u64) {
    bridge::post_json_later(
        browser_id,
        serde_json::json!({ "inputReplay": { "sent": 0, "reason": "unsupported" } }).to_string(),
    );
}

pub fn stop() {}
