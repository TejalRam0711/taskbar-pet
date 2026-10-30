use std::{
    sync::{
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering::SeqCst},
        mpsc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, Submenu},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager, PhysicalPosition, WebviewWindow, Wry,
};

// Clickable areas (x, y, width, height in CSS px from the window's top-left): the cat and its open bubble.
#[derive(Default)]
struct HitAreas(Mutex<Vec<[f64; 4]>>);

#[tauri::command]
fn set_hit_areas(state: tauri::State<HitAreas>, areas: Vec<[f64; 4]>) {
    *state.0.lock().unwrap() = areas;
}

// The window is only as big as the cat, so walking moves the window. Bumping this cancels a walk in progress.
#[derive(Default)]
struct WalkId(AtomicU64);

// Slide the window to physical x over `ms`; true if it got there, false if halted on the way.
#[tauri::command]
async fn walk_to(window: WebviewWindow, x: i32, ms: u64) -> Result<bool, String> {
    let app = window.app_handle().clone();
    let me = app.state::<WalkId>().0.fetch_add(1, SeqCst) + 1;
    let start = window.outer_position().map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let t0 = Instant::now();
        loop {
            if app.state::<WalkId>().0.load(SeqCst) != me {
                return Ok(false);
            }
            let t = (t0.elapsed().as_secs_f64() * 1000.0 / ms.max(1) as f64).min(1.0);
            let nx = start.x + ((x - start.x) as f64 * t).round() as i32;
            window.set_position(PhysicalPosition::new(nx, start.y)).map_err(|e| e.to_string())?;
            if t >= 1.0 {
                return Ok(true);
            }
            thread::sleep(Duration::from_millis(33)); // 30 moves a second, in step with the 30 fps walk cycle
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn halt(walk: tauri::State<WalkId>) {
    walk.0.fetch_add(1, SeqCst);
}

// Picked up: the window follows the cursor (x within min..max, never below the taskbar) until the button is
// let go, then drops back onto the taskbar; returns where it landed. Done here rather than from page events
// so it keeps up with a fast cursor.
#[tauri::command]
async fn drag(window: WebviewWindow, min: i32, max: i32) -> Result<i32, String> {
    window.app_handle().state::<WalkId>().0.fetch_add(1, SeqCst); // stops a walk
    let err = |e: tauri::Error| e.to_string();
    let start = window.outer_position().map_err(err)?;
    let c = window.cursor_position().map_err(err)?;
    let grab = (c.x - start.x as f64, c.y - start.y as f64);
    tauri::async_runtime::spawn_blocking(move || {
        let (mut x, mut y) = (start.x, start.y);
        while button_down() {
            let c = window.cursor_position().map_err(err)?;
            x = ((c.x - grab.0).round() as i32).min(max).max(min);
            y = ((c.y - grab.1).round() as i32).min(start.y);
            window.set_position(PhysicalPosition::new(x, y)).map_err(err)?;
            thread::sleep(Duration::from_millis(16));
        }
        let (from, t0) = (y as f64, Instant::now());
        while y < start.y {
            let t = t0.elapsed().as_secs_f64();
            y = ((from + 0.5 * 5000.0 * t * t) as i32).min(start.y); // falls at 5000 physical px/s²
            window.set_position(PhysicalPosition::new(x, y)).map_err(err)?;
            thread::sleep(Duration::from_millis(16));
        }
        Ok(x)
    })
    .await
    .map_err(|e| e.to_string())?
}

// The primary mouse button is held. GetAsyncKeyState reads the physical buttons, so allow for swapped ones.
#[cfg(windows)]
fn button_down() -> bool {
    use windows::Win32::UI::{
        Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON, VK_RBUTTON},
        WindowsAndMessaging::{GetSystemMetrics, SM_SWAPBUTTON},
    };
    unsafe {
        let key = if GetSystemMetrics(SM_SWAPBUTTON) != 0 { VK_RBUTTON } else { VK_LBUTTON };
        GetAsyncKeyState(key.0 as i32) < 0
    }
}

#[cfg(not(windows))]
fn button_down() -> bool {
    false
}

// The tray menu, also shown when you right-click the pet, and its game mode tick.
struct PetMenu(Menu<Wry>, CheckMenuItem<Wry>);

#[tauri::command]
fn pet_menu(window: WebviewWindow, menu: tauri::State<PetMenu>) -> Result<(), String> {
    window.popup_menu(&menu.0).map_err(|e| e.to_string())
}

// The page remembers the game mode setting and hands it back at start.
#[tauri::command]
fn set_game_mode(menu: tauri::State<PetMenu>, on: bool) {
    GAME_MODE.store(on, SeqCst);
    let _ = menu.1.set_checked(on);
}

// Dictation with Whisper (whisper.cpp, run on this laptop; scripts/get-whisper.ps1 puts it in the app's data
// folder). The mic is read through Windows' speech audio object (no permission prompt, no overlay) and cut into
// phrases at pauses; Whisper writes each one down in the background while listening goes on, and it goes to the
// page as a "dictation" event. On the GPU, the phrase you're still saying goes as "dictation-partial" events too
// (words that may still change). "dictation-end" (with an error message or null) when it stops: you pressed the
// mic again, a minute without a phrase, or a failure such as Whisper missing. (Windows' own recognisers were
// tried first: the online one heard speech here but returned no words, the offline one was mostly wrong.)
// (session number, how to stop the current session)
#[derive(Default)]
struct Dictation(Mutex<(u64, Option<mpsc::Sender<()>>)>);

#[tauri::command]
fn dictate(app: AppHandle, state: tauri::State<Dictation>, on: bool) {
    let mut d = state.0.lock().unwrap();
    d.0 += 1;
    if let Some(stop) = d.1.take() {
        let _ = stop.send(());
    }
    if !on {
        return;
    }
    let (stop_tx, stop_rx) = mpsc::channel();
    d.1 = Some(stop_tx);
    let session = d.0;
    thread::spawn(move || {
        let error = listen(&app, stop_rx).err();
        let state = app.state::<Dictation>();
        let mut d = state.0.lock().unwrap();
        // Only report an end the page didn't ask for (silence or an error), not a press of the mic button.
        if d.0 == session {
            d.1 = None;
            let _ = app.emit("dictation-end", error);
        }
    });
}

const RATE: usize = 16_000; // Whisper wants 16 kHz mono 16-bit
const BLOCK: usize = RATE / 10; // the mic is read 100 ms at a time

#[cfg(windows)]
fn listen(app: &AppHandle, stop: mpsc::Receiver<()>) -> Result<(), String> {
    use windows::{
        core::Interface,
        Win32::{Media::Speech::*, System::Com::*},
    };
    let data = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    // Each step goes to mic.log in the app's local data folder, so a failure can be traced.
    let path = data.join("mic.log");
    let t0 = Instant::now();
    let log = move |line: String| {
        use std::io::Write;
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
            let _ = writeln!(f, "{:>7} ms  {line}", t0.elapsed().as_millis());
        }
    };
    log("--- mic on".into());
    let run = || -> windows::core::Result<Result<(), String>> {
        unsafe {
            CoInitializeEx(None, COINIT_MULTITHREADED).ok()?;
            let mic: ISpAudio = CoCreateInstance(&SpMMAudioIn, None, CLSCTX_ALL)?; // the default recording device
            mic.SetFormat(&SPDFID_WAVEFORMATEX, &PCM)?;
            mic.SetState(SPAS_RUN, 0)?;
            let heard = |text: String, done| drop(app.emit(if done { "dictation" } else { "dictation-partial" }, text));
            let done = dictate_from(&mic.cast()?, &stop, &data.join("whisper"), heard, &log);
            let _ = mic.SetState(SPAS_CLOSED, 0);
            Ok(done)
        }
    };
    run().map_err(|e| e.message()).and_then(|done| done).inspect_err(|e| log(format!("error: {e}")))
}

#[cfg(not(windows))]
fn listen(_: &AppHandle, _: mpsc::Receiver<()>) -> Result<(), String> {
    Err("Dictation needs Windows".into())
}

#[cfg(windows)]
const SPDFID_WAVEFORMATEX: windows::core::GUID = windows::core::GUID::from_u128(0xc31adbae_527f_4ff5_a230_f62bb61ff70c);
#[cfg(windows)]
const PCM: windows::Win32::Media::Audio::WAVEFORMATEX = windows::Win32::Media::Audio::WAVEFORMATEX {
    wFormatTag: 1, nChannels: 1, nSamplesPerSec: RATE as u32, nAvgBytesPerSec: RATE as u32 * 2, nBlockAlign: 2, wBitsPerSample: 16, cbSize: 0,
};

// Reads 16 kHz mono audio from `input` (the mic, or a sound file in the test) until `stop` says so, the input
// runs out, or a minute passes without a phrase. Whisper writes the phrases down on a second thread, in order;
// each one's text goes to `heard(text, true)` (empty if it was only noise). On the GPU, the phrase you're still
// saying is also written down whenever Whisper is free and you've said more since: `heard(text, false)`.
#[cfg(windows)]
fn dictate_from(
    input: &windows::Win32::System::Com::ISequentialStream,
    stop: &mpsc::Receiver<()>,
    whisper: &std::path::Path,
    heard: impl Fn(String, bool) + Sync,
    log: &(dyn Fn(String) + Sync),
) -> Result<(), String> {
    // The GPU build with the large model when they're installed (NVIDIA; the build needs NVIDIA's cuBLAS beside it,
    // or it quietly runs on the CPU, too slowly for the large model), else the CPU build with the small one.
    let gpu = (whisper.join("bin-cuda").join("whisper-server.exe"), whisper.join("ggml-large-v3-turbo-q5_0.bin"));
    let on_gpu = whisper.join("bin-cuda").join("cublas64_11.dll").exists() && gpu.0.exists() && gpu.1.exists();
    let (exe, model) = match on_gpu {
        true => gpu,
        false => (whisper.join("bin").join("whisper-server.exe"), whisper.join("ggml-small.en-q5_1.bin")),
    };
    log(format!("whisper on the {}", if on_gpu { "GPU, large model" } else { "CPU, small model" }));
    if !exe.exists() || !model.exists() {
        return Err("Whisper isn't installed (run scripts/get-whisper.ps1)".into());
    }
    let (heard, pending) = (&heard, &AtomicUsize::new(0)); // pending: phrases sent to Whisper and not written yet
    thread::scope(|s| {
        let (phrases_tx, phrases_rx) = mpsc::channel::<(Vec<i16>, bool)>();
        let worker = s.spawn(move || -> Result<(), String> {
            let t = Instant::now();
            let whisper = Server::start(&exe, &model)?;
            log(format!("whisper loaded, {} ms", t.elapsed().as_millis()));
            for (phrase, done) in phrases_rx {
                let t = Instant::now();
                match whisper.transcribe(&phrase, !on_gpu) {
                    Ok(text) => {
                        if done {
                            log(format!("{:.1} s of speech, {} ms: {text}", phrase.len() as f32 / RATE as f32, t.elapsed().as_millis()));
                        }
                        heard(text, done);
                    }
                    Err(e) => log(format!("whisper failed: {e}")),
                }
                pending.fetch_sub(1, SeqCst);
            }
            Ok(())
        });
        let send = move |phrase, done| {
            pending.fetch_add(1, SeqCst);
            let _ = phrases_tx.send((phrase, done));
        };
        log("listening".into());
        let (mut phrases, mut block, mut last, mut sent) = (Phrases::default(), vec![0i16; BLOCK], Instant::now(), 0);
        loop {
            let mut got = 0u32;
            unsafe { input.Read(block.as_mut_ptr().cast(), BLOCK as u32 * 2, Some(&mut got)) }.ok().map_err(|e| e.message())?;
            if got == 0 {
                break; // a sound file ran out
            }
            if let Some(phrase) = phrases.push(&block[..got as usize / 2]) {
                (last, sent) = (Instant::now(), 0);
                send(phrase, true);
            } else if on_gpu && pending.load(SeqCst) == 0 && phrases.loud >= 3 && phrases.quiet == 0 && phrases.phrase.len() >= sent + 3 * BLOCK {
                // the phrase so far, so words show while you talk (only when Whisper is idle, so the
                // finished phrase never waits behind more than one of these)
                sent = phrases.phrase.len();
                send(phrases.phrase.clone(), false);
            }
            if worker.is_finished() {
                break; // Whisper didn't start
            }
            if !matches!(stop.try_recv(), Err(mpsc::TryRecvError::Empty)) {
                log("stopped by the mic button".into());
                break;
            }
            if last.elapsed() > Duration::from_secs(60) {
                log("a minute without a phrase".into());
                break;
            }
        }
        if let Some(phrase) = phrases.flush() {
            send(phrase, true); // what you said just before pressing stop
        }
        drop(send); // lets Whisper finish what's sent and stop
        worker.join().map_err(|_| "Whisper's thread crashed".to_string())?
    })
}

// Cuts 100 ms blocks of audio into phrases: from the block before the first loud one to 0.7 s of quiet after the
// last (or 25 s, inside Whisper's 30 s window). Loud = well above the background level, which follows quiet
// drops at once and rises only slowly, so talking doesn't raise it. A phrase with under 0.3 s of loud audio is
// dropped as a click or a bump: Whisper tends to find words in noise.
#[derive(Default)]
struct Phrases {
    floor: f32,
    before: Vec<i16>,
    phrase: Vec<i16>,
    loud: u32,
    quiet: u32,
}

impl Phrases {
    fn push(&mut self, block: &[i16]) -> Option<Vec<i16>> {
        let rms = (block.iter().map(|&s| (s as f32).powi(2)).sum::<f32>() / block.len().max(1) as f32).sqrt();
        let loud = rms > self.floor * 3.0 + 150.0;
        self.floor = if rms < self.floor || self.floor == 0.0 { rms } else { self.floor * 0.995 + rms * 0.005 };
        if self.phrase.is_empty() && !loud {
            self.before = block.to_vec();
            return None;
        }
        if self.phrase.is_empty() {
            self.phrase = std::mem::take(&mut self.before);
        }
        self.phrase.extend_from_slice(block);
        if loud {
            (self.loud, self.quiet) = (self.loud + 1, 0);
        } else {
            self.quiet += 1;
        }
        if self.quiet >= 7 || self.phrase.len() >= 25 * RATE { self.flush() } else { None }
    }

    fn flush(&mut self) -> Option<Vec<i16>> {
        let loud = std::mem::take(&mut self.loud);
        self.quiet = 0;
        let phrase = std::mem::take(&mut self.phrase);
        (loud >= 3).then_some(phrase)
    }
}

// whisper-server with the model loaded, for one dictation session: loading it took most of each phrase's wait
// when it was loaded per phrase. It answers on this laptop only, at a free port. A job object ends it with the
// pet, even if the pet is quit or crashes mid-sentence, so it can't go on holding the GPU's memory.
#[cfg(windows)]
struct Server {
    process: std::process::Child,
    port: u16,
    job: windows::core::Owned<windows::Win32::Foundation::HANDLE>,
}

#[cfg(windows)]
impl Server {
    fn start(exe: &std::path::Path, model: &std::path::Path) -> Result<Server, String> {
        use std::os::windows::{io::AsRawHandle, process::CommandExt};
        use windows::{
            core::{Owned, PCWSTR},
            Win32::{Foundation::HANDLE, System::JobObjects::*},
        };
        let err = |e: windows::core::Error| e.message();
        let port = std::net::TcpListener::bind("127.0.0.1:0").and_then(|l| l.local_addr()).map_err(|e| e.to_string())?.port();
        let job = unsafe { Owned::new(CreateJobObjectW(None, PCWSTR::null()).map_err(err)?) };
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let size = std::mem::size_of_val(&limits) as u32;
        unsafe { SetInformationJobObject(*job, JobObjectExtendedLimitInformation, &limits as *const _ as _, size) }.map_err(err)?;
        let process = std::process::Command::new(exe)
            .args(["-l", "en", "-sns", "-t", "6", "--host", "127.0.0.1", "--port", &port.to_string(), "-m"])
            .arg(model)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
            .spawn()
            .map_err(|e| e.to_string())?;
        let mut server = Server { process, port, job }; // from here on, dropping it ends the server
        unsafe { AssignProcessToJobObject(*server.job, HANDLE(server.process.as_raw_handle())) }.map_err(err)?;
        let t = Instant::now();
        while server.request("GET /health", "text/plain", &[]).is_err() {
            if t.elapsed() > Duration::from_secs(30) || !matches!(server.process.try_wait(), Ok(None)) {
                return Err("Whisper didn't start".into());
            }
            thread::sleep(Duration::from_millis(50));
        }
        Ok(server)
    }

    // One phrase, posted as a .wav file; the words come back as text. `shorten` cuts Whisper's audio window to the
    // phrase's length (+1 s): ~3x faster than the full 30 s on the CPU. Not for the large model on the GPU: it
    // repeats itself with a cut window, and the full one costs ~0.15 s more there. Lines like "[BLANK_AUDIO]" or
    // "(wind)" are Whisper describing noise, not words.
    fn transcribe(&self, phrase: &[i16], shorten: bool) -> Result<String, String> {
        const B: &str = "taskbar-pet-phrase"; // form boundary
        let context = if shorten { ((phrase.len() / RATE + 1) * 50).clamp(300, 1500) } else { 0 }; // 1500 = 30 s, 0 = all
        let field = |name: &str, value: &str| format!("--{B}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n");
        let mut form = [field("response_format", "text"), field("audio_ctx", &context.to_string())].concat().into_bytes();
        form.extend(format!("--{B}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"phrase.wav\"\r\n\r\n").bytes());
        form.extend(wav_bytes(phrase));
        form.extend(format!("\r\n--{B}--\r\n").bytes());
        let text = self.request("POST /inference", &format!("multipart/form-data; boundary={B}"), &form)?;
        Ok(text.lines().map(str::trim).filter(|l| !l.is_empty() && !l.starts_with(['[', '('])).collect::<Vec<_>>().join(" "))
    }

    // One request ("GET /health") to the server; the reply's body if it's 200 OK.
    fn request(&self, line: &str, content_type: &str, body: &[u8]) -> Result<String, String> {
        use std::io::{Read, Write};
        let mut s = std::net::TcpStream::connect(("127.0.0.1", self.port)).map_err(|e| e.to_string())?;
        let head = format!(
            "{line} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\n\r\n",
            body.len()
        );
        s.write_all(head.as_bytes()).and_then(|_| s.write_all(body)).map_err(|e| e.to_string())?;
        let mut reply = vec![];
        s.read_to_end(&mut reply).map_err(|e| e.to_string())?;
        let reply = String::from_utf8_lossy(&reply);
        let (status, body) = reply.split_once("\r\n\r\n").ok_or("no reply")?;
        match status.starts_with("HTTP/1.1 200") {
            true => Ok(body.to_string()),
            false => Err(status.lines().next().unwrap_or_default().to_string()),
        }
    }
}

#[cfg(windows)]
impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.process.kill();
        let _ = self.process.wait();
    }
}

// 16 kHz mono 16-bit samples as a .wav file.
fn wav_bytes(samples: &[i16]) -> Vec<u8> {
    let (rate, data) = (RATE as u32, samples.len() as u32 * 2);
    let mut b = [&b"RIFF"[..], &(36 + data).to_le_bytes(), b"WAVEfmt ", &16u32.to_le_bytes(), &1u16.to_le_bytes(),
        &1u16.to_le_bytes(), &rate.to_le_bytes(), &(rate * 2).to_le_bytes(), &2u16.to_le_bytes(), &16u16.to_le_bytes(),
        b"data", &data.to_le_bytes()]
        .concat();
    b.extend(samples.iter().flat_map(|s| s.to_le_bytes()));
    b
}

// Milliseconds since the last keyboard or mouse input anywhere, for the stretch nudges.
#[tauri::command]
fn idle_ms() -> u32 {
    #[cfg(windows)]
    unsafe {
        use windows::Win32::{
            System::SystemInformation::GetTickCount,
            UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO},
        };
        let mut info = LASTINPUTINFO { cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32, dwTime: 0 };
        if GetLastInputInfo(&mut info).as_bool() {
            return GetTickCount().wrapping_sub(info.dwTime);
        }
    }
    0
}

// Game mode: the cat hides while something is fullscreen on the main screen and comes back after.
// Set when you hide the cat from the tray, so the end of a game doesn't bring it back.
static USER_HIDDEN: AtomicBool = AtomicBool::new(false);
// Menu › "Hide during games / fullscreen"
static GAME_MODE: AtomicBool = AtomicBool::new(true);

// [left, top, right, bottom]
fn covers(window: [i32; 4], screen: [i32; 4]) -> bool {
    window[0] <= screen[0] && window[1] <= screen[1] && window[2] >= screen[2] && window[3] >= screen[3]
}

#[cfg(windows)]
fn fullscreen_app() -> bool {
    use windows::Win32::{
        Foundation::{POINT, RECT},
        Graphics::Gdi::{GetMonitorInfoW, MonitorFromPoint, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST, MONITOR_DEFAULTTOPRIMARY},
        UI::{
            Shell::{SHQueryUserNotificationState, QUNS_BUSY, QUNS_PRESENTATION_MODE, QUNS_RUNNING_D3D_FULL_SCREEN},
            WindowsAndMessaging::{GetClassNameW, GetForegroundWindow, GetWindowRect},
        },
    };
    unsafe {
        // Windows' own "busy" signal: exclusive-fullscreen games, presentations, fullscreen apps.
        if let Ok(state) = SHQueryUserNotificationState() {
            if [QUNS_BUSY, QUNS_RUNNING_D3D_FULL_SCREEN, QUNS_PRESENTATION_MODE].contains(&state) {
                return true;
            }
        }
        // Borderless "fullscreen" games and F11 video: the active window covers the whole main screen.
        let fg = GetForegroundWindow();
        if fg.is_invalid() {
            return false;
        }
        let mut class = [0u16; 64];
        let n = GetClassNameW(fg, &mut class) as usize;
        if ["Progman", "WorkerW", "Shell_TrayWnd"].contains(&String::from_utf16_lossy(&class[..n]).as_str()) {
            return false; // the desktop or the taskbar
        }
        let primary = MonitorFromPoint(POINT { x: 0, y: 0 }, MONITOR_DEFAULTTOPRIMARY);
        if MonitorFromWindow(fg, MONITOR_DEFAULTTONEAREST) != primary {
            return false;
        }
        let mut info = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
        let mut r = RECT::default();
        if !GetMonitorInfoW(primary, &mut info).as_bool() || GetWindowRect(fg, &mut r).is_err() {
            return false;
        }
        let m = info.rcMonitor;
        covers([r.left, r.top, r.right, r.bottom], [m.left, m.top, m.right, m.bottom])
    }
}

#[cfg(not(windows))]
fn fullscreen_app() -> bool {
    false
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Opening it again (Start menu, Startup) shows the pet that's already running instead of a second one.
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(win) = app.get_webview_window("main") {
                USER_HIDDEN.store(false, SeqCst);
                let _ = win.show();
            }
        }))
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_notification::init())
        .manage(HitAreas::default())
        .manage(WalkId::default())
        .manage(Dictation::default())
        .invoke_handler(tauri::generate_handler![
            set_hit_areas, walk_to, halt, drag, pet_menu, set_game_mode, dictate, idle_ms
        ])
        .setup(|app| {
            let toggle = MenuItem::with_id(app, "toggle", "Hide / show pet", true, None::<&str>)?;
            let snooze = MenuItem::with_id(app, "snooze", "Snooze 1 hour", true, None::<&str>)?;
            let game = CheckMenuItem::with_id(app, "game", "Hide during games / fullscreen", true, true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            // Skins: ids match SkinId in skins.ts; the page swaps the drawing and remembers the choice.
            let skins = [("black", "Black cat"), ("orange", "Orange cat"), ("tabby", "Tabby cat"), ("bunny", "Bunny")]
                .map(|(id, name)| MenuItem::with_id(app, format!("skin:{id}"), name, true, None::<&str>));
            let [a, b, c, d] = skins;
            let pet = Submenu::with_items(app, "Pet", true, &[&a?, &b?, &c?, &d?])?;
            let menu = Menu::with_items(app, &[&pet, &toggle, &snooze, &game, &quit])?;
            app.manage(PetMenu(menu.clone(), game));
            // Handles the right-click menu too: Tauri passes every menu event to this handler.
            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Taskbar Pet")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    id if id.starts_with("skin:") => {
                        let _ = app.emit("skin", &id[5..]);
                    }
                    // The tick flips itself; the page remembers it.
                    "game" => {
                        let on = app.state::<PetMenu>().1.is_checked().unwrap_or(true);
                        GAME_MODE.store(on, SeqCst);
                        let _ = app.emit("game-mode-setting", on);
                    }
                    "toggle" => {
                        if let Some(win) = app.get_webview_window("main") {
                            let hide = win.is_visible().unwrap_or(false);
                            USER_HIDDEN.store(hide, SeqCst);
                            let _ = if hide { win.hide() } else { win.show() };
                        }
                    }
                    // The front end calms the cat and holds reminders for an hour.
                    "snooze" => {
                        let _ = app.emit("snooze", ());
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            // The window is a transparent strip above the taskbar: let clicks through except over the hit areas.
            // Done here rather than in JS so the 10 Hz cursor check costs no IPC.
            let win = app.get_webview_window("main").unwrap();
            let handle = app.handle().clone();
            thread::spawn(move || {
                let mut ignoring = None;
                loop {
                    thread::sleep(Duration::from_millis(100));
                    let (Ok(c), Ok(pos), Ok(scale)) = (win.cursor_position(), win.outer_position(), win.scale_factor()) else {
                        continue;
                    };
                    let (x, y) = ((c.x - pos.x as f64) / scale, (c.y - pos.y as f64) / scale);
                    let over = handle.state::<HitAreas>().0.lock().unwrap().iter()
                        .any(|&[l, t, w, h]| x >= l && x <= l + w && y >= t && y <= t + h);
                    if ignoring != Some(!over) {
                        ignoring = Some(!over);
                        let _ = win.set_ignore_cursor_events(!over);
                    }
                }
            });

            // Game mode, checked every 2 s. The page hears about it too, to hold walks and nudges.
            let win = app.get_webview_window("main").unwrap();
            thread::spawn(move || {
                let mut was = false;
                loop {
                    thread::sleep(Duration::from_secs(2));
                    let now = GAME_MODE.load(SeqCst) && fullscreen_app();
                    if now == was {
                        continue;
                    }
                    was = now;
                    let _ = if now { win.hide() } else if !USER_HIDDEN.load(SeqCst) { win.show() } else { Ok(()) };
                    let _ = win.emit("game-mode", now);
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::covers;

    #[test]
    fn phrases_are_cut_at_pauses_and_clicks_are_dropped() {
        let mut p = super::Phrases::default();
        let (quiet, loud) = (vec![20i16; super::BLOCK], vec![4000i16; super::BLOCK]);
        let mut out = vec![];
        let blocks = [&quiet; 10].into_iter().chain([&loud; 5]).chain([&quiet; 10]) // a phrase
            .chain([&loud; 1]).chain([&quiet; 10]); // a click
        for b in blocks {
            out.extend(p.push(b));
        }
        out.extend(p.flush());
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].len(), (1 + 5 + 7) * super::BLOCK); // the block before, the speech, 0.7 s of quiet
    }

    // The whole mic path on two sentences spoken into a file by Windows' own voice (so no microphone is needed),
    // written down by the installed Whisper. Skipped if scripts/get-whisper.ps1 hasn't been run.
    #[cfg(windows)]
    #[test]
    fn dictation_writes_down_what_it_hears() {
        use std::sync::{mpsc, Mutex};
        use windows::{
            core::{w, Interface, HSTRING},
            Win32::{Media::Speech::*, System::Com::*},
        };
        let whisper = std::path::Path::new(&std::env::var("LOCALAPPDATA").unwrap()).join("com.tejal.taskbarpet\\whisper");
        if !whisper.join("bin\\whisper-server.exe").exists() {
            return eprintln!("skipped: Whisper isn't installed");
        }
        let wav = HSTRING::from(std::env::temp_dir().join("taskbar-pet-dictation-test.wav").as_os_str());
        let heard = Mutex::new(vec![]);
        unsafe {
            CoInitializeEx(None, COINIT_MULTITHREADED).ok().unwrap();
            let file: ISpStream = CoCreateInstance(&SpStream, None, CLSCTX_ALL).unwrap();
            file.BindToFile(&wav, SPFM_CREATE_ALWAYS, Some(&super::SPDFID_WAVEFORMATEX), Some(&super::PCM), 0).unwrap();
            let voice: ISpVoice = CoCreateInstance(&SpVoice, None, CLSCTX_ALL).unwrap();
            voice.SetOutput(&file, true).unwrap();
            let text = w!("Buy milk on the way home. <silence msec=\"1200\"/> Call Kevin about the meeting tomorrow.");
            voice.Speak(text, SPF_IS_XML.0 as u32, None).unwrap();
            file.Close().unwrap();

            let file: ISpStream = CoCreateInstance(&SpStream, None, CLSCTX_ALL).unwrap();
            file.BindToFile(&wav, SPFM_OPEN_READONLY, Some(&super::SPDFID_WAVEFORMATEX), Some(&super::PCM), 0).unwrap();
            let (_stop, stopped) = mpsc::channel();
            let finished = |t: String, done: bool| match done {
                true if !t.is_empty() => heard.lock().unwrap().push(t),
                _ => eprintln!("still hearing: {t}"),
            };
            super::dictate_from(&file.cast().unwrap(), &stopped, &whisper, finished, &|l| eprintln!("{l}")).unwrap();
        }
        let words = |s: &str| s.to_lowercase().replace(['.', ','], "");
        let heard = heard.into_inner().unwrap();
        assert_eq!(heard.iter().map(|s| words(s)).collect::<Vec<_>>(), ["buy milk on the way home", "call kevin about the meeting tomorrow"]);
    }

    #[test]
    fn fullscreen_means_covering_the_whole_screen() {
        let screen = [0, 0, 1920, 1080];
        assert!(covers([0, 0, 1920, 1080], screen)); // borderless fullscreen
        assert!(!covers([-8, -8, 1928, 1028], screen)); // maximised window: taskbar still showing
        assert!(!covers([100, 100, 900, 700], screen));
    }
}
