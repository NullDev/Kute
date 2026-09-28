use std::{
    cell::RefCell,
    collections::VecDeque,
    sync::{Mutex, Once},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use cef::{rc::*, *};
use serde_json::{Value, json};
use windows::Win32::System::SystemInformation::GetLocalTime;

use crate::{app, bridge, debug_print, modules::devtools, utils, utils::config};

// testing builds only: what F9 saves next to the page's frames (frontend/modules/recorder.js)

const KEEP_MS: f64 = 60_000.0;
// the summary looks at the same window as the page
const SUMMARY_MS: f64 = 30_000.0;
// a gap counts against the traffic right before it: the menu and an empty room send about once a second, a match far more
const GAP_MS: f64 = 150.0;
const GAP_FACTOR: f64 = 4.0;
const GAP_CONTEXT: usize = 20;
const GAP_CONTEXT_MIN: usize = 5;

struct SocketFrame {
    // epoch ms when the browser process got the event, lines up with the page's clock
    at: f64,
    // devtools timestamp in ms, exact spacing between frames
    mono: f64,
    sent: bool,
    bytes: usize,
}

struct PresentSecond {
    at: f64,
    fps: u64,
    p50: f64,
    p99: f64,
    max: f64,
    samples: u64,
}

static FRAMES: Mutex<VecDeque<SocketFrame>> = Mutex::new(VecDeque::new());
static MARKS: Mutex<VecDeque<(f64, String)>> = Mutex::new(VecDeque::new());
static PRESENTS: Mutex<VecDeque<PresentSecond>> = Mutex::new(VecDeque::new());
// devtools request id of the game's lobby socket
static LOBBY_SOCKET: Mutex<Option<String>> = Mutex::new(None);
static SAMPLER: Once = Once::new();

thread_local! {
    static REGISTRATIONS: RefCell<Vec<Registration>> = const { RefCell::new(Vec::new()) };
}

fn now_ms() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs_f64() * 1000.0).unwrap_or(0.0)
}

fn keep_recent<T>(ring: &mut VecDeque<T>, at: impl Fn(&T) -> f64) {
    let now = now_ms();
    while ring.front().is_some_and(|entry| now - at(entry) > KEEP_MS) {
        ring.pop_front();
    }
}

fn mark(text: String) {
    let mut marks = MARKS.lock().unwrap();
    marks.push_back((now_ms(), text));
    keep_recent(&mut marks, |(at, _)| *at);
}

wrap_dev_tools_message_observer! {
    struct TrafficObserver;

    impl DevToolsMessageObserver {
        fn on_dev_tools_event(&self, _browser: Option<&mut Browser>, method: Option<&CefString>, params: Option<&[u8]>) {
            let (Some(method), Some(params)) = (method, params) else { return };
            let method = method.to_string();
            let Some(kind) = method.strip_prefix("Network.webSocket") else { return };
            let at = now_ms();
            let Ok(json) = serde_json::from_slice::<Value>(params) else { return };
            let id = json["requestId"].as_str().unwrap_or_default();
            let mut lobby = LOBBY_SOCKET.lock().unwrap();
            match kind {
                "Created" => {
                    let url = json["url"].as_str().unwrap_or_default();
                    if url.contains("lobby-") {
                        *lobby = Some(id.to_string());
                        let host = url.split("://").nth(1).and_then(|rest| rest.split('/').next()).unwrap_or(url);
                        mark(format!("lobby socket opened ({host})"));
                    }
                }
                "Closed" if lobby.as_deref() == Some(id) => mark("lobby socket closed".to_string()),
                "FrameError" if lobby.as_deref() == Some(id) => mark(format!("lobby socket error: {}", json["errorMessage"].as_str().unwrap_or("?"))),
                "FrameReceived" | "FrameSent" if lobby.as_deref() == Some(id) => {
                    let payload = json["response"]["payloadData"].as_str().map_or(0, str::len);
                    // binary frames come base64 encoded
                    let bytes = if json["response"]["opcode"].as_i64() == Some(2) { payload * 3 / 4 } else { payload };
                    let mono = json["timestamp"].as_f64().unwrap_or(0.0) * 1000.0;
                    let mut frames = FRAMES.lock().unwrap();
                    frames.push_back(SocketFrame { at, mono, sent: kind == "FrameSent", bytes });
                    keep_recent(&mut frames, |frame| frame.at);
                }
                _ => {}
            }
        }
    }
}

/// Starts watching the main browser's lobby socket, and once per process the per second present sampler.
pub fn load(browser: &Browser) {
    devtools::enable_network(browser);
    if let Some(host) = browser.host() {
        let mut observer = TrafficObserver::new();
        if let Some(registration) = host.add_dev_tools_message_observer(Some(&mut observer)) {
            REGISTRATIONS.with_borrow_mut(|registrations| registrations.push(registration));
        }
    }
    // takes the hook's intervals every second, auto-detect's own present readings are off while this runs
    SAMPLER.call_once(|| {
        std::thread::spawn(|| {
            loop {
                std::thread::sleep(Duration::from_secs(1));
                if !config("hardFlip", true) {
                    continue;
                }
                let Some((p50, p99, max, _, samples)) = app::take_present_intervals() else {
                    continue;
                };
                let fps = app::render_stats().map_or(0, |(fps, _)| fps);
                let mut presents = PRESENTS.lock().unwrap();
                presents.push_back(PresentSecond {
                    at: now_ms(),
                    fps,
                    p50: p50 as f64 / 1e6,
                    p99: p99 as f64 / 1e6,
                    max: max as f64 / 1e6,
                    samples,
                });
                keep_recent(&mut presents, |second| second.at);
            }
        });
    });
}

fn folder_name() -> String {
    let t = unsafe { GetLocalTime() };
    format!("{:04}-{:02}-{:02}_{:02}-{:02}-{:02}", t.wYear, t.wMonth, t.wDay, t.wHour, t.wMinute, t.wSecond)
}

fn percentile(sorted: &[f64], share: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    sorted[((sorted.len() - 1) as f64 * share).round() as usize]
}

fn socket_summary(frames: &[&SocketFrame], marks: &[(f64, String)], taken: f64) -> Vec<String> {
    let received: Vec<&&SocketFrame> = frames.iter().filter(|frame| !frame.sent).collect();
    let sent = frames.len() - received.len();
    let mut lines = vec![format!(
        "Server messages: {} received, {} sent in the last {} s",
        received.len(),
        sent,
        SUMMARY_MS / 1000.0
    )];
    if received.len() < 2 {
        lines.push("  (no lobby traffic recorded, was a match running?)".to_string());
    } else {
        let gaps: Vec<f64> = received.windows(2).map(|pair| pair[1].mono - pair[0].mono).collect();
        let mut sorted = gaps.clone();
        sorted.sort_by(f64::total_cmp);
        lines.push(format!(
            "  gap between server messages: median {:.1} ms, p99 {:.1} ms, max {:.1} ms",
            percentile(&sorted, 0.5),
            percentile(&sorted, 0.99),
            percentile(&sorted, 1.0)
        ));
        let mut listed = 0;
        for (index, gap) in gaps.iter().enumerate() {
            let mut before: Vec<f64> = gaps[index.saturating_sub(GAP_CONTEXT)..index].to_vec();
            before.sort_by(f64::total_cmp);
            if before.len() < GAP_CONTEXT_MIN {
                continue;
            }
            let usual = percentile(&before, 0.5);
            if *gap < GAP_MS.max(usual * GAP_FACTOR) {
                continue;
            }
            let after = received[index + 1];
            // late data arrives in a burst, a quiet server does not
            let burst = received[index + 1..].iter().take_while(|frame| frame.mono - after.mono < 30.0).count();
            lines.push(format!(
                "  {:>7.2} s before F9: nothing for {:.0} ms (usually {:.0} ms), then {} messages within 30 ms",
                (taken - after.at) / 1000.0,
                gap,
                usual,
                burst
            ));
            listed += 1;
            if listed == 20 {
                lines.push("  (more gaps in capture.json)".to_string());
                break;
            }
        }
        if listed == 0 {
            lines.push("  no gaps that stand out".to_string());
        }
    }
    for (at, text) in marks {
        lines.push(format!("  {:>7.2} s before F9: {text}", (taken - at) / 1000.0));
    }
    lines
}

fn present_summary(presents: &[&PresentSecond], taken: f64) -> Vec<String> {
    if presents.is_empty() {
        return vec!["Presents: no data (swap chain hook off?)".to_string()];
    }
    let mut lines = vec!["Presents per second (hook), only seconds with a hitch:".to_string()];
    let before = lines.len();
    for second in presents {
        if second.max > (second.p50 * 4.0).max(8.0) {
            lines.push(format!(
                "  {:>7.2} s before F9: {} fps, median {:.2} ms, p99 {:.2} ms, worst {:.2} ms",
                (taken - second.at) / 1000.0,
                second.fps,
                second.p50,
                second.p99,
                second.max
            ));
        }
    }
    if lines.len() == before {
        lines.push("  none".to_string());
    }
    lines
}

/// Writes the capture for F9. `page` is the page's JSON: frames, long frames, events and its own summary lines.
pub fn capture(browser_id: i32, page: String) {
    std::thread::spawn(move || {
        let taken = now_ms();
        let page: Value = serde_json::from_str(&page).unwrap_or(Value::Null);
        let since = taken - SUMMARY_MS;

        let frames = FRAMES.lock().unwrap();
        let marks = MARKS.lock().unwrap();
        let presents = PRESENTS.lock().unwrap();
        let recent_frames: Vec<&SocketFrame> = frames.iter().filter(|frame| frame.at >= since).collect();
        let recent_marks: Vec<(f64, String)> = marks.iter().filter(|(at, _)| *at >= since).cloned().collect();
        let recent_presents: Vec<&PresentSecond> = presents.iter().filter(|second| second.at >= since).collect();

        let mut summary = vec![format!("Kute {} capture, F9 at {}", env!("CARGO_PKG_VERSION"), folder_name()), String::new()];
        if let Some(lines) = page["summary"].as_array() {
            summary.extend(lines.iter().filter_map(|line| line.as_str().map(str::to_string)));
            summary.push(String::new());
        }
        summary.extend(present_summary(&recent_presents, taken));
        summary.push(String::new());
        summary.extend(socket_summary(&recent_frames, &recent_marks, taken));

        let capture = json!({
            "version": env!("CARGO_PKG_VERSION"),
            "takenAt": taken,
            "settings": &*crate::CONFIG.lock().unwrap(),
            "page": page,
            "socket": recent_frames.iter().map(|frame| json!([frame.at, frame.mono, frame.sent, frame.bytes])).collect::<Vec<_>>(),
            "socketFormat": ["epoch ms", "devtools ms", "sent", "bytes"],
            "socketMarks": recent_marks,
            "presents": recent_presents.iter().map(|second| json!({
                "at": second.at, "fps": second.fps, "p50": second.p50, "p99": second.p99, "max": second.max, "samples": second.samples,
            })).collect::<Vec<_>>(),
        });
        drop((frames, marks, presents));

        let dir = utils::settings_dir().join("captures").join(folder_name());
        let written = std::fs::create_dir_all(&dir)
            .and_then(|_| std::fs::write(dir.join("capture.json"), capture.to_string()))
            .and_then(|_| std::fs::write(dir.join("summary.txt"), summary.join("\r\n") + "\r\n"));
        let reply = match written {
            Ok(()) => json!({ "captureSaved": dir.display().to_string() }),
            Err(error) => {
                debug_print!("recorder: writing the capture failed: {error}");
                json!({ "captureFailed": error.to_string() })
            }
        };
        bridge::post_json_later(browser_id, reply.to_string());
    });
}
