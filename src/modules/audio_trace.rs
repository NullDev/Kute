//! Test build only (cargo feature `audio-log`), the heavy half of the audio investigation: Chromium keeps a trace
//! of its own audio work in a ring buffer, and every F9 (plus the first automatic dropouts) writes the last
//! seconds of it next to the log in Downloads.
//!
//! It only asks for the audio categories, which produce a few events per audio buffer instead of the hundreds per
//! frame the performance recorder collects, so it does not cost the tester frames. What we read from it:
//! `AudioDestination::Render` says per buffer when the renderer started rendering and how long it took, which
//! separates "the audio thread was never scheduled in time" from "the audio graph was too slow".

use cef::{rc::*, *};
use std::{
    cell::{Cell, RefCell},
    fs,
    io::{BufWriter, Write},
    path::PathBuf,
    sync::{
        Mutex, OnceLock,
        atomic::{AtomicU32, Ordering},
        mpsc,
    },
    thread,
};
use windows::Win32::System::SystemInformation::GetLocalTime;

use crate::{
    debug_print,
    modules::{audio_log, devtools},
    utils,
};

// the events of the audio path only: the renderer's WebAudio rendering, the audio service and the media layer
const CATEGORIES: &[&str] = &["webaudio", "audio", "media"];
// the ring buffer. audio events are small, this holds minutes rather than the seconds the frame trace holds
const BUFFER_KB: u32 = 16 * 1024;
// how much of the cut the tester hears before pressing F9 is still in the ring, plus what gets recorded after it
const AFTER_KEY_MS: i64 = 4000;
// the page reports every dropout, but a cut that lasts 20 s reports one a second: two captures are plenty
const MAX_AUTOMATIC: u32 = 2;

#[derive(Clone, Copy, PartialEq)]
enum Phase {
    Off,
    Recording,
    Capturing,
}

enum Job {
    Begin(PathBuf),
    Chunk(Vec<u8>),
    Finish,
}

thread_local! {
    static PHASE: Cell<Phase> = const { Cell::new(Phase::Off) };
    static REGISTRATION: RefCell<Option<Registration>> = const { RefCell::new(None) };
}
static AUTOMATIC: AtomicU32 = AtomicU32::new(0);
static WRITER: OnceLock<mpsc::Sender<Job>> = OnceLock::new();
static CAPTURES: Mutex<Vec<String>> = Mutex::new(Vec::new());

// the events arrive on the UI thread, so they are written on a thread of their own
fn writer() -> &'static mpsc::Sender<Job> {
    WRITER.get_or_init(|| {
        let (sender, receiver) = mpsc::channel::<Job>();
        thread::spawn(move || {
            let mut path = PathBuf::new();
            let mut file: Option<BufWriter<fs::File>> = None;
            for job in receiver {
                match job {
                    Job::Begin(target) => {
                        path = target;
                        file = None;
                    }
                    Job::Chunk(events) => {
                        if file.is_none() {
                            match fs::File::create(&path) {
                                Ok(created) => {
                                    let mut created = BufWriter::with_capacity(1 << 20, created);
                                    let _ = created.write_all(b"{\"traceEvents\":[\n");
                                    file = Some(created);
                                }
                                Err(err) => debug_print!("audio trace: cannot write {}: {err}", path.display()),
                            }
                        } else if let Some(out) = file.as_mut() {
                            let _ = out.write_all(b",\n");
                        }
                        if let Some(out) = file.as_mut() {
                            let _ = out.write_all(&events);
                        }
                    }
                    Job::Finish => {
                        let written = file.take().is_some_and(|mut out| out.write_all(b"\n]}\n").and_then(|_| out.flush()).is_ok());
                        audio_log::line(&format!("audio trace {}: {}", if written { "written" } else { "empty" }, path.display()));
                    }
                }
            }
        });
        sender
    })
}

wrap_dev_tools_message_observer! {
    struct TraceObserver;

    impl DevToolsMessageObserver {
        fn on_dev_tools_event(&self, browser: Option<&mut Browser>, method: Option<&CefString>, params: Option<&[u8]>) {
            let (Some(method), Some(params)) = (method, params) else { return };
            match method.to_string().as_str() {
                // {"value":[{event},{event},...]}: the array's inside goes to the file as it is, no parsing
                "Tracing.dataCollected" => {
                    let start = params.iter().position(|&b| b == b'[');
                    let end = params.iter().rposition(|&b| b == b']');
                    if let (Some(start), Some(end)) = (start, end)
                        && end > start + 1
                    {
                        let _ = writer().send(Job::Chunk(params[start + 1..end].to_vec()));
                    }
                }
                "Tracing.tracingComplete" => {
                    let _ = writer().send(Job::Finish);
                    if let Some(browser) = browser {
                        start(browser);
                    }
                }
                _ => {}
            }
        }
    }
}

/// From `window::attach_browser` on the main browser.
pub fn load(browser: &Browser) {
    let Some(host) = browser.host() else { return };
    let mut observer = TraceObserver::new();
    if let Some(registration) = host.add_dev_tools_message_observer(Some(&mut observer)) {
        REGISTRATION.set(Some(registration));
    }
    start(browser);
    audio_log::line("audio trace: recording, every F9 saves the last seconds of the audio path");
}

fn start(browser: &Browser) {
    let params = serde_json::json!({
        "transferMode": "ReportEvents",
        "traceConfig": {
            "recordMode": "recordContinuously",
            "traceBufferSizeInKb": BUFFER_KB,
            "includedCategories": CATEGORIES,
        },
    });
    devtools::send(browser, "Tracing.start", params);
    PHASE.set(Phase::Recording);
}

wrap_task! {
    struct EndTask {
        browser_id: i32,
    }

    impl Task {
        fn execute(&self) {
            if let Some(browser) = crate::window::browser_by_id(self.browser_id) {
                devtools::send(&browser, "Tracing.end", serde_json::json!({}));
            }
        }
    }
}

/// F9, and the first dropouts the page reports on its own.
pub fn capture(browser: &Browser, reason: &str) {
    if PHASE.get() != Phase::Recording {
        return;
    }
    PHASE.set(Phase::Capturing);

    let now = unsafe { GetLocalTime() };
    let name = format!("kute-audio-trace-{:02}-{:02}-{:02}.json", now.wHour, now.wMinute, now.wSecond);
    audio_log::line(&format!("audio trace: saving {name} ({reason}), {} s of the cut follow", AFTER_KEY_MS / 1000));
    CAPTURES.lock().unwrap().push(name.clone());
    let _ = writer().send(Job::Begin(utils::downloads_dir().join(name)));

    let mut task = EndTask::new(browser.identifier());
    post_delayed_task(ThreadId::UI, Some(&mut task), AFTER_KEY_MS);
}

/// A dropout the page reported. The first ones capture themselves, so a tester who presses F9 late still gives us
/// the trace of a real cut.
pub fn capture_dropout(browser: &Browser) {
    if AUTOMATIC.fetch_add(1, Ordering::Relaxed) < MAX_AUTOMATIC {
        capture(browser, "the page reported a dropout");
    }
}
