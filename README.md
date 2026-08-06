# showa-emu

A Famicom emulator that runs inside a **Shōwa-era living room**: a CRT television on a stand in a
eight-mat tatami room, with a console, an RF switch box, cables you can actually unplug, and physics.
Forked from [GOROman/cluade-famicom-emu](https://github.com/GOROman/cluade-famicom-emu).

**▶ Play: https://kurogedelic.github.io/showa-emu/**

It boots straight into *nobunaga.nes*, an original game by [kurogedelic](https://github.com/kurogedelic),
bundled in this repo. Use **Open ROM** in the toolbar to load your own `.nes` file.

## What this fork adds

- **NTSC / RF simulation.** The picture is encoded onto a colour subcarrier and demodulated again in
  the shader. Chroma is band-limited, luma is recovered with a comb filter so it stays sharp. Dot
  crawl, colour bleed, ghosting, colour-killer, snow and sync tearing all fall out of the model.
- **On-screen display** in the style of
  [famicom-rf-hackrf-decoder](https://github.com/GOROman/famicom-rf-hackrf-decoder) — CH1, V-SYNC /
  H-SYNC lock, FPS, carrier frequencies, latency. The OSD goes through the CRT effects too.
- **Cables you can unplug.** RF (console → RF switch → TV), the TV's mains lead and the Famicom's AC
  adapter, simulated as Verlet ropes. Pull the RF plug and you get snow; pull the mains and the tube
  goes dark; pull the adapter and the console powers off.
- **A real cartridge.** 109.5 × 70 × 17 mm shell, 90 × 46.1 mm board, 60 pads on a 2.54 mm pitch
  (dimensions from the [NESdev Wiki](https://www.nesdev.org/wiki/Famicom_cartridge_dimensions)).
  Drag it up to unseat it and the contacts drop out one by one; drag sideways to tilt it.
- **Physics** (cannon-es). Grab and throw the television, the stand, the console. Knocks make the
  picture warp and settle; a knock to the console makes the contacts bounce and the game glitch.
  Throw something hard enough at a wall and the wall falls over, Drifters-style — behind it is just
  blue sky.
- **Room props.** Cockroaches that scuttle across the floor *and up the walls* (one more per click,
  and a can of bug spray to deal with them), a ceiling leak, and a can of orange soda you can knock
  over — the puddle reaching the console gums up the contacts.

Everything in the room is generated in code. Drop a glTF into `web/assets/models/` to replace any of
it — see [the notes there](web/assets/models/README.md).

## Controls

Hover the **television** for its own settings (UHF gain, tuning, CRT effect, OSD, mute).
Hover the **console** for power, reset and the loaded ROM — drop a `.nes` file on it to swap the
cartridge. Hover the **cartridge** for a tilt and contact gauge. The overlay at the bottom left has
power, reset, grab mode, tidy up, the room light, and the prop palette (roach, bug spray, ceiling
leak, soda can, falling washtub). Drag anywhere else to orbit.

The original 2D interface is still reachable: `?room=0` gives you the plain emulator with its
toolbar and 60-pin connector panel. In 3D, the debug panels are still there — scroll left and right.

| NES | Keyboard | Gamepad |
|---|---|---|
| D-pad | Arrow keys | D-pad / left stick |
| A / B | X / Z | Right / bottom button |
| Start / Select | Enter / Shift | Start / Select |

Hotkeys: **F** fullscreen · **R** reset (held) · **D** debug panel.
URL parameters: `?room=0` for the plain 2D view, plus `rom=`, `debug=1`, `pin=0`, `clock=`, `tilt=`,
`break=`, `mute=1`, `vol=`, `lang=`.

## Build

The emulator core is C++ compiled to WebAssembly with Emscripten:

```sh
./build.sh          # → web/nes.js + web/nes.wasm
cd web && python3 -m http.server 8765
```

The 3D layer is plain ES modules; there is no build step for it.

## Credits

The emulator — the 6502/PPU/APU core, the 60-pin fault model, the oscilloscope, the debugger — is
[GOROman](https://github.com/GOROman)'s work. This fork only adds the room around it. See the
[original repository](https://github.com/GOROman/cluade-famicom-emu) for the full documentation
([日本語](https://github.com/GOROman/cluade-famicom-emu/blob/main/README.ja.md) ·
[中文](https://github.com/GOROman/cluade-famicom-emu/blob/main/README.zh.md)).

Bundled libraries: [three.js](https://threejs.org/) r180 and [cannon-es](https://github.com/pmndrs/cannon-es) 0.20, both MIT.
`web/assets/roms/nobunaga.nes` is © kurogedelic. Everything else is MIT, as in the original.
