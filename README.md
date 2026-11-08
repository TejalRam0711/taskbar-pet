# Taskbar Pet

A small black cat with big golden eyes that lives on top of the Windows taskbar and keeps track of what's due.
It reads `Documents/Pet/pet-tasks.json` (format: `pet-tasks.example.json`).

- Left alone it sleeps (with a "z z z" thought bubble), and now and then strolls along the taskbar, plays with a ball of yarn or sits up and looks around.
- Hover: the next due item. Click: it gets up, sits and tells you what's next in a speech bubble, with the next 5 items. Close it (click again or Esc) and it lies back down.
- Each item has a stage: Starting → Thinking → In progress → Finished. Finished takes it off the list.
- Notes: switch the bubble to Notes and the cat puts on glasses, a shirt and tie and writes along. The menu lists
  your notes (newest first); + starts one; it saves as you type and on Save; clear a note and save to delete it.
  Stored in `Documents/Pet/pet-notes.json`.
- Mic (in a note): press it, it turns green, talk, and your words show as you say them (on the GPU; they can
  still change), each sentence settling a moment after you pause. A pause of about 3 s after a finished sentence
  starts a new line; Esc stops and throws away what's still being written. Whisper is told your to-do titles and
  the note so far, so names come out spelled your way. Whisper (whisper.cpp) does the writing, on this laptop: no key, no overlay, no
  internet. Install it once with `powershell -ExecutionPolicy Bypass -File .\scripts\get-whisper.ps1` (checksums
  verified) into `%LOCALAPPDATA%\com.tejal.taskbarpet\whisper`. With an NVIDIA GPU it uses the CUDA build and the
  large-v3-turbo model instead, once NVIDIA's `cublas64_11.dll` and `cublasLt64_11.dll` (CUDA 11.8 cuBLAS) are in
  its `bin-cuda` folder; without them that build silently runs on the CPU, too slowly for the large model.
  Whisper's server runs only while the mic is on (model loaded once, ~1 s; then ~0.25 s per phrase on the GPU),
  answers on 127.0.0.1 only, and closes with the mic or the pet, so the pet's memory is unchanged otherwise. Stops when you press the mic again or after a
  minute without a phrase; each session's steps go to `mic.log` in the same folder. (Windows' own recognisers
  were tried first: the online one returned nothing on this laptop, the offline one was mostly wrong.)
- It stays awake when something is due within 24 h, and hops with a red "!" within 1 h or when overdue.
- Focus: a 25 or 50 min session; the cat works at its desk (a countdown chip sits beside it), then naps through
  a 5 or 10 min break. Notifications at the end of each part; a session survives a restart.
- Drop to save: drag text or a link over the cat and it gets up on tiptoe, grabbing at it; drop it and the cat
  hugs it to its chest, and it becomes a note. Files are saved by name only
  (web views don't get file paths).
- Stretch nudges: after an hour of use with no 5-minute break, the cat sits up and suggests a stretch, water or
  resting your eyes. Not during a focus session; held until a game ends.
- Game mode: hides while anything is fullscreen on the main screen (games, presentations, F11 video), then comes
  back, unless you hid it from the menu. Switch it off with "Hide during games / fullscreen" in the menu.
- Pick it up: drag the pet and it lifts off the taskbar and dangles from your cursor; let go and it drops back
  down there. It stays where you put it, wandering only a little either side.
- Desktop notifications at each task's `remind` offsets (`30m`, `1h`, `1d`, `1w`).
- Claude: tick "Link to Claude" in the menu and the cat puts its hands up, says "Input needed" in its bubble and
  gives a small meow whenever Claude is waiting on you: a permission prompt, a question, a plan to approve, or a reply
  that ends in a question. Each session counts on its own; the hand comes down when you've answered, or click the
  cat for "got it". No meow while it's hidden or snoozed or the mic is on, and at most once in 20 s; after a game,
  it meows if something is still waiting. There's no way to link to a Claude account, so the tick adds hooks to
  Claude Code's `~/.claude/settings.json` (unticking removes them, nothing else there changes): it covers Claude
  Code on this laptop (terminal, desktop app, IDEs), not claude.ai chats or cloud sessions. Untick it before deleting
  the pet, or Claude Code will keep trying to run it.
- Menu (right-click the pet, or the tray icon, which Windows 11 tucks under the ^ at first): Pet (Black cat,
  Orange cat, Tabby cat, Bunny; remembered), hide/show, snooze 1 hour, game mode, Link to Claude, quit.
  Every pet uses the same skeleton and animations; a skin in `src/skins.ts` only changes shapes and markings,
  and its colours are a `.skin-<id>` block in `src/styles.css`. The bunny hops instead of walking.

## Adding to-dos

- On the cat: click it, type in "Add a to-do…", pick the date and time, press Enter or +.
- Through Claude: mention it in chat ("coffee with Sam on the 16th, 10am") and Claude adds it to the file.
- By hand: add an entry to `pet-tasks.json`; the cat picks up changes within a second.

```json
{ "id": "sam-coffee", "title": "Coffee with Sam", "due": "2026-11-16T10:00:00Z",
  "remind": ["1d", "1h"], "stage": "starting", "done": false }
```

`stage` is one of `starting`, `thinking`, `in-progress`, `finished`; `done` mirrors `finished` for older readers.

## Run

```
npm install
npm run tauri dev                  # dev, with reload
npm run tauri build -- --no-bundle # release exe in src-tauri/target/release
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1  # copy it to %LOCALAPPDATA%\Programs\Taskbar Pet,
                                   # add "Taskbar Pet" to the Start menu and Startup, and start it
npm test                           # due-date and stage logic
```

Only one pet runs at a time: opening it again (Start menu) brings back the running one, even if hidden. To stop
it starting with Windows, switch it off in Task Manager › Startup apps.

Needs Rust and the Visual Studio C++ Build Tools (see https://tauri.app/start/prerequisites/).

## Art and cost

The cat is SVG in `src/cat.ts`, animated by `src/styles.css`. Long-lived poses (sleep, awake) change on a
2.5 fps tick instead of CSS animations so the page only repaints when the pose changes, and the click-through
hit test runs in Rust (`src-tauri/src/lib.rs`). WebView2 flags in `tauri.conf.json` (`additionalBrowserArgs`)
fold the GPU process into the browser process. App icon: `npx tauri icon app-icon.svg`.
