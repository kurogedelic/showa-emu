# showa-emu

**A Famicom emulator inside a simulated Shōwa-era Japanese living room.**

▶ **Play:** https://kurogedelic.github.io/showa-emu/  
日本語: [README.ja.md](README.ja.md)

`showa-emu` starts with a real Famicom emulator and extends the emulation beyond the console itself: CRT/RF behaviour, cartridge contacts, cables, furniture, room physics, and assorted household disasters are all part of the simulation.

Forked from [GOROman/cluade-famicom-emu](https://github.com/GOROman/cluade-famicom-emu).

The bundled default ROM, `nobunaga.nes`, is an original game by [kurogedelic](https://github.com/kurogedelic). You can also load your own `.nes` file from the browser.

## The idea

Most emulators reproduce the machine. **showa-emu tries to reproduce the situation around the machine.**

The Famicom sits in an eight-mat tatami room with a CRT television and RF switch box. Connections can fail physically, the cartridge can lose contact, objects have mass, and the television signal behaves like an analogue television signal rather than a clean framebuffer.

## What it simulates

- **NTSC / RF video** — colour subcarrier encode/decode, band-limited chroma, comb-filtered luma, dot crawl, colour bleed, ghosting, colour killer, snow and sync tearing.
- **CRT presentation** — emulator output and the diagnostic OSD pass through the television effects together.
- **Physical cables** — RF, TV mains and the Famicom AC adapter are simulated as finite-length Verlet ropes. Pull them taut and the plugs come out.
- **Famicom cartridge contacts** — the cartridge has a 109.5 × 70 × 17 mm shell, a 90 × 46.1 mm board and 60 contacts on a 2.54 mm pitch. Pull or tilt it and contacts disconnect progressively.
- **Room physics** — powered by `cannon-es`. The television, stand and console can be grabbed, moved and thrown. Impacts can disturb the picture or cartridge contacts.
- **A working Zapper** — the core implements the `$4017` trigger/light-sense behaviour and the browser side samples the framebuffer at the aim point, so compatible light-gun games can respond.
- **Unreasonable extensions** — walls can fall over; cockroaches roam the room; bug spray exists; the ceiling can leak; orange soda can reach the console and foul the cartridge contacts; the Zapper can emit a continuous beam that pushes objects and produces smoke.
- **Sake** — drinking it temporarily warps the field of view and reverses the D-pad.

Everything in the room is generated in code by default. Optional glTF/GLB models can replace generated objects; see [`web/assets/models/README.md`](web/assets/models/README.md).

## Controls

Hover the **television** for tuning, UHF gain, CRT, OSD and audio controls.  
Hover the **console** for power, reset and ROM controls. A `.nes` file can also be dropped onto it.  
Hover the **cartridge** to inspect tilt and contact state.

The lower-left overlay provides power, reset, grab mode, tidy-up, room lighting and props. Drag elsewhere to orbit the camera; middle-drag pans.

| NES | Keyboard | Gamepad |
|---|---|---|
| D-pad | Arrow keys | D-pad / left stick |
| A / B | X / Z | Right / bottom button |
| Start / Select | Enter / Shift | Start / Select |

Hotkeys: **F** fullscreen · **R** reset (held) · **D** debug panel

Useful URL parameters include:

- `?room=0` — original 2D emulator interface
- `rom=` — ROM selection
- `debug=1` — debug UI
- `pin=0`, `clock=`, `tilt=`, `break=` — fault/debug controls
- `mute=1`, `vol=` — audio
- `lang=` — language

## Architecture

```text
core/                 C++ Famicom emulator core
  └─ nes.cpp / nes.h  CPU / PPU / APU integration + Zapper support

web/
  ├─ main.js           emulator/browser integration
  ├─ room.js           Shōwa room, rendering, interaction and physics
  ├─ props.js          room props and incidents
  ├─ cables.js         physical cable simulation
  ├─ sfx.js            room sound effects
  ├─ layout.js         room/layout helpers
  ├─ audio-worklet.js  APU playback
  ├─ nes.js / nes.wasm Emscripten output
  └─ vendor/           three.js + cannon-es dependencies
```

The emulator core is compiled from C++ to WebAssembly with Emscripten. The 3D layer uses plain ES modules, `three.js` and `cannon-es`; it has no separate bundling step.

## Build

```sh
./build.sh
cd web
python3 -m http.server 8765
```

Then open `http://localhost:8765/`.

## Credits

The original **6502 / PPU / APU emulator core, 60-pin fault model, oscilloscope and debugger** are the work of [GOROman](https://github.com/GOROman). See [GOROman/cluade-famicom-emu](https://github.com/GOROman/cluade-famicom-emu) for the original project and documentation.

This fork adds the Shōwa room, physical environment and related simulation around that emulator.

Bundled libraries:

- [three.js](https://threejs.org/) r180 — MIT
- [cannon-es](https://github.com/pmndrs/cannon-es) 0.20 — MIT

`web/assets/roms/nobunaga.nes` is © kurogedelic. The rest of this repository follows the MIT license unless otherwise noted.