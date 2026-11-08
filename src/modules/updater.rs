use crate::{
    constants, debug_print,
    utils::{self, create_utf_string},
};
use cef::{rc::*, *};
use std::{
    cell::{Cell, RefCell},
    env, fs,
    io::{self, Read, Write},
    os::windows::process::CommandExt,
    path::{Path, PathBuf},
    process,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU8, AtomicU64, Ordering},
    },
    time::Duration,
};
use windows::{
    Win32::Foundation::*,
    Win32::Security::Cryptography::{BCRYPT_HASH_HANDLE, BCRYPT_SHA256_ALG_HANDLE, BCryptCreateHash, BCryptDestroyHash, BCryptFinishHash, BCryptHashData},
    Win32::System::ApplicationInstallationAndServicing::{ACTCTXW, ActivateActCtx, CreateActCtxW},
    Win32::System::LibraryLoader::{GetModuleHandleW, GetProcAddress, LoadLibraryW},
    Win32::UI::Controls::*,
    Win32::UI::Shell::ShellExecuteW,
    Win32::UI::WindowsAndMessaging::*,
    core::*,
};

// RT_MANIFEST id in kute-manifest.rc. the process manifest has no comctl32 v6, task dialogs need it
const COMCTL6_MANIFEST: u16 = 100;
// winbase.h, the windows crate keeps them behind another feature
const ACTCTX_FLAG_RESOURCE_NAME_VALID: u32 = 0x8;
const ACTCTX_FLAG_HMODULE_VALID: u32 = 0x80;

const BTN_UPDATE: i32 = 100;
const BTN_PAGE: i32 = 101;
const BTN_RESTART: i32 = 102;

const RUNNING: u8 = 0;
const READY: u8 = 1;
const FAILED: u8 = 2;

// one range request per chunk: a connection that goes quiet shows up as a timed out chunk instead of a read that never
// returns, and the next request continues from the bytes already on disk. ureq counts the response timeout into the body
// read, so a chunk gets the whole budget for its headers and bytes
const CHUNK_BYTES: u64 = 4 * 1024 * 1024;
const CHUNK_TIMEOUT: Duration = Duration::from_secs(60);
// chunks in a row without a byte before the download gives up
const MAX_FAILURES: u32 = 8;
// a release read from the page gives no size, the download still has a ceiling
const MAX_INSTALLER_BYTES: u64 = 2 * 1024 * 1024 * 1024;

struct Pending {
    msi: PathBuf,
    relaunch: bool,
}

// a verified installer, run once the client has shut down
static PENDING: Mutex<Option<Pending>> = Mutex::new(None);

#[derive(Clone)]
struct Installer {
    url: String,
    // none when the release was read from its page
    size: Option<u64>,
    sha256: Option<String>,
}

struct Release {
    version: semver::Version,
    installer: Option<Installer>,
}

// what the check did, for the diagnostics report
struct Status {
    source: &'static str,
    api_status: Option<u16>,
    latest: Option<String>,
    outcome: &'static str,
    error: Option<String>,
}

static STATUS: Mutex<Status> = Mutex::new(Status {
    source: "",
    api_status: None,
    latest: None,
    outcome: "not checked",
    error: None,
});

fn note(update: impl FnOnce(&mut Status)) {
    update(&mut STATUS.lock().unwrap());
}

pub fn status_json() -> serde_json::Value {
    let status = STATUS.lock().unwrap();
    serde_json::json!({
        "source": status.source,
        "apiStatus": status.api_status,
        "latest": status.latest,
        "outcome": status.outcome,
        "error": status.error,
    })
}

pub fn run() {
    // first, the dialog below can stay open for the whole session
    check_minor_update();
    check_major_update();
}

// dev builds only. KUTE_UPDATE_BASE serves /api (the release json), /latest (302 to /releases/tag/<version>) and
// /download/<version>/<asset>, KUTE_UPDATE_API_URL alone puts a dead api in front of the real release page
fn test_var(name: &str) -> Option<String> {
    #[cfg(feature = "verbose-logs")]
    return env::var(name).ok().filter(|value| !value.is_empty());
    #[allow(unreachable_code)]
    {
        let _ = name;
        None
    }
}

fn test_base() -> Option<String> {
    test_var("KUTE_UPDATE_BASE")
}

fn testing() -> bool {
    test_base().is_some() || test_var("KUTE_UPDATE_API_URL").is_some()
}

fn api_url() -> String {
    test_var("KUTE_UPDATE_API_URL")
        .or_else(|| test_base().map(|base| format!("{base}/api")))
        .unwrap_or_else(|| constants::UPDATE_URL.to_string())
}

fn page_url() -> String {
    test_base().map_or_else(|| constants::RELEASE_PAGE_URL.to_string(), |base| format!("{base}/latest"))
}

fn download_prefix() -> String {
    test_base().map_or_else(|| constants::RELEASE_DOWNLOAD_PREFIX.to_string(), |base| format!("{base}/download/"))
}

fn agent(timeout: Option<Duration>) -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_connect(Some(Duration::from_secs(10)))
        .timeout_recv_response(Some(Duration::from_secs(20)))
        .timeout_global(timeout)
        .build()
        .into()
}

fn chunk_agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_connect(Some(Duration::from_secs(10)))
        .timeout_recv_response(Some(CHUNK_TIMEOUT))
        .timeout_recv_body(Some(CHUNK_TIMEOUT))
        .timeout_global(Some(CHUNK_TIMEOUT))
        .build()
        .into()
}

fn get_string(url: &str) -> Option<String> {
    let response = agent(Some(Duration::from_secs(30))).get(url).call().ok()?;
    let mut text = String::new();
    response.into_body().as_reader().read_to_string(&mut text).ok()?;
    Some(text)
}

fn check_minor_update() {
    let resources = utils::exe_dir().join("resources");
    let current = fs::read_to_string(resources.join("bundle_version")).unwrap_or_else(|_| String::from("0.0.0"));
    *crate::JS_VERSION.lock().unwrap() = current.clone();

    let Some(latest) = get_string(constants::JS_VERSION_URL) else {
        debug_print!("updater: bundle version not reachable");
        return;
    };
    let (Ok(parsed_current), Ok(parsed_latest)) = (semver::Version::parse(current.trim()), semver::Version::parse(latest.trim())) else {
        return;
    };
    if parsed_latest <= parsed_current {
        debug_print!("updater: bundle {} is current", current.trim());
        return;
    }
    let Some(bundle) = get_string(constants::JS_BUNDLE_URL) else { return };
    if utils::atomic_write(&resources.join("bundle.js"), &bundle).is_ok() && utils::atomic_write(&resources.join("bundle_version"), &latest).is_ok() {
        debug_print!("updater: bundle {} downloaded, was {}", latest.trim(), current.trim());
        *crate::JS_VERSION.lock().unwrap() = latest;
    }
}

// none: this build does not install itself (portable zip), the player gets the release page
fn installer_name() -> Option<&'static str> {
    (cfg!(all(windows, target_arch = "x86_64")) && !utils::is_portable()).then_some(constants::INSTALLER_ASSET)
}

fn api_release() -> Option<Release> {
    let url = api_url();
    let response = match agent(Some(Duration::from_secs(30))).get(&url).call() {
        Ok(response) => response,
        Err(error) => {
            debug_print!("updater: api {url}: {error}");
            let status = if let ureq::Error::StatusCode(code) = &error { Some(*code) } else { None };
            note(|status_record| {
                status_record.api_status = status;
                status_record.error = Some(error.to_string());
            });
            return None;
        }
    };
    note(|status| status.api_status = Some(response.status().as_u16()));
    let mut text = String::new();
    response.into_body().as_reader().read_to_string(&mut text).ok()?;
    let json = serde_json::from_str::<serde_json::Value>(&text).ok()?;
    let version = semver::Version::parse(json["tag_name"].as_str()?.trim()).ok()?;
    // by exact name, never by position: exes up to 0.1.17 take assets[0] and the api sorts by name
    let installer = installer_name().and_then(|name| {
        let asset = json["assets"].as_array()?.iter().find(|asset| asset["name"].as_str() == Some(name))?;
        let url = asset["browser_download_url"].as_str()?;
        if asset["state"].as_str() != Some("uploaded") || !(url.starts_with(&download_prefix()) || testing()) {
            return None;
        }
        Some(Installer {
            url: url.to_string(),
            size: Some(asset["size"].as_u64().filter(|size| *size > 0)?),
            sha256: asset["digest"]
                .as_str()
                .and_then(|digest| digest.strip_prefix("sha256:"))
                .map(str::to_ascii_lowercase),
        })
    });
    Some(Release { version, installer })
}

// "/releases/tag/1.3.0" at the end of the location header, with or without a v
fn tag_from_location(location: &str) -> Option<&str> {
    let (_, tag) = location.split_once("/releases/tag/")?;
    let tag = tag.split(['?', '#']).next()?.trim_end_matches('/');
    let tag = tag.strip_prefix('v').unwrap_or(tag);
    (!tag.is_empty()).then_some(tag)
}

// github.com/<repo>/releases/latest answers 302 to /releases/tag/<version>. the api allows 60 requests an hour per
// address, a shared network uses that up and the check looked like "no update" (krh found it). the redirect has no limit
fn page_release() -> Option<Release> {
    let url = page_url();
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_connect(Some(Duration::from_secs(10)))
        .timeout_global(Some(Duration::from_secs(30)))
        .max_redirects(0)
        .build()
        .into();
    let response = match agent.get(&url).call() {
        Ok(response) => response,
        Err(error) => {
            debug_print!("updater: release page {url}: {error}");
            note(|status| status.error = Some(error.to_string()));
            return None;
        }
    };
    let location = response.headers().get("location").and_then(|value| value.to_str().ok()).unwrap_or_default();
    let Some(version) = tag_from_location(location).and_then(|tag| semver::Version::parse(tag).ok()) else {
        debug_print!("updater: release page answered {} without a tag ({location})", response.status());
        note(|status| status.error = Some(format!("release page answered {} without a tag", response.status())));
        return None;
    };
    // the asset keeps its name on every release, so the url needs nothing from the api
    let installer = installer_name().map(|name| Installer {
        url: format!("{}{version}/{name}", download_prefix()),
        size: None,
        sha256: None,
    });
    Some(Release { version, installer })
}

fn latest_release() -> Option<Release> {
    if let Some(release) = api_release() {
        debug_print!("updater: api says {}", release.version);
        note(|status| {
            status.source = "api";
            status.latest = Some(release.version.to_string());
        });
        return Some(release);
    }
    let release = page_release();
    if let Some(release) = &release {
        debug_print!("updater: release page says {}", release.version);
    }
    note(|status| {
        status.source = if release.is_some() { "page" } else { "none" };
        status.latest = release.as_ref().map(|release| release.version.to_string());
    });
    release
}

fn check_major_update() {
    let Some(release) = latest_release() else {
        note(|status| status.outcome = "unreachable");
        return;
    };
    let Ok(current) = semver::Version::parse(env!("CARGO_PKG_VERSION")) else {
        return;
    };
    if release.version <= current {
        note(|status| status.outcome = "up to date");
        return;
    }
    note(|status| status.outcome = "offered");
    Dialog::show(release, current);
}

struct Sha256(BCRYPT_HASH_HANDLE);

impl Sha256 {
    fn new() -> Option<Self> {
        let mut handle = BCRYPT_HASH_HANDLE::default();
        unsafe { BCryptCreateHash(BCRYPT_SHA256_ALG_HANDLE, &mut handle, None, None, 0) }
            .is_ok()
            .then_some(Self(handle))
    }

    fn update(&mut self, data: &[u8]) -> bool {
        unsafe { BCryptHashData(self.0, data, 0) }.is_ok()
    }

    fn hex(self) -> Option<String> {
        let mut digest = [0u8; 32];
        unsafe { BCryptFinishHash(self.0, &mut digest, 0) }.ok().ok()?;
        Some(digest.iter().map(|byte| format!("{byte:02x}")).collect())
    }
}

impl Drop for Sha256 {
    fn drop(&mut self) {
        unsafe {
            BCryptDestroyHash(self.0).ok().ok();
        }
    }
}

struct Progress {
    done: AtomicU64,
    // 0 until known
    total: AtomicU64,
    state: AtomicU8,
    cancel: AtomicBool,
    error: Mutex<String>,
}

// "bytes 0-8388607/170590208", the total may be "*"
fn content_range(header: &str) -> Option<(u64, u64, Option<u64>)> {
    let range = header.trim().strip_prefix("bytes ")?;
    let (span, total) = range.split_once('/')?;
    let (start, end) = span.split_once('-')?;
    Some((start.trim().parse().ok()?, end.trim().parse().ok()?, total.trim().parse().ok()))
}

enum Fail {
    // the next request continues from the bytes on disk
    Retry(String),
    Final(String),
}

struct Transfer<'a> {
    file: fs::File,
    hash: Sha256,
    done: u64,
    total: Option<u64>,
    progress: &'a Progress,
}

impl Transfer<'_> {
    fn write(&mut self, bytes: &[u8]) -> std::result::Result<(), Fail> {
        self.file
            .write_all(bytes)
            .map_err(|e| Fail::Final(format!("Could not write the installer ({e}).")))?;
        if !self.hash.update(bytes) {
            return Err(Fail::Final("Could not check the download.".to_string()));
        }
        self.done += bytes.len() as u64;
        if self.done > self.total.unwrap_or(MAX_INSTALLER_BYTES) {
            return Err(Fail::Final("The download is larger than the release says.".to_string()));
        }
        self.progress.done.store(self.done, Ordering::Relaxed);
        Ok(())
    }

    fn learn_total(&mut self, total: u64) -> std::result::Result<(), Fail> {
        if self.total.is_some_and(|known| known != total) {
            return Err(Fail::Final("The download does not match the release.".to_string()));
        }
        self.total = Some(total);
        self.progress.total.store(total, Ordering::Relaxed);
        Ok(())
    }

    fn chunk(&mut self, url: &str) -> std::result::Result<(), Fail> {
        let end = self.total.map_or(self.done + CHUNK_BYTES - 1, |total| (self.done + CHUNK_BYTES - 1).min(total - 1));
        let response = match chunk_agent().get(url).header("Range", &format!("bytes={}-{end}", self.done)).call() {
            Ok(response) => response,
            // a range at the end of the file: without a size from the release this is where it ends
            Err(ureq::Error::StatusCode(416)) if self.done > 0 && self.total.is_none() => return self.learn_total(self.done),
            Err(ureq::Error::StatusCode(code)) if code >= 500 => return Err(Fail::Retry(format!("The server answered {code}."))),
            Err(ureq::Error::StatusCode(code)) => return Err(Fail::Final(format!("The download was refused ({code})."))),
            Err(error) => return Err(Fail::Retry(format!("The download broke off ({error})."))),
        };
        let status = response.status().as_u16();
        let header = |name: &str| response.headers().get(name).and_then(|value| value.to_str().ok()).map(str::to_string);
        match status {
            206 => {
                let (start, _, total) = header("content-range")
                    .as_deref()
                    .and_then(content_range)
                    .ok_or_else(|| Fail::Final("The download came back in an unexpected form.".to_string()))?;
                if start != self.done {
                    return Err(Fail::Final("The server did not continue where the download stopped.".to_string()));
                }
                if let Some(total) = total {
                    self.learn_total(total)?;
                }
            }
            // the range was ignored: from the start that is the whole file in one go, later it cannot continue
            200 if self.done == 0 => {
                if let Some(length) = header("content-length").and_then(|value| value.parse().ok()) {
                    self.learn_total(length)?;
                }
            }
            200 => return Err(Fail::Final("The server does not support resuming the download.".to_string())),
            _ => return Err(Fail::Final(format!("The download was refused ({status})."))),
        }
        let mut body = response.into_body().into_reader();
        let mut buffer = vec![0u8; 256 * 1024];
        loop {
            if self.progress.cancel.load(Ordering::Relaxed) {
                return Err(Fail::Final("Cancelled.".to_string()));
            }
            let read = body.read(&mut buffer).map_err(|e| Fail::Retry(format!("The download broke off ({e}).")))?;
            if read == 0 {
                return Ok(());
            }
            self.write(&buffer[..read])?;
        }
    }
}

fn fetch(installer: &Installer, progress: &Progress, part: &Path) -> std::result::Result<(), String> {
    let mut transfer = Transfer {
        file: fs::File::create(part).map_err(|e| format!("Could not write the installer ({e})."))?,
        hash: Sha256::new().ok_or("Could not check the download.")?,
        done: 0,
        total: installer.size,
        progress,
    };
    progress.total.store(installer.size.unwrap_or(0), Ordering::Relaxed);
    let mut failures = 0u32;
    while transfer.total.is_none_or(|total| transfer.done < total) {
        let before = transfer.done;
        let outcome = match transfer.chunk(&installer.url) {
            Ok(()) if transfer.done == before && transfer.total.is_none_or(|total| transfer.done < total) => {
                Err(Fail::Retry("The server sent nothing.".to_string()))
            }
            outcome => outcome,
        };
        match outcome {
            Ok(()) => failures = 0,
            Err(Fail::Final(message)) => return Err(message),
            Err(Fail::Retry(message)) => {
                if transfer.done > before {
                    failures = 0;
                }
                failures += 1;
                debug_print!("updater: {message} at {} bytes, attempt {failures}", transfer.done);
                if failures > MAX_FAILURES {
                    return Err(message);
                }
                // the pause between attempts keeps cancel responsive
                for _ in 0..failures.min(5) * 10 {
                    if progress.cancel.load(Ordering::Relaxed) {
                        return Err("Cancelled.".to_string());
                    }
                    std::thread::sleep(Duration::from_millis(100));
                }
            }
        }
    }
    let Transfer { file, hash, .. } = transfer;
    file.sync_all().map_err(|e| format!("Could not write the installer ({e})."))?;
    drop(file);
    if let Some(expected) = &installer.sha256
        && hash.hex().as_ref() != Some(expected)
    {
        return Err("The download is damaged, its checksum does not match the release.".to_string());
    }
    Ok(())
}

fn download(installer: &Installer, progress: &Progress) -> std::result::Result<PathBuf, String> {
    let dir = utils::exe_dir();
    let part = dir.join(format!("{}.part", constants::INSTALLER_ASSET));
    // msi registers the file name, and a later run of the github download under another name fails its repair with 1316
    let target = dir.join(constants::INSTALLER_ASSET);
    debug_print!("updater: downloading {} ({:?} bytes)", installer.url, installer.size);

    let result = fetch(installer, progress, &part).and_then(|()| {
        fs::rename(&part, &target).map_err(|e| format!("Could not write the installer ({e})."))?;
        Ok(target.clone())
    });
    match &result {
        Ok(_) => debug_print!("updater: installer complete, {} bytes", progress.done.load(Ordering::Relaxed)),
        Err(error) => {
            debug_print!("updater: download failed: {error}");
            fs::remove_file(&part).ok();
        }
    }
    result
}

#[derive(Clone, Copy, PartialEq)]
enum Stage {
    Offer,
    Downloading,
    Ready,
    Failed,
}

pub(crate) type TaskDialogIndirect = unsafe extern "system" fn(*const TASKDIALOGCONFIG, *mut i32, *mut i32, *mut BOOL) -> HRESULT;

// the activation context stays on for this thread, the dialog's controls are created under it
pub(crate) fn load_task_dialog() -> Option<TaskDialogIndirect> {
    unsafe {
        let module = GetModuleHandleW(None).ok()?;
        let context = ACTCTXW {
            cbSize: size_of::<ACTCTXW>() as u32,
            dwFlags: ACTCTX_FLAG_RESOURCE_NAME_VALID | ACTCTX_FLAG_HMODULE_VALID,
            lpResourceName: PCWSTR(COMCTL6_MANIFEST as usize as *const u16),
            hModule: module,
            ..Default::default()
        };
        let handle = CreateActCtxW(&context).ok()?;
        let mut cookie = 0usize;
        ActivateActCtx(Some(handle), &mut cookie).ok()?;
        let comctl = LoadLibraryW(w!("comctl32.dll")).ok()?;
        let function = GetProcAddress(comctl, s!("TaskDialogIndirect"))?;
        Some(std::mem::transmute::<unsafe extern "system" fn() -> isize, TaskDialogIndirect>(function))
    }
}

fn open_release_page() {
    unsafe {
        ShellExecuteW(
            None,
            w!("open"),
            PCWSTR(create_utf_string(constants::RELEASE_PAGE_URL).as_ptr()),
            None,
            None,
            SW_SHOWNORMAL,
        );
    }
}

wrap_task! {
    struct CloseForUpdate;

    impl Task {
        fn execute(&self) {
            crate::window::close_all();
        }
    }
}

struct Dialog {
    version: String,
    current: String,
    installer: Option<Installer>,
    progress: Arc<Progress>,
    stage: Cell<Stage>,
    shown_mb: Cell<u64>,
    marquee: Cell<bool>,
    // task dialogs keep pointers to their text, so every string lives as long as the dialog
    strings: RefCell<Vec<Vec<u16>>>,
    buttons: RefCell<Vec<Vec<TASKDIALOG_BUTTON>>>,
}

impl Dialog {
    fn show(release: Release, current: semver::Version) {
        let dialog = Dialog {
            version: release.version.to_string(),
            current: current.to_string(),
            progress: Arc::new(Progress {
                done: AtomicU64::new(0),
                total: AtomicU64::new(release.installer.as_ref().and_then(|installer| installer.size).unwrap_or(0)),
                state: AtomicU8::new(RUNNING),
                cancel: AtomicBool::new(false),
                error: Mutex::new(String::new()),
            }),
            installer: release.installer,
            stage: Cell::new(Stage::Offer),
            shown_mb: Cell::new(u64::MAX),
            marquee: Cell::new(false),
            strings: RefCell::new(Vec::new()),
            buttons: RefCell::new(Vec::new()),
        };

        let Some(task_dialog) = load_task_dialog() else {
            let text = create_utf_string(format!("Kute {} is available. Open the download page?", dialog.version));
            if unsafe { MessageBoxW(None, PCWSTR(text.as_ptr()), w!("Kute update"), MB_ICONQUESTION | MB_YESNO) } == IDYES {
                open_release_page();
            }
            return;
        };
        let config = dialog.config(Stage::Offer);
        unsafe {
            task_dialog(&config, std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null_mut()).ok().ok();
        }
    }

    fn text(&self, text: impl AsRef<str>) -> PCWSTR {
        let wide = create_utf_string(text);
        let pointer = PCWSTR(wide.as_ptr());
        self.strings.borrow_mut().push(wide);
        pointer
    }

    fn config(&self, stage: Stage) -> TASKDIALOGCONFIG {
        let mut flags = TDF_ALLOW_DIALOG_CANCELLATION | TDF_CAN_BE_MINIMIZED | TDF_CALLBACK_TIMER | TDF_ENABLE_HYPERLINKS;
        let mut common = TASKDIALOG_COMMON_BUTTON_FLAGS(0);
        let (main, content, buttons, default): (String, String, Vec<(i32, &str)>, i32) = match stage {
            Stage::Offer if self.installer.is_some() => (
                format!("Kute {} is available", self.version),
                format!(
                    "You have {}. The update downloads in the background while you play, Kute only restarts when you say so.",
                    self.current
                ),
                vec![(BTN_UPDATE, "Update"), (IDCANCEL.0, "Not now")],
                BTN_UPDATE,
            ),
            Stage::Offer => (
                format!("Kute {} is available", self.version),
                if utils::is_portable() {
                    format!(
                        "You have {}. This is the portable version: download the new zip and replace this folder with it.",
                        self.current
                    )
                } else {
                    format!("You have {}. Download it from the release page.", self.current)
                },
                vec![(BTN_PAGE, "Open download page"), (IDCANCEL.0, "Not now")],
                BTN_PAGE,
            ),
            Stage::Downloading => {
                flags |= TDF_SHOW_PROGRESS_BAR;
                (
                    format!("Downloading Kute {}", self.version),
                    "Starting the download. You can keep playing.".to_string(),
                    vec![(IDCANCEL.0, "Cancel")],
                    IDCANCEL.0,
                )
            }
            Stage::Ready => (
                format!("Kute {} is ready", self.version),
                "Restart Kute to finish the update. In a match? Choose Later, the update installs when you close Kute.".to_string(),
                vec![(BTN_RESTART, "Restart now"), (IDCANCEL.0, "Later")],
                BTN_RESTART,
            ),
            Stage::Failed => {
                common = TDCBF_CLOSE_BUTTON;
                (
                    "The update could not be downloaded".to_string(),
                    format!("{} Kute will ask again on the next start.", self.progress.error.lock().unwrap()),
                    Vec::new(),
                    IDCLOSE.0,
                )
            }
        };

        let buttons: Vec<TASKDIALOG_BUTTON> = buttons
            .into_iter()
            .map(|(id, label)| TASKDIALOG_BUTTON {
                nButtonID: id,
                pszButtonText: self.text(label),
            })
            .collect();
        let config = TASKDIALOGCONFIG {
            cbSize: size_of::<TASKDIALOGCONFIG>() as u32,
            dwFlags: flags,
            dwCommonButtons: common,
            pszWindowTitle: self.text("Kute update"),
            pszMainInstruction: self.text(main),
            pszContent: self.text(content),
            cButtons: buttons.len() as u32,
            pButtons: buttons.as_ptr(),
            nDefaultButton: default,
            pszFooter: self.text(format!("<a href=\"notes\">What's new in {}</a>", self.version)),
            pfCallback: Some(callback),
            lpCallbackData: self as *const Dialog as isize,
            ..Default::default()
        };
        self.buttons.borrow_mut().push(buttons);
        config
    }

    fn navigate(&self, hwnd: HWND, stage: Stage) {
        self.stage.set(stage);
        let config = self.config(stage);
        unsafe {
            SendMessageW(hwnd, TDM_NAVIGATE_PAGE.0 as u32, None, Some(LPARAM(&config as *const _ as isize)));
        }
    }

    fn on_page(&self, hwnd: HWND) {
        if self.stage.get() == Stage::Downloading {
            self.marquee.set(false);
            self.shown_mb.set(u64::MAX);
            unsafe {
                SendMessageW(hwnd, TDM_SET_PROGRESS_BAR_RANGE.0 as u32, None, Some(LPARAM((1000 << 16) as isize)));
            }
        }
    }

    // the bar sweeps while the size is unknown (a release read from its page, until the first chunk tells it)
    fn set_marquee(&self, hwnd: HWND, on: bool) {
        if self.marquee.get() == on {
            return;
        }
        self.marquee.set(on);
        self.shown_mb.set(u64::MAX);
        unsafe {
            SendMessageW(hwnd, TDM_SET_MARQUEE_PROGRESS_BAR.0 as u32, Some(WPARAM(on as usize)), None);
            SendMessageW(hwnd, TDM_SET_PROGRESS_BAR_MARQUEE.0 as u32, Some(WPARAM(on as usize)), None);
            if !on {
                SendMessageW(hwnd, TDM_SET_PROGRESS_BAR_RANGE.0 as u32, None, Some(LPARAM((1000 << 16) as isize)));
            }
        }
    }

    fn tick(&self, hwnd: HWND) {
        if self.stage.get() != Stage::Downloading {
            return;
        }
        match self.progress.state.load(Ordering::Acquire) {
            READY => {
                self.navigate(hwnd, Stage::Ready);
                unsafe {
                    FlashWindowEx(&FLASHWINFO {
                        cbSize: size_of::<FLASHWINFO>() as u32,
                        hwnd,
                        dwFlags: FLASHW_TRAY | FLASHW_TIMERNOFG,
                        ..Default::default()
                    })
                    .ok()
                    .ok();
                }
            }
            FAILED => self.navigate(hwnd, Stage::Failed),
            _ => {
                let (done, total) = (self.progress.done.load(Ordering::Relaxed), self.progress.total.load(Ordering::Relaxed));
                self.set_marquee(hwnd, total == 0);
                let mb = done / 1_000_000;
                if mb == self.shown_mb.get() {
                    return;
                }
                self.shown_mb.set(mb);
                let text = if total == 0 {
                    self.text(format!("{mb} MB so far. You can keep playing."))
                } else {
                    self.text(format!("{mb} of {} MB. You can keep playing.", total.div_ceil(1_000_000)))
                };
                unsafe {
                    if let Some(position) = (done * 1000).checked_div(total) {
                        SendMessageW(hwnd, TDM_SET_PROGRESS_BAR_POS.0 as u32, Some(WPARAM(position as usize)), None);
                    }
                    SendMessageW(
                        hwnd,
                        TDM_SET_ELEMENT_TEXT.0 as u32,
                        Some(WPARAM(TDE_CONTENT.0 as usize)),
                        Some(LPARAM(text.0 as isize)),
                    );
                }
            }
        }
    }

    // S_FALSE keeps the dialog open
    fn clicked(&self, hwnd: HWND, id: i32) -> HRESULT {
        match (self.stage.get(), id) {
            (Stage::Offer, BTN_UPDATE) => {
                let (Some(installer), progress) = (self.installer.clone(), self.progress.clone()) else {
                    return S_OK;
                };
                note(|status| status.outcome = "downloading");
                std::thread::spawn(move || match download(&installer, &progress) {
                    Ok(msi) if progress.cancel.load(Ordering::Relaxed) => {
                        fs::remove_file(msi).ok();
                    }
                    Ok(msi) => {
                        *PENDING.lock().unwrap() = Some(Pending { msi, relaunch: false });
                        note(|status| status.outcome = "ready");
                        progress.state.store(READY, Ordering::Release);
                    }
                    Err(error) => {
                        note(|status| {
                            status.outcome = "download failed";
                            status.error = Some(error.clone());
                        });
                        *progress.error.lock().unwrap() = error;
                        progress.state.store(FAILED, Ordering::Release);
                    }
                });
                self.navigate(hwnd, Stage::Downloading);
                S_FALSE
            }
            (Stage::Offer, BTN_PAGE) => {
                open_release_page();
                S_OK
            }
            (Stage::Downloading, _) => {
                self.progress.cancel.store(true, Ordering::Relaxed);
                PENDING.lock().unwrap().take();
                note(|status| status.outcome = "cancelled");
                S_OK
            }
            (Stage::Ready, BTN_RESTART) => {
                if let Some(pending) = PENDING.lock().unwrap().as_mut() {
                    pending.relaunch = true;
                }
                let mut task = CloseForUpdate::new();
                post_task(ThreadId::UI, Some(&mut task));
                S_OK
            }
            _ => S_OK,
        }
    }
}

unsafe extern "system" fn callback(hwnd: HWND, msg: TASKDIALOG_NOTIFICATIONS, wparam: WPARAM, _lparam: LPARAM, data: isize) -> HRESULT {
    let dialog = unsafe { &*(data as *const Dialog) };
    match msg {
        TDN_CREATED => {
            set_icons(hwnd);
            // the main window comes up around the same time and would cover the offer
            unsafe {
                SetForegroundWindow(hwnd).ok().ok();
            }
            dialog.on_page(hwnd);
        }
        TDN_NAVIGATED => dialog.on_page(hwnd),
        TDN_TIMER => dialog.tick(hwnd),
        TDN_HYPERLINK_CLICKED => open_release_page(),
        TDN_BUTTON_CLICKED => return dialog.clicked(hwnd, wparam.0 as i32),
        _ => {}
    }
    S_OK
}

fn set_icons(hwnd: HWND) {
    unsafe {
        let Ok(module) = GetModuleHandleW(None) else { return };
        for (kind, width, height) in [(ICON_SMALL, SM_CXSMICON, SM_CYSMICON), (ICON_BIG, SM_CXICON, SM_CYICON)] {
            let (width, height) = (GetSystemMetrics(width), GetSystemMetrics(height));
            if let Ok(icon) = LoadImageW(Some(module.into()), w!("icon"), IMAGE_ICON, width, height, LR_SHARED) {
                SendMessageW(hwnd, WM_SETICON, Some(WPARAM(kind as usize)), Some(LPARAM(icon.0 as isize)));
            }
        }
    }
}

// basic ui without cancel or a final dialog, so the player sees it install. the log stays for a report when the old
// version is still there afterwards (files in use, 1603, 1618)
fn msiexec_args(msi: &Path, relaunch: bool, log: &Path) -> String {
    let mut args = format!("/i \"{}\" /qb!- /L*v \"{}\"", msi.display(), log.display());
    if !relaunch {
        args.push_str(" KUTE_NO_LAUNCH=1");
    }
    args
}

// after shutdown: the client no longer holds its files, msiexec closes nothing of ours
pub fn install_pending() {
    let Some(pending) = PENDING.lock().unwrap().take() else { return };
    let msiexec = PathBuf::from(env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".to_string()))
        .join("System32")
        .join("msiexec.exe");
    let args = msiexec_args(&pending.msi, pending.relaunch, &utils::settings_dir().join("update.log"));
    debug_print!("updater: msiexec {args}");
    let mut command = process::Command::new(msiexec);
    command.raw_arg(args);
    command.spawn().ok();
}

pub fn installer_cleanup() -> io::Result<()> {
    // a portable folder may be the downloads folder, its msi files are not ours
    if utils::is_portable() {
        return Ok(());
    }
    for entry in fs::read_dir(utils::exe_dir())? {
        let path = entry?.path();
        let name = path.file_name().map(|name| name.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
        if path.is_file() && (name.ends_with(".msi") || name.ends_with(".msi.part")) {
            fs::remove_file(&path).ok();
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tag_from_the_release_page_redirect() {
        assert_eq!(tag_from_location("https://github.com/NullDev/Kute/releases/tag/1.3.0"), Some("1.3.0"));
        assert_eq!(tag_from_location("/NullDev/Kute/releases/tag/v1.3.1/"), Some("1.3.1"));
        assert_eq!(tag_from_location("https://github.com/NullDev/Kute/releases/tag/1.3.2?x=1#top"), Some("1.3.2"));
        assert_eq!(tag_from_location("https://github.com/NullDev/Kute/releases"), None);
        assert_eq!(tag_from_location("https://github.com/NullDev/Kute/releases/tag/"), None);
        assert_eq!(tag_from_location(""), None);
    }

    #[test]
    fn content_range_header() {
        assert_eq!(content_range("bytes 0-8388607/170590208"), Some((0, 8388607, Some(170590208))));
        assert_eq!(content_range("bytes 8388608-16777215/*"), Some((8388608, 16777215, None)));
        assert_eq!(content_range("8388608-16777215/1"), None);
        assert_eq!(content_range("bytes */170590208"), None);
    }

    #[test]
    fn msiexec_command_line() {
        let args = msiexec_args(
            Path::new("C:\\kute\\kute-setup-x86_64.msi"),
            false,
            Path::new("C:\\Users\\p\\Documents\\kute\\update.log"),
        );
        assert_eq!(
            args,
            "/i \"C:\\kute\\kute-setup-x86_64.msi\" /qb!- /L*v \"C:\\Users\\p\\Documents\\kute\\update.log\" KUTE_NO_LAUNCH=1"
        );
        assert!(!msiexec_args(Path::new("a.msi"), true, Path::new("u.log")).contains("KUTE_NO_LAUNCH"));
    }
}
