# Rush Music Studio 1.1

An offline, open-source music studio. It combines a loop-based multitrack arranger, a sample-accurate audio editor, a real-time four-stem separator and a mixer in one app. No licence key, no account and no internet connection are needed. Written from scratch and released under the MIT licence.

## Download

Go to **Releases** (right side of this page) and download:
- **Windows:** the installer `RushMusicStudio-…-win-x64.exe`, or `RushMusicStudio-…-portable.exe` to run without installing.
- **Mac:** the `.dmg`. The app isn't code-signed, so right-click it and choose Open the first time.
- **Linux:** the `.AppImage` or the `.deb`.
- **Any computer:** `RushMusicStudio.html`. Open it in Chrome or Edge and it works fully offline.

Every push to `main` builds all versions automatically (see the **Actions** tab). Pushing a tag such as `v1.2.0` publishes a new release.

## Run it

**Build it yourself:**
1. `python build.py` creates `dist/RushMusicStudio.html`.
2. Copy that file into `desktop/app/`.
3. In `desktop/`, run `npm install`, then `npm run dist`. The installers land in `desktop/release/`.

## What's inside

**Plugins (Ctrl+K)**
- 20 original real-time effects, each with factory presets and your own saved presets.
  - EQ & Filter: Parametric EQ, 10-band Graphic EQ, Auto filter, Wah-wah.
  - Dynamics: Compressor, Loudness maximizer, Noise gate.
  - Reverb & Delay: Reverb, Simple delay (tempo-sync, ping-pong), Multi-tap delay.
  - Modulation: Chorus, Flanger, Phaser, Tremolo/auto-pan, Vibrato.
  - Distortion: Distortion, Bit crusher, Smooth/enhance.
  - Stereo & Utility: Pan/expand, Volume/phase.
- **Plug-in Chainer:** build chains with bypass and reordering.
  - Live on any track or the master: use the FX buttons in Arrange and Mixer.
  - Or applied permanently in the Editor, with preview.

**Arrange (key 1)**
- Unlimited tracks with drag-and-drop clips.
- Volume and pan envelopes: track menu → Show volume envelope. Click the line to add a point, drag to move it, right-click to delete it.
- Timeline markers: Shift+M inserts one. Use , and . to jump between markers.
- Per-track transpose of ±12 semitones, keeping tempo.
- Loops follow the project tempo automatically. Pitch is kept, using WSOLA time-stretch.
- Trim, loop-extend, split (S), duplicate (Ctrl+D), Alt-drag to copy, and clip fades with gain.
- Snap grid, loop region, metronome, tap tempo and recording from your microphone.
- Undo/redo for every change.

**Editor (key 2)**
- Zoom from the whole file down to single samples.
- Markers (M) and regions (R), with a Markers & regions list. Export every region as its own WAV file.
- Auto trim/crop, resample, and a bit-depth converter with dither (rectangular, TPDF, noise-shaped).
- Generator: sine, square, saw, triangle, white/pink noise, sweep, DTMF and silence.
- Cut/copy/paste, mix-paste, trim, silence and insert silence.
- Normalize (peak or RMS), volume, fades, reverse, invert and DC removal.
- Time-stretch and pitch-shift.
- Noise reduction from a captured noise profile, and a noise gate.
- Graphic EQ, compressor, reverb, tempo-synced echo, chorus and saturation, all with preview.
- Spectrogram view, live and selection spectrum analyser, and peak/RMS/DC statistics.
- Export WAV at 16-bit, 24-bit or 32-bit float.

**Stems (key 3)**
- Splits any song into vocals, melody, bass and drums using every CPU core. Typically 10–40× faster than real time.
- Instant mode plays a live filter-based split while the HQ pass runs, then switches over seamlessly.
- Stem pads (Z X C V) and stem faders, plus Acapella, Instrumental, Drums only and No drums presets.
- Filter sweep, vocal echo, ±8% tempo, cue point and scrubbing.
- Send stems to Arrange, export them as WAV, or open one in the Editor.

**Mixer (key 4)**
- Per-track 3-band EQ, compressor, pan, reverb and echo sends, mute/solo and meters.
- Master EQ, brick-wall limiter and stereo meters.

**Loop Lab**
- Generates tempo-exact loops offline in any key, in Afrobeat, Amapiano, House, Hip-Hop, Trap, Techno and Dancehall styles.
- Parts: drums, bass, chords, percussion or a full groove.

**Analysis**
- Automatic BPM and key detection, with Camelot codes for harmonic mixing.

**Projects**
- `.rush` project files store all audio losslessly.
- Crash-recovery autosave keeps your session in the browser's local storage.
- The mix renders faster than real time to WAV.

## How the stem separator works

Rush uses classic signal processing rather than a neural network:
- Harmonic/percussive separation by median filtering of the spectrogram.
- Stereo-centre analysis, with vocals usually panned centre.
- Frequency-band masking. Bass is kept below about 250 Hz.

The masks always sum to one, so the four stems add back up to the original exactly. Results are very good for drums and bass, and good for vocals on stereo mixes. A neural-network separator (Demucs-class) gives cleaner vocals, but it needs a large model file and much more CPU. The `separate()` function in `src/worker.js` is the place to plug one in.

## Build from source

`src/` contains the readable modules. `python3 build.py` bundles them into `dist/RushMusicStudio.html`.

| File | Purpose |
|---|---|
| `src/fft.js` | FFT |
| `src/plugins.js` | Plugin rack |
| `src/chainer.js` | Plug-in Chainer UI |
| `src/worker.js` | DSP thread: stems, tempo/key, stretch, denoise, spectrogram |
| `src/engine.js` | Audio engine, project model, save/load |
| `src/arrange.js` | Arranger view |
| `src/editor.js` | Editor view |
| `src/stems.js` | Stems deck |
| `src/mixer.js` | Mixer view |
| `src/looplab.js` | Loop Lab |
| `src/main.js` | App shell |

## Keyboard

| Keys | Action |
|---|---|
| Space | Play/pause |
| Home | Go to start |
| R | Record |
| L | Loop |
| M | Metronome |
| 1–4 | Switch view |
| Ctrl+S / Ctrl+O | Save / open project |
| Ctrl+I | Import audio |
| Ctrl+E | Export mix |
| Ctrl+Z / Ctrl+Y | Undo / redo |
| Ctrl+K | Effects (Plug-in Chainer) |
| Shift+M | Insert marker (Arrange) |
| M / R | Marker / region (Editor) |
| + / − | Zoom |
