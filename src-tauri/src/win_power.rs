//! Windows 11 puts minimized/background apps (and their children) into EcoQoS
//! ("efficiency mode"): the scheduler moves them to E-cores and lowers clocks, which
//! tanked download/render speed whenever the window was minimized. This module opts
//! the app and every spawned ffmpeg/yt-dlp/N_m3u8DL-RE out of execution-speed throttling.

#[cfg(windows)]
mod imp {
    #[repr(C)]
    struct ProcessPowerThrottlingState {
        version: u32,
        control_mask: u32,
        state_mask: u32,
    }

    const PROCESS_POWER_THROTTLING_CURRENT_VERSION: u32 = 1;
    const PROCESS_POWER_THROTTLING_EXECUTION_SPEED: u32 = 0x1;
    /// PROCESS_INFORMATION_CLASS::ProcessPowerThrottling
    const PROCESS_POWER_THROTTLING_CLASS: i32 = 4;
    const PROCESS_SET_INFORMATION: u32 = 0x0200;

    #[link(name = "kernel32")]
    extern "system" {
        fn GetCurrentProcess() -> isize;
        fn OpenProcess(desired_access: u32, inherit_handle: i32, process_id: u32) -> isize;
        fn CloseHandle(handle: isize) -> i32;
        fn SetProcessInformation(
            process: isize,
            class: i32,
            information: *mut core::ffi::c_void,
            size: u32,
        ) -> i32;
    }

    unsafe fn apply(handle: isize) {
        // control_mask selects EXECUTION_SPEED; state_mask = 0 means "never throttle".
        let mut state = ProcessPowerThrottlingState {
            version: PROCESS_POWER_THROTTLING_CURRENT_VERSION,
            control_mask: PROCESS_POWER_THROTTLING_EXECUTION_SPEED,
            state_mask: 0,
        };
        let _ = SetProcessInformation(
            handle,
            PROCESS_POWER_THROTTLING_CLASS,
            &mut state as *mut _ as *mut core::ffi::c_void,
            std::mem::size_of::<ProcessPowerThrottlingState>() as u32,
        );
    }

    pub fn disable_for_current_process() {
        unsafe { apply(GetCurrentProcess()) }
    }

    pub fn disable_for_pid(pid: u32) {
        unsafe {
            let handle = OpenProcess(PROCESS_SET_INFORMATION, 0, pid);
            if handle != 0 {
                apply(handle);
                CloseHandle(handle);
            }
        }
    }
}

#[cfg(windows)]
pub fn disable_for_current_process() {
    imp::disable_for_current_process();
}

#[cfg(windows)]
pub fn disable_for_pid(pid: Option<u32>) {
    if let Some(pid) = pid {
        imp::disable_for_pid(pid);
    }
}

#[cfg(not(windows))]
pub fn disable_for_current_process() {}

#[cfg(not(windows))]
pub fn disable_for_pid(_pid: Option<u32>) {}
