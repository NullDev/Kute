use std::{
    cell::RefCell,
    collections::{HashMap, VecDeque},
    sync::{Condvar, Mutex, Once},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use cef::{rc::*, *};
use serde_json::{Value, json};
use windows::Win32::System::{
    Performance::{QueryPerformanceCounter, QueryPerformanceFrequency},
    SystemInformation::GetLocalTime,
};

use crate::{app, bridge, debug_print, modules::devtools, utils, utils::config, window};

// testing builds only: what F9 saves next to the page's frames (frontend/modules/recorder.js)

const KEEP_MS: f64 = 60_000.0;
// the summary looks at the same window as the page
const SUMMARY_MS: f64 = 30_000.0;
// a gap counts against the traffic right before it: the menu and an empty room send about once a second, a match far more
const GAP_MS: f64 = 150.0;
const GAP_FACTOR: f64 = 4.0;
const GAP_CONTEXT: usize = 20;
const GAP_CONTEXT_MIN: usize = 5;
// the server sends a tick as a few messages at once
const TICK_MS: f64 = 5.0;
// only v8's gc scopes: they are emitted during collections only, so the ring costs next to nothing between them.
// "v8.gc" matches nothing, v8 files them under the disabled-by-default name (and devtools.timeline, every task).
// with only disabled-by-default names included chromium adds every default category (153 MB in 30 s), hence the "*" exclude
const GC_TRACE: &str = r#"{"transferMode":"ReportEvents","traceConfig":{"recordMode":"recordContinuously","traceBufferSizeInKb":32768,"includedCategories":["disabled-by-default-v8.gc"],"excludedCategories":["*"]}}"#;
const GC_LISTED: usize = 25;
const GC_MIN_MS: f64 = 2.0;

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
// raw Tracing.dataCollected params until Tracing.tracingComplete
static TRACE: Mutex<(Vec<Vec<u8>>, bool)> = Mutex::new((Vec::new(), false));
static TRACE_DONE: Condvar = Condvar::new();

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
            if method == "Tracing.dataCollected" || method == "Tracing.tracingComplete" {
                let mut trace = TRACE.lock().unwrap();
                if method == "Tracing.dataCollected" {
                    trace.0.push(params.to_vec());
                } else {
                    trace.1 = true;
                    TRACE_DONE.notify_all();
                }
                return;
            }
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
    start_gc_trace(browser);
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

fn start_gc_trace(browser: &Browser) {
    devtools::send(browser, "Tracing.start", serde_json::from_str(GC_TRACE).unwrap_or_default());
}

wrap_task! {
    struct RestartTraceTask {
        browser_id: i32,
    }

    impl Task {
        fn execute(&self) {
            if let Some(browser) = window::browser_by_id(self.browser_id) {
                start_gc_trace(&browser);
            }
        }
    }
}

// trace timestamps are chromium's TimeTicks, which on windows is the performance counter
fn ticks_to_epoch_ms() -> f64 {
    let (mut counter, mut frequency) = (0i64, 0i64);
    unsafe {
        QueryPerformanceCounter(&mut counter).ok();
        QueryPerformanceFrequency(&mut frequency).ok();
    }
    if frequency == 0 {
        return 0.0;
    }
    now_ms() - counter as f64 / frequency as f64 * 1000.0
}

struct GcPause {
    at: f64,
    ms: f64,
    name: String,
}

// start ms, duration ms, event name
type Span = (f64, f64, String);

/// Outermost gc pauses on the renderer main thread with the most gc time, the game's.
fn gc_pauses(chunks: &[Vec<u8>], offset: f64) -> Vec<GcPause> {
    let mut main_threads: Vec<(i64, i64)> = Vec::new();
    let mut spans: HashMap<(i64, i64), Vec<Span>> = HashMap::new();
    let mut open: HashMap<(i64, i64, String), f64> = HashMap::new();
    for chunk in chunks {
        let Ok(json) = serde_json::from_slice::<Value>(chunk) else { continue };
        let Some(events) = json["value"].as_array() else { continue };
        for event in events {
            let key = (event["pid"].as_i64().unwrap_or(0), event["tid"].as_i64().unwrap_or(0));
            let ts = event["ts"].as_f64().unwrap_or(0.0) / 1000.0;
            let name = event["name"].as_str().unwrap_or_default();
            let phase = event["ph"].as_str().unwrap_or_default();
            // chromium adds events of its own to any trace
            if phase != "M" && !event["cat"].as_str().is_some_and(|category| category.contains("v8.gc")) {
                continue;
            }
            match phase {
                "M" if name == "thread_name" && event["args"]["name"].as_str() == Some("CrRendererMain") => main_threads.push(key),
                "X" => spans
                    .entry(key)
                    .or_default()
                    .push((ts, event["dur"].as_f64().unwrap_or(0.0) / 1000.0, name.to_string())),
                "B" => {
                    open.insert((key.0, key.1, name.to_string()), ts);
                }
                "E" => {
                    if let Some(start) = open.remove(&(key.0, key.1, name.to_string())) {
                        spans.entry(key).or_default().push((start, ts - start, name.to_string()));
                    }
                }
                _ => {}
            }
        }
    }
    let total = |list: &Vec<Span>| list.iter().map(|span| span.1).sum::<f64>();
    let game = spans
        .iter()
        .filter(|(key, _)| main_threads.contains(key))
        .max_by(|a, b| total(a.1).total_cmp(&total(b.1)))
        .map(|(key, _)| *key);
    let Some(mut spans) = game.and_then(|key| spans.remove(&key)) else {
        return Vec::new();
    };
    spans.sort_by(|a, b| a.0.total_cmp(&b.0).then(b.1.total_cmp(&a.1)));
    let mut pauses: Vec<GcPause> = Vec::new();
    let mut covered_until = f64::MIN;
    for (start, ms, name) in spans {
        // nested scopes are parts of the pause that holds them
        if start < covered_until {
            continue;
        }
        covered_until = start + ms;
        pauses.push(GcPause { at: start + offset, ms, name });
    }
    pauses
}

fn gc_summary(pauses: &[GcPause], page: &Value, taken: f64, trace: &str) -> Vec<String> {
    let since = taken - SUMMARY_MS;
    let recent: Vec<&GcPause> = pauses.iter().filter(|pause| pause.at >= since).collect();
    let mut lines = vec![format!(
        "GC pauses on the game's main thread: {} in the last {} s, {:.0} ms in total",
        recent.len(),
        SUMMARY_MS / 1000.0,
        // an empty f64 sum is -0
        recent.iter().map(|pause| pause.ms).sum::<f64>() + 0.0
    )];
    if pauses.is_empty() {
        lines.push(format!("  (no gc pauses found, {trace})"));
        return lines;
    }
    let mut by_name: HashMap<&str, (usize, f64, f64)> = HashMap::new();
    for pause in &recent {
        let entry = by_name.entry(pause.name.as_str()).or_default();
        entry.0 += 1;
        entry.1 += pause.ms;
        entry.2 = entry.2.max(pause.ms);
    }
    let mut kinds: Vec<_> = by_name.into_iter().collect();
    kinds.sort_by(|a, b| b.1.1.total_cmp(&a.1.1));
    for (name, (count, total, worst)) in kinds {
        lines.push(format!("  {name}: {count}x, {total:.1} ms in total, worst {worst:.1} ms"));
    }

    // the page's hitches, same rule as recorder.js
    let intervals: Vec<f64> = page["frameIntervals"]
        .as_array()
        .map(|list| list.iter().filter_map(Value::as_f64).collect())
        .unwrap_or_default();
    let mut sorted = intervals.clone();
    sorted.sort_by(f64::total_cmp);
    let median = percentile(&sorted, 0.5);
    let limit = (median * 4.0).max(6.0);
    let mut end = page["timeOrigin"].as_f64().unwrap_or(0.0) + page["frameStart"].as_f64().unwrap_or(0.0);
    let mut hitches: Vec<(f64, f64, f64)> = Vec::new();
    for ms in intervals {
        end += ms;
        if ms > limit {
            let gc: f64 = recent
                .iter()
                .map(|pause| (pause.at + pause.ms).min(end) - pause.at.max(end - ms))
                .filter(|overlap| *overlap > 0.0)
                .sum();
            hitches.push((end, ms, gc));
        }
    }
    if !hitches.is_empty() {
        let with_gc = hitches.iter().filter(|(_, ms, gc)| *gc >= (ms - median) * 0.5).count();
        lines.push(format!("Hitches mostly filled by a GC pause: {with_gc} of {}, the worst:", hitches.len()));
        hitches.sort_by(|a, b| b.1.total_cmp(&a.1));
        hitches.truncate(GC_LISTED);
        hitches.sort_by(|a, b| a.0.total_cmp(&b.0));
        for (end, ms, gc) in hitches {
            let cause = if gc > 0.05 { format!("GC {gc:.1} ms of it") } else { "no GC".to_string() };
            lines.push(format!("  {:>7.2} s before F9: {ms:.1} ms frame, {cause}", (taken - end) / 1000.0));
        }
    }
    let big: Vec<&&GcPause> = recent.iter().filter(|pause| pause.ms >= GC_MIN_MS).collect();
    if !big.is_empty() {
        lines.push(format!("GC pauses of {GC_MIN_MS} ms and more:"));
        for pause in big.iter().take(GC_LISTED) {
            lines.push(format!("  {:>7.2} s before F9: {} {:.1} ms", (taken - pause.at) / 1000.0, pause.name, pause.ms));
        }
    }
    lines
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
        // (first message, count) per tick
        let mut ticks: Vec<(&SocketFrame, usize)> = Vec::new();
        for frame in &received {
            match ticks.last_mut() {
                Some((first, count)) if frame.mono - first.mono < TICK_MS => *count += 1,
                _ => ticks.push((frame, 1)),
            }
        }
        let gaps: Vec<f64> = ticks.windows(2).map(|pair| pair[1].0.mono - pair[0].0.mono).collect();
        let mut sorted = gaps.clone();
        sorted.sort_by(f64::total_cmp);
        lines.push(format!(
            "  gap between server ticks ({} ticks): median {:.1} ms, p99 {:.1} ms, max {:.1} ms",
            ticks.len(),
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
            let after = ticks[index + 1].0;
            // late data arrives in a burst, a quiet server does not
            let burst: usize = ticks[index + 1..]
                .iter()
                .take_while(|(first, _)| first.mono - after.mono < 30.0)
                .map(|(_, count)| count)
                .sum();
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
pub fn capture(browser: &Browser, page: String) {
    let browser_id = browser.identifier();
    *TRACE.lock().unwrap() = (Vec::new(), false);
    devtools::send(browser, "Tracing.end", json!({}));
    std::thread::spawn(move || {
        let taken = now_ms();
        let offset = ticks_to_epoch_ms();
        let (chunks, complete) = {
            let trace = TRACE.lock().unwrap();
            let (mut trace, _) = TRACE_DONE.wait_timeout_while(trace, Duration::from_secs(5), |trace| !trace.1).unwrap();
            (std::mem::take(&mut trace.0), trace.1)
        };
        let mut restart = RestartTraceTask::new(browser_id);
        post_task(ThreadId::UI, Some(&mut restart));
        let pauses = gc_pauses(&chunks, offset);
        let trace = format!(
            "trace: {} chunks, {} bytes, {}",
            chunks.len(),
            chunks.iter().map(Vec::len).sum::<usize>(),
            if complete { "complete" } else { "never completed" }
        );
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
        summary.extend(gc_summary(&pauses, &page, taken, &trace));
        summary.push(String::new());
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
            "gc": pauses.iter().filter(|pause| pause.at >= since).map(|pause| json!([pause.at, pause.ms, pause.name])).collect::<Vec<_>>(),
            "gcFormat": ["epoch ms", "ms", "event"],
            "gcTrace": trace,
            "clockOffset": { "qpc": offset, "socket": recent_frames.iter().map(|frame| frame.at - frame.mono).fold(f64::NAN, f64::min) },
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
