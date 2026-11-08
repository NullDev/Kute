use serde_json::{Value, json};
use windows::{
    Win32::{
        Foundation::*,
        Graphics::{Dwm::*, Gdi::*},
        System::Threading::*,
        UI::WindowsAndMessaging::*,
    },
    core::BOOL,
};

struct Scan {
    ours: HWND,
    pid: u32,
    rect: RECT,
    found: Vec<Value>,
}

// shell windows that are topmost by design and never an overlay someone installed
const SHELL_CLASSES: &[&str] = &[
    "Shell_TrayWnd",
    "Shell_SecondaryTrayWnd",
    "Progman",
    "WorkerW",
    "Windows.UI.Core.CoreWindow",
    "ForegroundStaging",
    "MultitaskingViewFrame",
    "XamlExplorerHostIslandWindow",
    "TopLevelWindowForOverflowXamlIsland",
    "tooltips_class32",
    "IME",
    "MSCTFIME UI",
];

fn wide(buf: &[u16], len: usize) -> String {
    String::from_utf16_lossy(&buf[..len.min(buf.len())]).trim().to_string()
}

fn process_name(pid: u32) -> String {
    unsafe {
        let Ok(handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
            return String::new();
        };
        let mut buf = [0u16; 1024];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, windows::core::PWSTR(buf.as_mut_ptr()), &mut len).is_ok();
        CloseHandle(handle).ok();
        if !ok {
            return String::new();
        }
        let full = wide(&buf, len as usize);
        full.rsplit(['\\', '/']).next().unwrap_or("").to_string()
    }
}

unsafe extern "system" fn enum_proc(window: HWND, lparam: LPARAM) -> BOOL {
    let scan = unsafe { &mut *(lparam.0 as *mut Scan) };
    unsafe {
        if window == scan.ours || !IsWindowVisible(window).as_bool() {
            return true.into();
        }
        let ex = GetWindowLongPtrW(window, GWL_EXSTYLE) as u32;
        if ex & WS_EX_TOPMOST.0 == 0 {
            return true.into();
        }
        let mut rect = RECT::default();
        let mut overlap = RECT::default();
        if GetWindowRect(window, &mut rect).is_err() || !IntersectRect(&mut overlap, &rect, &scan.rect).as_bool() {
            return true.into();
        }
        // uwp shells stay "visible" while cloaked
        let mut cloaked: u32 = 0;
        if DwmGetWindowAttribute(window, DWMWA_CLOAKED, &mut cloaked as *mut _ as *mut _, std::mem::size_of::<u32>() as u32).is_ok() && cloaked != 0 {
            return true.into();
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(window, Some(&mut pid));
        if pid == scan.pid {
            return true.into();
        }
        let mut class_buf = [0u16; 256];
        let class_len = GetClassNameW(window, &mut class_buf) as usize;
        let class = wide(&class_buf, class_len);
        if SHELL_CLASSES.contains(&class.as_str()) {
            return true.into();
        }
        let mut title_buf = [0u16; 256];
        let title_len = GetWindowTextW(window, &mut title_buf) as usize;
        let title: String = wide(&title_buf, title_len).chars().take(60).collect();
        let area = |r: &RECT| ((r.right - r.left).max(0) as i64) * ((r.bottom - r.top).max(0) as i64);
        let share = if area(&scan.rect) > 0 {
            area(&overlap) as f64 / area(&scan.rect) as f64
        } else {
            0.0
        };
        scan.found.push(json!({
            "process": process_name(pid),
            "class": class,
            "title": title,
            "layered": ex & WS_EX_LAYERED.0 != 0,
            "transparent": ex & WS_EX_TRANSPARENT.0 != 0,
            "coverage": (share * 100.0).round() / 100.0,
        }));
    }
    true.into()
}

// topmost windows over the game window. one of them (Medal, Discord, NVIDIA, Game Bar overlays) is enough to take
// DWM's independent flip away from kute, every present goes through composition then (verified 2026-10-09 with Medal)
pub fn windows_over(hwnd: HWND) -> Vec<Value> {
    if hwnd.is_invalid() {
        return Vec::new();
    }
    let mut scan = Scan {
        ours: hwnd,
        pid: unsafe { GetCurrentProcessId() },
        rect: RECT::default(),
        found: Vec::new(),
    };
    unsafe {
        if GetWindowRect(hwnd, &mut scan.rect).is_err() {
            return Vec::new();
        }
        EnumWindows(Some(enum_proc), LPARAM(&mut scan as *mut Scan as isize)).ok();
    }
    scan.found
}
