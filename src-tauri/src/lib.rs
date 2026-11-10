use serde_json::{json, Value};
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

// The tray menu, also shown when you right-click the pet, and its game mode, Claude and stay ticks.
struct PetMenu(Menu<Wry>, CheckMenuItem<Wry>, CheckMenuItem<Wry>, CheckMenuItem<Wry>);

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

// "Stay where I put it" is the page's to remember too; it sets the tick at start.
#[tauri::command]
fn set_stay(menu: tauri::State<PetMenu>, on: bool) {
    let _ = menu.3.set_checked(on);
}

// Dictation with Whisper (whisper.cpp, run on this laptop; scripts/get-whisper.ps1 puts it in the app's data
// folder). The mic is read through Windows' speech audio object (no permission prompt, no overlay) and cut into
// phrases at pauses; Whisper writes each one down in the background while listening goes on, and it goes to the
// page as a "dictation" event. On the GPU, the phrase you're still saying goes as "dictation-partial" events too
// (words that may still change). "dictation-end" (with an error message or null) when it stops: you pressed the
// mic again, a minute without a phrase, or a failure such as Whisper missing. (Windows' own recognisers were
// tried first: the online one heard speech here but returned no words, the offline one was mostly wrong.)
// `keep: false` stops without writing down anything still being heard (Esc). `hint`: words to expect, such as
// names from your to-dos, so Whisper spells them your way.
// (session number, how to stop the current session: true = keep what's been said)
#[derive(Default)]
struct Dictation(Mutex<(u64, Option<mpsc::Sender<bool>>)>);

#[tauri::command]
fn dictate(app: AppHandle, state: tauri::State<Dictation>, on: bool, keep: Option<bool>, hint: Option<String>) {
    let mut d = state.0.lock().unwrap();
    d.0 += 1;
    if let Some(stop) = d.1.take() {
        let _ = stop.send(keep.unwrap_or(true));
    }
    if !on {
        return;
    }
    let (stop_tx, stop_rx) = mpsc::channel();
    d.1 = Some(stop_tx);
    let session = d.0;
    thread::spawn(move || {
        let error = listen(&app, stop_rx, &hint.unwrap_or_default()).err();
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
fn listen(app: &AppHandle, stop: mpsc::Receiver<bool>, hint: &str) -> Result<(), String> {
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
            let done = dictate_from(&mic.cast()?, &stop, &data.join("whisper"), hint, heard, &log);
            let _ = mic.SetState(SPAS_CLOSED, 0);
            Ok(done)
        }
    };
    run().map_err(|e| e.message()).and_then(|done| done).inspect_err(|e| log(format!("error: {e}")))
}

#[cfg(not(windows))]
fn listen(_: &AppHandle, _: mpsc::Receiver<bool>, _: &str) -> Result<(), String> {
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
// Whisper gets `hint` and the phrase before as context. Text starting with a line break begins a new paragraph:
// a long pause after a finished sentence. Stopped with `false` (Esc), nothing more goes to `heard`.
#[cfg(windows)]
fn dictate_from(
    input: &windows::Win32::System::Com::ISequentialStream,
    stop: &mpsc::Receiver<bool>,
    whisper: &std::path::Path,
    hint: &str,
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
    let cancelled = &AtomicBool::new(false);
    thread::scope(|s| {
        let (phrases_tx, phrases_rx) = mpsc::channel::<(Vec<i16>, bool, bool)>();
        let worker = s.spawn(move || -> Result<(), String> {
            let t = Instant::now();
            let whisper = Server::start(&exe, &model)?;
            log(format!("whisper loaded, {} ms", t.elapsed().as_millis()));
            let mut previous = String::new(); // the last phrase written down
            for (phrase, done, long_pause) in phrases_rx {
                let t = Instant::now();
                match whisper.transcribe(&phrase, !on_gpu, &format!("{hint} {previous}")) {
                    Ok(text) => {
                        let paragraph = long_pause && previous.ends_with(['.', '?', '!']) && !text.is_empty();
                        let text = if paragraph { format!("\n{text}") } else { text };
                        if done {
                            log(format!("{:.1} s of speech, {} ms: {text}", phrase.len() as f32 / RATE as f32, t.elapsed().as_millis()));
                            previous = text.trim().into();
                        }
                        if !cancelled.load(SeqCst) {
                            heard(text, done);
                        }
                    }
                    Err(e) => log(format!("whisper failed: {e}")),
                }
                pending.fetch_sub(1, SeqCst);
            }
            Ok(())
        });
        let send = move |phrase, done, long_pause| {
            pending.fetch_add(1, SeqCst);
            let _ = phrases_tx.send((phrase, done, long_pause));
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
                send(phrase, true, phrases.long_pause);
            } else if on_gpu && pending.load(SeqCst) == 0 && phrases.loud >= 3 && phrases.quiet == 0 && phrases.phrase.len() >= sent + 3 * BLOCK {
                // the phrase so far, so words show while you talk (only when Whisper is idle, so the
                // finished phrase never waits behind more than one of these)
                sent = phrases.phrase.len();
                send(phrases.phrase.clone(), false, phrases.long_pause);
            }
            if worker.is_finished() {
                break; // Whisper didn't start
            }
            match stop.try_recv() {
                Err(mpsc::TryRecvError::Empty) => {}
                Ok(false) => {
                    log("cancelled with Esc".into());
                    cancelled.store(true, SeqCst);
                    break;
                }
                _ => {
                    log("stopped by the mic button".into());
                    break;
                }
            }
            if last.elapsed() > Duration::from_secs(60) {
                log("a minute without a phrase".into());
                break;
            }
        }
        if let Some(phrase) = phrases.flush().filter(|_| !cancelled.load(SeqCst)) {
            send(phrase, true, phrases.long_pause); // what you said just before pressing stop
        }
        drop(send); // lets Whisper finish what's sent and stop
        worker.join().map_err(|_| "Whisper's thread crashed".to_string())?
    })
}

// Cuts 100 ms blocks of audio into phrases: from the block before the first loud one to 0.7 s of quiet after the
// last (or 25 s, inside Whisper's 30 s window). Loud = well above the background level, which follows quiet
// drops at once and rises only slowly, so talking doesn't raise it. A phrase with under 0.3 s of loud audio is
// dropped as a click or a bump: Whisper tends to find words in noise. `long_pause`: the phrase came after 2 s
// or more of quiet beyond that 0.7 s, so it may start a new paragraph.
#[derive(Default)]
struct Phrases {
    floor: f32,
    before: Vec<i16>,
    phrase: Vec<i16>,
    loud: u32,
    quiet: u32,
    pause: u32, // quiet blocks since the last phrase
    long_pause: bool,
}

impl Phrases {
    fn push(&mut self, block: &[i16]) -> Option<Vec<i16>> {
        let rms = (block.iter().map(|&s| (s as f32).powi(2)).sum::<f32>() / block.len().max(1) as f32).sqrt();
        let loud = rms > self.floor * 3.0 + 150.0;
        self.floor = if rms < self.floor || self.floor == 0.0 { rms } else { self.floor * 0.995 + rms * 0.005 };
        if self.phrase.is_empty() && !loud {
            self.before = block.to_vec();
            self.pause += 1;
            return None;
        }
        if self.phrase.is_empty() {
            self.phrase = std::mem::take(&mut self.before);
            (self.long_pause, self.pause) = (self.pause >= 20, 0);
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
    // repeats itself with a cut window, and the full one costs ~0.15 s more there. `prompt` is text Whisper takes
    // as coming just before, so names in it come out spelled that way. Lines like "[BLANK_AUDIO]" or "(wind)" are
    // Whisper describing noise, not words.
    fn transcribe(&self, phrase: &[i16], shorten: bool, prompt: &str) -> Result<String, String> {
        const B: &str = "taskbar-pet-phrase"; // form boundary
        let context = if shorten { ((phrase.len() / RATE + 1) * 50).clamp(300, 1500) } else { 0 }; // 1500 = 30 s, 0 = all
        let field = |name: &str, value: &str| format!("--{B}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n");
        let mut form = [field("response_format", "text"), field("audio_ctx", &context.to_string()), field("prompt", prompt.trim())]
            .concat()
            .into_bytes();
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

// Claude link. There's no way to link to a Claude account, so this goes through Claude Code on this laptop: hooks
// in its settings run the pet with CLAUDE_FLAG and the event on stdin, and that process passes the signal on to the
// running pet by starting itself again with CLAUDE_SIGNAL (single-instance forwards the arguments).
const CLAUDE_FLAG: &str = "--claude-hook";
const CLAUDE_SIGNAL: &str = "--claude-signal";
// (event, matcher). A prompt fires PermissionRequest at once, and the Notification about 6 s later if unanswered.
const CLAUDE_HOOKS: [(&str, &str); 9] = [
    ("PermissionRequest", ""),
    ("PreToolUse", "AskUserQuestion|ExitPlanMode"),
    ("Notification", "permission_prompt|elicitation_dialog|elicitation_url_dialog|agent_needs_input"),
    ("PostToolUse", ""),
    ("PostToolUseFailure", ""),
    ("PermissionDenied", ""),
    ("Stop", ""),
    ("UserPromptSubmit", ""),
    ("SessionEnd", ""),
];

fn claude_hook() {
    use std::io::Read;
    let mut input = String::new();
    let _ = std::io::stdin().read_to_string(&mut input);
    let signal = serde_json::from_str(&input).ok().and_then(|event| claude_signal(&event));
    if let (Some(signal), Ok(exe)) = (signal, std::env::current_exe()) {
        let _ = std::process::Command::new(exe).arg(CLAUDE_SIGNAL).args(signal).status();
    }
}

// What a hook event means for the pet: [kind, session, tool], explained in claude.ts. In the desktop app a closing
// question can also be the next-step box (its wrap_up tool's `ask`) rather than the end of the reply.
fn claude_signal(event: &Value) -> Option<Vec<String>> {
    let text = |key: &str| event[key].as_str().unwrap_or_default();
    let tool = text("tool_name");
    let asks = text("last_assistant_message")
        .lines()
        .rev()
        .filter(|line| !line.trim().is_empty())
        .take(2)
        .any(|line| line.trim_end().trim_end_matches(['*', '_']).ends_with('?'));
    let (kind, tool) = match text("hook_event_name") {
        "PermissionRequest" | "PreToolUse" => ("up", tool),
        "Notification" => ("up", ""),
        "PostToolUse" if tool.ends_with("wrap_up") && event["tool_input"]["ask"].as_str().is_some_and(|a| !a.is_empty()) => ("up", "asked"),
        "PostToolUse" | "PostToolUseFailure" | "PermissionDenied" => ("down", tool),
        "Stop" if asks => ("up", "asked"),
        "Stop" => ("stop", ""),
        "UserPromptSubmit" | "SessionEnd" => ("clear", ""),
        _ => return None,
    };
    let args = [kind, text("session_id"), tool];
    Some(args.iter().filter(|arg| !arg.is_empty()).map(|arg| arg.to_string()).collect())
}

// Adds the pet's hooks to Claude Code's settings or takes them out, leaving everything else as it was.
fn set_claude_hooks(settings: &mut Value, exe: &str, on: bool) -> Result<(), String> {
    let root = settings.as_object_mut().ok_or("its settings aren't a JSON object")?;
    let events = root.entry("hooks").or_insert_with(|| json!({})).as_object_mut().ok_or("its hooks aren't a JSON object")?;
    events.retain(|_, entries| match entries.as_array_mut() {
        Some(list) => {
            list.retain(|entry| !entry.to_string().contains(CLAUDE_FLAG));
            !list.is_empty()
        }
        None => true,
    });
    if on {
        for (event, matcher) in CLAUDE_HOOKS {
            let hook = json!({ "type": "command", "async": true, "command": exe, "args": [CLAUDE_FLAG] });
            let entry = if matcher.is_empty() { json!({ "hooks": [hook] }) } else { json!({ "matcher": matcher, "hooks": [hook] }) };
            events.entry(event).or_insert_with(|| json!([])).as_array_mut().ok_or("its hooks aren't lists")?.push(entry);
        }
    }
    if events.is_empty() {
        root.shift_remove("hooks");
    }
    Ok(())
}

fn claude_settings(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(app.path().home_dir().map_err(|e| e.to_string())?.join(".claude").join("settings.json"))
}

// A settings file that can't be read is left alone. Written to one side first, so it's never half-written.
fn link_claude(app: &AppHandle, on: bool) -> Result<(), String> {
    let path = claude_settings(app)?;
    let text = match std::fs::read_to_string(&path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => "{}".to_string(),
        read => read.map_err(|e| e.to_string())?,
    };
    let mut settings = serde_json::from_str(&text).map_err(|e| format!("its settings file has a problem: {e}"))?;
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    set_claude_hooks(&mut settings, &exe.to_string_lossy(), on)?;
    let temp = path.with_extension("json.pet");
    let pretty = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    std::fs::write(&temp, pretty + "\n").and_then(|_| std::fs::rename(&temp, &path)).map_err(|e| e.to_string())
}

// A small meow, made here so there's no recording to ship: a kitten-high voice (f0) that goes up fast and comes down
// slowly, while the mouth (its resonances, f1 and f2) goes ee-ah-oo.
fn meow() -> Vec<i16> {
    use std::f32::consts::{PI, TAU};
    let n = RATE * 6 / 10;
    let mut phase = 0.0f32;
    let sound: Vec<f32> = (0..n)
        .map(|i| {
            let t = i as f32 / n as f32;
            let up = (PI * t.powf(0.7)).sin();
            let f0 = 750.0 + 450.0 * up - 150.0 * t + 15.0 * (TAU * 3.6 * t).sin();
            phase += TAU * f0 / RATE as f32;
            let (f1, f2) = (600.0 + 800.0 * up, 3000.0 - 2000.0 * t);
            let resonance = |f: f32, at: f32, width: f32| 1.0 / (1.0 + ((f - at) / width).powi(2));
            let harmonics: f32 = (1..=6)
                .map(|h| {
                    let f = h as f32 * f0;
                    (resonance(f, f1, 400.0) + 0.6 * resonance(f, f2, 500.0)) * (phase * h as f32).sin() / h as f32
                })
                .sum();
            harmonics * (t / 0.1).min(1.0) * ((1.0 - t) / 0.3).min(1.0)
        })
        .collect();
    let peak = sound.iter().fold(0.0f32, |p, s| p.max(s.abs()));
    sound.iter().map(|s| (s / peak * 0.35 * i16::MAX as f32) as i16).collect()
}

#[tauri::command]
fn play_meow() {
    #[cfg(windows)]
    thread::spawn(|| unsafe {
        use windows::{core::PCWSTR, Win32::Media::Audio::*};
        let wav = wav_bytes(&meow());
        let _ = PlaySoundW(PCWSTR(wav.as_ptr().cast()), None, SND_MEMORY | SND_SYNC | SND_NODEFAULT);
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    if std::env::args().nth(1).as_deref() == Some(CLAUDE_FLAG) {
        return claude_hook();
    }
    tauri::Builder::default()
        // Opening it again (Start menu, Startup) shows the pet that's already running instead of a second one.
        .plugin(tauri_plugin_single_instance::init(|app, args, _| {
            if let Some(at) = args.iter().position(|arg| arg == CLAUDE_SIGNAL) {
                let _ = app.emit("claude", &args[at + 1..]);
            } else if let Some(win) = app.get_webview_window("main") {
                USER_HIDDEN.store(false, SeqCst);
                let _ = win.show();
            }
        }))
        // A signal from Claude with no pet running to hear it: stop before any window opens.
        .plugin(
            tauri::plugin::Builder::<Wry, ()>::new("claude-signal")
                .setup(|_, _| {
                    if std::env::args().any(|arg| arg == CLAUDE_SIGNAL) {
                        std::process::exit(0);
                    }
                    Ok(())
                })
                .build(),
        )
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_notification::init())
        .manage(HitAreas::default())
        .manage(WalkId::default())
        .manage(Dictation::default())
        .invoke_handler(tauri::generate_handler![
            set_hit_areas, walk_to, halt, drag, pet_menu, set_game_mode, set_stay, dictate, idle_ms, play_meow
        ])
        .setup(|app| {
            let toggle = MenuItem::with_id(app, "toggle", "Hide / show pet", true, None::<&str>)?;
            let snooze = MenuItem::with_id(app, "snooze", "Snooze 1 hour", true, None::<&str>)?;
            let game = CheckMenuItem::with_id(app, "game", "Hide during games / fullscreen", true, true, None::<&str>)?;
            // Ticked if the pet's hooks are in Claude's settings: that file is what really decides.
            let linked = claude_settings(app.handle()).is_ok_and(|path| std::fs::read_to_string(path).is_ok_and(|s| s.contains(CLAUDE_FLAG)));
            let claude = CheckMenuItem::with_id(app, "claude", "Link to Claude", true, linked, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            // Skins: ids match SkinId in skins.ts; the page swaps the drawing and remembers the choice.
            let skins = [
                ("black", "Black cat"), ("orange", "Orange cat"), ("tabby", "Tabby cat"), ("bunny", "Bunny"),
                ("ink", "Ink cat"), ("doodle", "Doodle cat"), ("lcd", "Tamagotchi"),
            ]
            .map(|(id, name)| MenuItem::with_id(app, format!("skin:{id}"), name, true, None::<&str>));
            let [a, b, c, d, e, f, g] = skins;
            let pet = Submenu::with_items(app, "Pet", true, &[&a?, &b?, &c?, &d?, &e?, &f?, &g?])?;
            let stay = CheckMenuItem::with_id(app, "stay", "Stay where I put it", true, false, None::<&str>)?;
            let menu = Menu::with_items(app, &[&pet, &toggle, &snooze, &stay, &game, &claude, &quit])?;
            app.manage(PetMenu(menu.clone(), game, claude, stay));
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
                    "stay" => {
                        let _ = app.emit("stay-setting", app.state::<PetMenu>().3.is_checked().unwrap_or(false));
                    }
                    // The tick has already flipped itself; if the settings couldn't be changed, it flips back.
                    "claude" => {
                        let tick = &app.state::<PetMenu>().2;
                        let on = tick.is_checked().unwrap_or(false);
                        let note = match link_claude(app, on) {
                            Ok(()) if on => "Linked! My hand goes up when Claude needs you".to_string(),
                            Ok(()) => "Unlinked from Claude".to_string(),
                            Err(e) => {
                                let _ = tick.set_checked(!on);
                                format!("Couldn't change the link to Claude: {e}")
                            }
                        };
                        let _ = app.emit("claude-link", note);
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
    use serde_json::json;

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
            let text = w!("Buy milk on the way home. <silence msec=\"3000\"/> Call Kevin about the meeting tomorrow.");
            voice.Speak(text, SPF_IS_XML.0 as u32, None).unwrap();
            file.Close().unwrap();

            let file: ISpStream = CoCreateInstance(&SpStream, None, CLSCTX_ALL).unwrap();
            file.BindToFile(&wav, SPFM_OPEN_READONLY, Some(&super::SPDFID_WAVEFORMATEX), Some(&super::PCM), 0).unwrap();
            let (_stop, stopped) = mpsc::channel();
            let finished = |t: String, done: bool| match done {
                true if !t.is_empty() => heard.lock().unwrap().push(t),
                _ => eprintln!("still hearing: {t}"),
            };
            super::dictate_from(&file.cast().unwrap(), &stopped, &whisper, "Coffee with Kevin.", finished, &|l| eprintln!("{l}")).unwrap();
        }
        let words = |s: &str| s.to_lowercase().replace(['.', ','], "");
        let heard = heard.into_inner().unwrap();
        // the 3 s pause after a finished sentence starts a new paragraph
        assert_eq!(heard.iter().map(|s| words(s)).collect::<Vec<_>>(), ["buy milk on the way home", "\ncall kevin about the meeting tomorrow"]);
    }

    #[test]
    fn the_meow_is_high_and_small_and_goes_up_then_down() {
        let meow = super::meow();
        assert_eq!(meow.len(), super::RATE * 6 / 10);
        assert_eq!(meow.iter().map(|s| s.abs()).max().unwrap(), (0.35 * i16::MAX as f32) as i16); // far from full volume
        assert!(meow[0].abs() < 50 && meow[meow.len() - 1].abs() < 50); // no click at either end
        // The pitch where a stretch of it best matches itself shifted along.
        let pitch = |at: f32| {
            let part = &meow[(at * meow.len() as f32) as usize..][..800];
            let matches = |lag: usize| part.iter().zip(&part[lag..]).map(|(&a, &b)| a as i64 * b as i64).sum::<i64>();
            super::RATE as f32 / (10..40).max_by_key(|&lag| matches(lag)).unwrap() as f32
        };
        assert!(pitch(0.3) > 1000.0, "peak {}", pitch(0.3));
        assert!(pitch(0.05) < pitch(0.3) && pitch(0.8) < pitch(0.3));
    }

    #[test]
    fn claude_hook_events_become_signals() {
        let signal = |event: serde_json::Value| super::claude_signal(&event).map(|args| args.join(" "));
        let tool = |event: &str, tool: &str| signal(json!({ "hook_event_name": event, "session_id": "s", "tool_name": tool }));
        assert_eq!(tool("PermissionRequest", "Bash").unwrap(), "up s Bash");
        assert_eq!(tool("PreToolUse", "AskUserQuestion").unwrap(), "up s AskUserQuestion");
        assert_eq!(tool("PostToolUse", "Bash").unwrap(), "down s Bash");
        assert_eq!(tool("UserPromptSubmit", "").unwrap(), "clear s");
        assert_eq!(tool("SubagentStart", ""), None);
        let notified = signal(json!({ "hook_event_name": "Notification", "session_id": "s", "notification_type": "permission_prompt" }));
        assert_eq!(notified.unwrap(), "up s");
        let stop = |last: &str| signal(json!({ "hook_event_name": "Stop", "session_id": "s", "last_assistant_message": last })).unwrap();
        assert_eq!(stop("All done."), "stop s");
        assert_eq!(stop("Should I push it?"), "up s asked");
        assert_eq!(stop("**Should I push it?**\n\nI didn't run the tests.\n"), "up s asked");
        assert_eq!(stop("Is it fast? Yes.\n\nFirst.\n\nSecond."), "stop s");
        let box_with = |input: serde_json::Value| {
            signal(json!({ "hook_event_name": "PostToolUse", "session_id": "s", "tool_name": "mcp__ccd_turn__wrap_up", "tool_input": input })).unwrap()
        };
        assert_eq!(box_with(json!({ "recap": "Done.", "ask": "Push it?" })), "up s asked");
        assert_eq!(box_with(json!({ "recap": "Done." })), "down s mcp__ccd_turn__wrap_up");
    }

    #[test]
    fn linking_claude_leaves_everything_else_alone() {
        let original = json!({ "zeta": 1, "hooks": { "Stop": [{ "hooks": [{ "type": "command", "command": "mine" }] }] }, "alpha": { "b": [1] } });
        let mut settings = original.clone();
        super::set_claude_hooks(&mut settings, "C:\\Pet\\pet.exe", true).unwrap();
        assert_eq!(settings["hooks"]["Stop"].as_array().unwrap().len(), 2);
        assert_eq!(settings["hooks"]["PostToolUse"][0]["hooks"][0]["command"], "C:\\Pet\\pet.exe");
        assert_eq!(settings["hooks"]["PreToolUse"][0]["matcher"], "AskUserQuestion|ExitPlanMode");
        super::set_claude_hooks(&mut settings, "C:\\Pet\\pet.exe", true).unwrap(); // not twice
        assert_eq!(settings["hooks"]["PostToolUse"].as_array().unwrap().len(), 1);
        super::set_claude_hooks(&mut settings, "C:\\Pet\\pet.exe", false).unwrap();
        assert_eq!(settings.to_string(), original.to_string()); // same keys, same order

        let mut none = json!({ "theme": "auto" });
        super::set_claude_hooks(&mut none, "pet.exe", true).unwrap();
        super::set_claude_hooks(&mut none, "pet.exe", false).unwrap();
        assert_eq!(none, json!({ "theme": "auto" }));
        assert!(super::set_claude_hooks(&mut json!([]), "pet.exe", true).is_err());
    }

    #[test]
    fn a_long_pause_is_marked() {
        let mut p = super::Phrases::default();
        let (quiet, loud) = (vec![20i16; super::BLOCK], vec![4000i16; super::BLOCK]);
        let mut say = |pause: usize| {
            [&quiet].repeat(pause).into_iter().chain([&loud; 5]).chain([&quiet; 7]).for_each(|b| drop(p.push(b)));
            p.long_pause
        };
        assert!(!say(5));
        assert!(!say(19));
        assert!(say(20)); // 2 s beyond the 0.7 s that ends a phrase
    }

    #[test]
    fn fullscreen_means_covering_the_whole_screen() {
        let screen = [0, 0, 1920, 1080];
        assert!(covers([0, 0, 1920, 1080], screen)); // borderless fullscreen
        assert!(!covers([-8, -8, 1928, 1028], screen)); // maximised window: taskbar still showing
        assert!(!covers([100, 100, 900, 700], screen));
    }
}
