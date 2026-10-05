// the win32 input hooks have no host-level equivalent here, chromium handles raw input itself.
// TODO: ramp boost and the locked left click (F20) need a chromium patch or uinput
use std::sync::atomic::{AtomicBool, Ordering};

static POINTER_LOCKED: AtomicBool = AtomicBool::new(false);
static RAMPBOOST: AtomicBool = AtomicBool::new(false);

pub fn set_pointer_locked(locked: bool) {
    POINTER_LOCKED.store(locked, Ordering::Relaxed);
}

pub fn pointer_locked() -> bool {
    POINTER_LOCKED.load(Ordering::Relaxed)
}

pub fn set_rampboost(enabled: bool) {
    RAMPBOOST.store(enabled, Ordering::Relaxed);
}

// pulseaudio and pipewire capture per application, OBS needs no window here
pub fn spawn_audio_window_thread() {}
