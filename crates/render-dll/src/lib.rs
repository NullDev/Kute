use minhook::MinHook;
use std::{ffi::c_void, mem, sync::atomic::Ordering};
use windows::Win32::{
    Foundation::*,
    Graphics::Dxgi::*,
    System::{
        Memory::*,
        SystemServices::{DLL_PROCESS_ATTACH, DLL_PROCESS_DETACH},
        Threading::*,
    },
};
use windows::core::*;

#[macro_export]
macro_rules! debug_print {
    ($($arg:tt)*) => {
        if cfg!(feature = "verbose-logs") {
            let msg = format!($($arg)*);
            let wide: Vec<u16> = msg.encode_utf16().chain(Some(0)).collect();
            #[allow(unused_unsafe)]
            unsafe {
                ::windows::Win32::System::Diagnostics::Debug::OutputDebugStringW(
                    ::windows::core::PCWSTR(wide.as_ptr()),
                );
            }
        }
    };
}

mod capture;
#[macro_use]
mod shared;
mod present;
mod swapchain;
mod wait;

use present::*;
use shared::*;
use swapchain::*;

// the Present1 hook goes on the first swap chain chromium creates, from inside the creation hook. the dummy D3D11
// device and 1x1 composition chain that used to give the vtable at attach time cost a tenth of a core and stalls of
// 50 to 140 ms for the whole life of the gpu process on a starved cpu (two e-cores: slowest frames 9 to 21 ms, worst
// 20 to 140 ms), hooks or no hooks, and that was the laptop problem
static PRESENT_HOOKED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

pub(crate) unsafe fn hook_present_of(swap_chain: *mut c_void) {
    if PRESENT_HOOKED.swap(true, Ordering::AcqRel) {
        return;
    }
    unsafe {
        let chain = IDXGISwapChain1::from_raw_borrowed(&swap_chain).unwrap();
        let original_present = match MinHook::create_hook(chain.vtable().Present1 as *mut c_void, present_hk as *mut c_void) {
            Ok(trampoline) => trampoline,
            Err(_e) => {
                debug_print!("render: Present1 hook failed: {_e:?}");
                return;
            }
        };
        // stored before enabling, a present in between would find None
        #[allow(clippy::missing_transmute_annotations)]
        {
            ORIGINAL_PRESENT = mem::transmute(original_present);
        }
        match MinHook::enable_hook(chain.vtable().Present1 as *mut c_void) {
            Ok(()) => debug_print!("render: Present1 hook enabled on the first swap chain"),
            Err(_e) => debug_print!("render: cannot enable the Present1 hook: {_e:?}"),
        }
    }
}

fn attach() {
    debug_print!("render: attach started, pid={}", unsafe { GetCurrentProcessId() });
    // KUTE_HOOK_DETACH=1: bench knob, the dll is loaded and nothing else happens
    if crate::swapchain::knob("KUTE_HOOK_DETACH", 0) == 1 {
        return;
    }
    unsafe {
        capture::capture_init();
        // bench runs (src/modules/bench.rs) use their own mapping
        let mapping_name = HSTRING::from(std::env::var("KUTE_TIMING_MAPPING").unwrap_or_else(|_| "KuteFrameTiming".to_string()));
        match OpenFileMappingW(FILE_MAP_ALL_ACCESS.0, false, &mapping_name) {
            Ok(mapping) => {
                debug_print!("render: opened frame timing mapping={mapping:?}");
                let ptr = MapViewOfFile(mapping, FILE_MAP_ALL_ACCESS, 0, 0, SHARED_STATE_SIZE);
                if !ptr.Value.is_null() {
                    SHARED_MEM_PTR.store(ptr.Value as u64, Ordering::Release);
                    debug_print!("render: mapped frame timing state={:?}", ptr.Value);
                } else {
                    debug_print!("render: MapViewOfFile for frame timing returned null");
                }
            }
            Err(_error) => (),
        }
        // a factory without a device gives the creation vtable, chromium's device never sees a second one
        let factory: IDXGIFactory2 = CreateDXGIFactory1().unwrap_or_else(|e| {
            debug_print!("render: CreateDXGIFactory1 failed: {e:?}");
            panic!("CreateDXGIFactory1 failed")
        });
        let original_create_swapchain = MinHook::create_hook(
            factory.vtable().CreateSwapChainForComposition as *mut c_void,
            create_swapchain_hk as *mut c_void,
        )
        .unwrap_or_else(|e| {
            debug_print!("render: CreateSwapChainForComposition hook failed: {e:?}");
            panic!("CreateSwapChainForComposition hook failed")
        });
        debug_print!("render: swap-chain hook created, trampoline={original_create_swapchain:p}");
        // stored before enabling, a call in between would find None
        #[allow(clippy::missing_transmute_annotations)]
        {
            ORIGINAL_CREATE_SWAPCHAIN = mem::transmute(original_create_swapchain);
        }
        match MinHook::enable_all_hooks() {
            Ok(()) => debug_print!("render: all MinHook hooks enabled"),
            Err(error) => debug_print!("render: cannot enable hooks: {error:?}"),
        }
        debug_print!("render: attach completed");
    }
}

// called by the gpu process right after LoadLibrary, before chromium makes a swap chain. 1 = ok
#[unsafe(no_mangle)]
pub extern "system" fn render_attach() -> i32 {
    match std::panic::catch_unwind(attach) {
        Ok(()) => 1,
        Err(_) => {
            debug_print!("render: attach panicked");
            0
        }
    }
}

// must return TRUE explicitly, a leftover zero in the register fails LoadLibrary
#[unsafe(no_mangle)]
extern "system" fn DllMain(_: HINSTANCE, call_reason: u32, reserved: *mut ()) -> BOOL {
    if call_reason == DLL_PROCESS_ATTACH {
        debug_print!("render: DLL_PROCESS_ATTACH, waiting for render_attach");
    } else if call_reason == DLL_PROCESS_DETACH && !reserved.is_null() {
        // process exit: other threads may be dead holding our locks, skip cleanup
        debug_print!("render: DLL_PROCESS_DETACH at process exit, nothing to clean up");
    } else if call_reason == DLL_PROCESS_DETACH {
        debug_print!("render: DLL_PROCESS_DETACH, cleaning capture state and handles");
        capture::capture_cleanup();
        unsafe {
            let mut guard = WAIT_HANDLE.write().unwrap();
            for (sc, handle) in guard.drain() {
                if !handle.0.is_invalid() {
                    debug_print!("render: closing handle {:?} for swapchain {:#x}", handle.0, sc);
                    let _ = CloseHandle(handle.0);
                }
            }
        }
    }
    TRUE
}
