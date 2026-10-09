# Rush Music Studio 1.5

An offline, open-source music studio. It combines a loop-based multitrack arranger, a sample-accurate audio editor, a real-time four-stem separator and a mixer in one app. No licence key, no account and no internet connection are needed. Written from scratch and released under the MIT licence.

## Download

Go to **Releases** (right side of this page) and download:
- **Windows:** the installer `RushMusicStudio-…-win-x64.exe`, or `RushMusicStudio-…-portable.exe` to run without installing.
- **Mac:** the `.dmg`. The app isn't code-signed, so right-click it and choose Open the first time.
- **Linux:** the `.AppImage` or the `.deb`.
- **Any computer:** `RushMusicStudio.html`. Open it in Chrome or Edge and it works fully offline.

Every push to `main` builds all versions automatically (see the **Actions** tab) and publishes them as the release named after the `version` in `desktop/package.json`. Bump that number to start a new release.

## Run it

**Build it yourself:**
1. `python build.py` creates `dist/RushMusicStudio.html`.
2. Copy that file into `desktop/app/`.
3. In `desktop/`, run `npm install`, then `npm run dist`. The installers land in `desktop/release/`.

## What's inside

**New in 1.5: studio-quality AI stems, Rush's own engine**
- **Rush runs the network itself.** HTDemucs v4 (Meta, MIT), the hybrid transformer separator behind most professional stem tools, now runs in an engine written for Rush, with no third-party runtime:
  - **On the graphics card (WebGPU).** This is the fastest way.
  - **On every CPU core (WebAssembly SIMD, with fused multiply-add where the processor supports it).** This is used when there is no usable graphics card.

  CI checks on every build that it computes the same network as an independent NumPy implementation of the PyTorch reference (agreement better than 70 dB).
- **Official weights, verified.** The installers carry Meta's original checkpoint (`955717e8-8726e21a.th`, sha256-checked), converted losslessly to fp16 by `tools/htdemucs_to_rsm.py`.
- **Instant, then AI.** A song on the Stems deck plays at once with the real-time split.
  - The AI starts at the playhead, and each finished stretch switches to AI stems by itself.
  - Seeking moves the AI to where you are.
  - With several CPU cores, several windows are separated at the same time.
- **Pre-analysis.** Songs you import or add from the Explorer get their AI stems prepared in the background, one at a time.
  - The stems are kept on your computer, so the next time you load a song they are there instantly, even in a new session.
  - In the Media list, an “AI prep %” tag shows a song being prepared and an “AI stems” tag shows a song that is ready.
- **Ultra quality.** Preferences › Stem separation › AI quality › Ultra averages two time-shifted passes (the reference “shifts” trick) for slightly cleaner stems, at twice the time.
- **AI stems in the browser too.** Download `rush-htdemucs.rsm` from the release, then install it once with Options › AI stem model. It is kept in the browser's storage.
- **Robust.** If the graphics card fails mid-song, the rest is finished on the CPU. If the model can't run at all, Rush uses the fast separator.

**1.4: AI stem separation**
- Instant-then-AI playback on the Stems deck, AI stems saved in the `.rush` project, and a quality setting (window overlap 10%, 25% or 50%).
- Already separated with the fast separator? Right-click the file in Media › Separate again with AI.

**1.3: sound quality and studio workflow**
- **Mastering export (Ctrl+E).** Export to WAV (16-bit, 24-bit or 32-bit float) or MP3 (128–320 kbps), at 44.1 to 96 kHz, for the whole project, the loop region or from the cursor.
  - Loudness presets: Streaming −14 LUFS, Apple Music −16, Mixtape −10, Club −8, Broadcast EBU R128 −23, true-peak only, or custom.
  - Loudness is measured to ITU-R BS.1770-4 / EBU R128 (matches FFmpeg's `ebur128` to 0.1 LU).
  - A two-stage limiter with 4× oversampled true-peak detection keeps peaks under the ceiling. It never limits deeper than 10 dB; if the target needs more, it tells you instead of crushing the mix.
  - TPDF dither with noise shaping. Title, artist, album, genre, year, copyright and comments are written into WAV (LIST/INFO) and MP3 (ID3v2) files.
  - "Measure loudness" previews the result before you export, and every export ends with a loudness report.
- **Explorer (Alt+2).** Add your music folders once and browse them from the sidebar.
  - Each file shows its length, original format, sample rate, bit depth, tempo, key and size.
  - Arrow keys auto-preview through a separate preview bus with its own volume; you can optionally preview at the project tempo.
  - Enter or double-click adds the song to the mix. You can also drag a song onto the timeline.
- **Beatmapper.** When you add a long song, a three-step wizard opens:
  1. Set the first downbeat.
  2. Check the grid later in the song: drag a beat line onto its hit to correct the tempo.
  3. Choose whether the song follows the project tempo.

  Change the song length that triggers it in Preferences, or reopen it from a clip's menu.
- **Tools.** Edit (A), Draw (D), Envelope (G), Time selection (I) and Erase (U), on the toolbar or by key.
- **Clips.**
  - Non-destructive Reverse (Shift+R).
  - Automatic crossfades when clips overlap on a track.
  - Ripple edits (Ctrl+L) for delete, trim and paste.
  - Quick 3 ms fades on clip edges that cut into audio, so edits never click.
- **Track EQ (Shift+Q).** Low cut, low shelf, parametric mid, high shelf and high cut, with a live response curve.
- **Project workflow.**
  - A New Project dialog with metadata and audio defaults; "start all new projects with these settings" saves them.
  - Project properties (Alt+Enter).
  - Real Save / Save As (Ctrl+Shift+S) to the same file, and Open recent.
  - View and Options menus: snapping (F8), automatic crossfades, ripple, loop, metronome, count-in when recording, bypass all effects (Shift+B).
  - Preferences (Ctrl+,): latency and engine sample rate.
- **Timing.** Exports and the metronome now compensate for the compressors' look-ahead delay, so rendered audio lines up with the grid to the sample.

**Made for mixtapes (1.2)**
- **Add to mix.** The + button on any song in Media puts it on its own track, overlapping the end of the mix, with an automatic crossfade: the "staircase" layout.
- **Tempo markers.** The red lane above the ruler holds tempo changes. Double-click it (or press T) to add one; choose an instant change or a gradual ramp from the previous marker. Drag flags to move them. Right-click for Edit, Go to, Delete, and Adjust tempo to match the cursor.
- **Songs follow the tempo map.** Every song is time-stretched to the tempo at each moment, holds and ramps included, with its pitch kept. Beats land within about 5 ms of the grid.
- **Beat grids.** Rush finds each song's tempo, key (with Camelot code) and first downbeat, and lines the downbeat up with the bar you drop it on.
- **Clip properties.** Double-click a clip, or press Alt+Enter. You get:
  - the song tempo and downbeat over a beat-grid waveform (click to set the downbeat, preview with a metronome)
  - preserve pitch on or off (varispeed)
  - pitch shift, gain and fades
- **Effects on every clip.** Click the fx badge on a clip, or press E. Track effects are on the FX button (Shift+E), master effects in the Mixer.
- **Crossfades.** X crossfades the selected clip with everything it overlaps; Shift+X does the whole project. Fades are equal-power by default.
- **Navigation.** There's an overview strip, Follow-playhead, and previous/next marker buttons.
  - Keyboard: Tab between clips, arrows for the cursor and zoom, F to fit, Z to zoom to a clip, Ctrl+G to go to a bar or time, `[` `]` to nudge the tempo, `?` for the full shortcut sheet.
  - Mouse: middle-drag to pan, Alt+wheel for track height.
  - Touchpad: pinch to zoom.
- **Live level meters** in every track header, and finer grid choices (2 or 4 bars down to 1/32 and triplets).

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
- Timeline markers: M (or Shift+M) inserts one. Use , and . (or Ctrl+←/→) to jump between markers and tempo changes.
- Per-track transpose of ±12 semitones, keeping tempo.
- Loops follow the project tempo automatically. Pitch is kept, using WSOLA time-stretch.
- Trim, loop-extend, split (S), duplicate (Ctrl+D), Alt-drag to copy, and clip fades with gain.
- Grid snapping, loop region, metronome (C), tap tempo and recording from your microphone.
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
- The mix renders faster than real time to WAV or MP3, with optional mastering.

## How the stem separator works

There are two separators.

**AI: HTDemucs v4.** A neural network that works on the waveform and the spectrogram at the same time, with a cross-domain transformer between the two branches. Typical quality on the MUSDB18-HQ benchmark is about 9 dB SDR for drums and vocals, far beyond any filter-based method.

How Rush runs it:
- **7.8-second windows.** The windows overlap and are cross-faded with triangular weights. The edge handling is exactly that of the reference implementation (`apply_model` / `TensorChunk`).
- **One network definition, two backends** (`src/stemnet.js`):
  - **WebGPU compute shaders.** Tiled GEMM, normalisation and softmax kernels; fp16 weights are unpacked on the fly.
  - **WebAssembly SIMD kernels** (`src/kernels/kernels.c`). A packed GEMM with a 4×16 register micro-kernel, vectorised GELU, GLU, softmax and fp16 conversion.
- **Convolutions without copies.** Strided and transposed convolutions are expressed as strided GEMMs, so no im2col buffers are needed.
- **STFT in double precision.** The STFT and inverse STFT reproduce `torch.stft`'s centring, reflect padding and normalisation.
- **Speed depends on the computer.** A graphics card separates a song in seconds to tens of seconds. On the CPU, each core handles one window at a time.

**Fast (everywhere, and the instant layer):**
- Harmonic/percussive separation by median filtering of the spectrogram.
- Stereo-centre analysis, with vocals usually panned centre.
- Frequency-band masking. Bass is kept below about 250 Hz.

The fast separator's masks always sum to one, so its four stems add back up to the original exactly. It runs 10–40× faster than real time and plays instantly while the AI works.

## Build from source

`src/` contains the readable modules. `python3 build.py` bundles them into `dist/RushMusicStudio.html`.

| File | Purpose |
|---|---|
| `src/fft.js` | FFT |
| `src/tempo.js` | Tempo map (markers, ramps, beat ↔ time) |
| `src/plugins.js` | Plugin rack |
| `src/chainer.js` | Plug-in Chainer UI |
| `src/worker.js` | DSP thread: stems, tempo/key, stretch, denoise, spectrogram |
| `src/master.js` | Mastering on the DSP thread: BS.1770 loudness, true-peak limiter, dither, WAV writer |
| `src/mp3worker.js` | MP3 encoder thread (ID3v2 tags) around the LAME library |
| `src/shell.js` | Preferences, Save/Save As/Recent, project properties, export dialog, View/Options menus |
| `src/explorer.js` | Explorer file browser |
| `src/beatmap.js` | Beatmapper wizard |
| `src/stemnet.js` | Rush's neural engine: the HTDemucs network on a WebGPU or WebAssembly backend |
| `src/kernels/` | WebAssembly SIMD kernels (C source, build script and the built `.wasm` files) |
| `src/ai.js`, `src/aiworker.js` | AI separation: model loading, GPU or CPU engine workers, windowing, streaming results to the deck |
| `tools/htdemucs_to_rsm.py` | Converts the official checkpoint to Rush's model file (NumPy only) |
| `tools/htdemucs_ref.py`, `tools/stemnet_check.py` | Independent NumPy reference and the CI agreement check |
| `desktop/fetch-ai.sh` | Downloads the model and runtime for the desktop build |
| `src/engine.js` | Audio engine, project model, save/load |
| `src/arrange.js` | Arranger view |
| `src/editor.js` | Editor view |
| `src/stems.js` | Stems deck |
| `src/mixer.js` | Mixer view |
| `src/looplab.js` | Loop Lab |
| `src/main.js` | App shell |

## Third-party code

See [THIRD_PARTY.md](THIRD_PARTY.md). The AI model weights (HTDemucs v4, MIT, Meta AI) are downloaded and converted by `desktop/fetch-ai.sh` when the installers are built. The engine that runs them is Rush's own code. MP3 export uses [lamejs](https://github.com/zhuker/lamejs), a JavaScript port of the [LAME](https://lame.sourceforge.net) encoder, under the LGPL. It is included unmodified as a separate file (`src/vendor/lame.min.js`, licence in `src/vendor/LAMEJS-LICENSE.txt`) and loaded into its own script block, so you can swap it for another build. Everything else is original code under the MIT licence.

## Keyboard

Press `?` in the app for the full sheet. The basics:


| Keys | Action |
|---|---|
| Space | Play/pause |
| Home | Go to start |
| R | Record |
| L | Loop |
| C | Metronome |
| 1–4 | Switch view |
| Ctrl+S / Ctrl+O | Save / open project |
| Ctrl+I | Import audio |
| Ctrl+E | Export mix (WAV/MP3 with mastering) |
| Ctrl+Shift+S | Save as |
| Ctrl+, | Preferences |
| F8 | Snapping |
| A D G I U | Edit, Draw, Envelope, Time selection, Erase tools |
| Ctrl+Z / Ctrl+Y | Undo / redo |
| Ctrl+K | Effects (Plug-in Chainer) |
| T / M | Tempo change / marker at the cursor |
| E / X | Clip effects / crossfade |
| ? | All shortcuts |
| M / R | Marker / region (Editor) |
| + / − | Zoom |
