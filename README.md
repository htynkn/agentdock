# AgentDock

[![CI](https://github.com/htynkn/agentdock/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/htynkn/agentdock/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

AgentDock is a small desktop controller for the [pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent).
It is built around an **ESP32-C2** module and adds three keys, a rotary encoder
(with push switch), a WS2812 LED and a passive buzzer.

The device talks to pi over a **custom BLE GATT channel**. While the agent runs it
shows the current state on the LED, so you can see when a task is done, still
running, or waiting for your input. The keys and encoder let you abort, continue,
send macros or scroll the agent output without switching windows. Three
independent sound channels (key presses, encoder ticks, agent notifications) can be
tuned in `/dock`, and KEY1 long press mutes or restores all of them at once.

The repository contains the **firmware**, the **pi extension**, and the
**hardware** design files for the enclosure (parametric build123d model of the
base + lid plus the acrylic front panel, ready for 3D printing — see
[hardware/README.md](hardware/README.md), panel ordering in
[hardware/enclosure/PANEL.md](hardware/enclosure/PANEL.md)).

---

## Features

- **Agent state at a glance** — idle / busy / needs-you / done / error mapped to
  distinct LED patterns, each with its own short melody.
- **Three independent sound channels** — key confirmation, encoder ticks and agent
  notifications each have their own volume (0 = off), adjustable live in `/dock`;
  KEY1 long press is the single master switch for all of them.
- **Error that is not jumpy** — a single failed tool call is normal trial and error.
  The red LED only appears after 3 consecutive failures that are still unrecovered
  after a 2.5 s window, so the light never blinks red and back for a self-healing run.
- **Calls you when it needs you** — when pi blocks on a user-facing prompt the device
  pulses amber and plays an attention chime; it repeats every 20 s (max 3 times)
  until you answer.
- **Context-aware input** — keys send events to the pi extension over BLE, so
  macros go to the agent instead of whichever window happens to be focused.
- **Rotary encoder scrolling** — scroll the pi transcript with the knob, with
  accelerated half-page scrolling when turned quickly.
- **No pairing required** — the extension scans for `AgentDock-XXXX` and connects
  automatically.
- **Reproducible builds** — pinned ESP-IDF version, Component Manager lockfile and
  a GitHub Actions CI pipeline for both firmware and plugin.
- **Printable enclosure** — parametric build123d model with automated
  interference checks; CI publishes the STL/STEP files and preview renders as
  artifacts.

## Repository layout

```
agentdock/
├── firmware/            ESP-IDF project (C, ESP32-C2 / ESP8684)
│   ├── main/
│   │   ├── main.c       application task, event dispatch
│   │   ├── input.c      key debounce + quadrature encoder decoding
│   │   ├── deck.c       custom BLE GATT service (NimBLE)
│   │   ├── fx.c         LED patterns + RTTTL melody engine
│   │   └── config.c     NVS-backed settings (mute / 3 volumes / brightness)
│   ├── sdkconfig.defaults
│   └── dependencies.lock
├── pi-plugin/           pi extension (TypeScript, Node.js)
│   ├── index.ts         lifecycle, state machine, /dock command
│   ├── ble.ts           BLE scan / connect / subscribe / reconnect
│   ├── panel.ts         interactive /dock panel
│   ├── scroll.ts        encoder → transcript scrolling
│   └── config.ts        ~/.pi/agent/agentdock.json persistence
├── hardware/            3D-printed enclosure (build123d, see hardware/README.md)
│   ├── pcb/             PCB 3D model (STEP, git-ignored; pinned GitHub release)
│   └── enclosure/       parametric base + lid, self-checks, renders, animation
└── .github/workflows/   CI (firmware, plugin, hardware)
```

## How it works

```
┌──────────────────────────────┐            ┌──────────────────────────────┐
│ AgentDock firmware (ESP32-C2)│            │ pi coding agent              │
│                              │    BLE     │                              │
│  keys / encoder ──► events   │ ─────────► │  agentdock extension         │
│                              │  EVENT     │   ├─ abort / macro / scroll  │
│  LED + buzzer ◄── state      │ ◄───────── │   └─ agent_start / settled   │
│                              │   STATE    │                              │
└──────────────────────────────┘            └──────────────────────────────┘
```

1. The extension scans for a device named `AgentDock-XXXX`, connects and
   subscribes to the `EVENT` characteristic.
2. pi lifecycle events are written to the `STATE` characteristic. The firmware
   translates them into LED patterns and melodies.
3. Key and encoder events are notified back to the extension, which calls the pi
   API (abort, `sendUserMessage`, transcript scrolling).

The current firmware exposes **only the custom GATT service**. There is no HID
fallback yet; when the extension is not connected the device shows an offline
heartbeat and key presses have no effect on the host.

## Hardware

The reference board is the **VibeCoding keyboard** with an `ESPC2-M1-N2` module
(ESP8684 / ESP32-C2, 2 MB embedded flash, 26 MHz crystal). It has no on-board
USB-to-UART bridge; use an external USB-TTL adapter on the `H1` header.

| Signal | GPIO | Notes |
|---|---|---|
| Buzzer (`SOUND`) | IO1 | Passive buzzer via low-side MOSFET, PWM (LEDC) |
| WS2812 data (`LED-DIN`) | IO3 | 100 Ω series resistor; SPI backend (ESP32-C2 has no RMT) |
| KEY1 | IO4 | Active low, internal pull-up |
| KEY2 | IO5 | Active low, internal pull-up |
| KEY3 | IO6 | Active low, internal pull-up |
| Encoder A | IO7 | EC11 quadrature |
| Encoder B | IO18 | EC11 quadrature |
| Encoder switch | IO10 | Active low, internal pull-up |
| BOOT | IO9 | Low at reset = download mode |
| UART TX / RX | GPIO20 / GPIO19 | To the USB-TTL adapter |

> The pins above match the reference board. If you build your own board, update
> `firmware/main/input.h` and the `BUZZER_GPIO` / `LED_GPIO` defines in
> `firmware/main/fx.c`.

## Firmware

### Prerequisites

- [ESP-IDF **v5.4.2**](https://docs.espressif.com/projects/esp-idf/en/v5.4.2/)
- A USB-to-UART adapter (3.3 V) for flashing

### Build

The `sdkconfig` file is intentionally not committed; it is generated from
`firmware/sdkconfig.defaults` on the first build.

```bash
source /path/to/esp-idf/export.sh

cd firmware
idf.py set-target esp32c2
idf.py build
```

The application binary is `firmware/build/agentdock.bin`. To create a single
factory image containing the bootloader, partition table and application:

```bash
idf.py merge-bin      # -> build/merged-binary.bin
```

### Flash and monitor

```bash
idf.py -p /dev/cu.usbserial-XXXX flash monitor
```

Use the serial port of your USB-TTL adapter (`ls /dev/cu.usb*` on macOS,
`ls /dev/ttyUSB*` on Linux). The console runs at **74880 baud**, matching the
26 MHz crystal and the ESP32-C2 ROM bootloader.

To erase the NVS partition (for example to reset the mute setting and sound
volumes):

```bash
idf.py -p /dev/cu.usbserial-XXXX erase-flash
```

### Configuration notes

`firmware/sdkconfig.defaults` sets:

- NimBLE host (no Bluedroid) to save RAM on the ESP32-C2
- 26 MHz crystal (`CONFIG_XTAL_FREQ_26`)
- 74880 baud console
- 1000 Hz FreeRTOS tick for the 1 ms input poll
- A single large application partition
- A 4096-byte main task stack

On the first build, the Component Manager downloads `espressif/led_strip` as
pinned by `firmware/dependencies.lock`.

## pi extension

### Requirements

- Node.js 22 or newer
- Bluetooth LE support on the host
- A pi installation that provides `@earendil-works/pi-coding-agent`

On macOS, grant Bluetooth permission to the terminal application the first time
the extension scans.

### Install

```bash
cd pi-plugin
npm install
```

> `@stoprocent/noble` is a native BLE binding. If `npm install` fails on Linux,
> install the Bluetooth headers first (for example `libbluetooth-dev` on
> Debian/Ubuntu).

### Load

For development, load the extension directly:

```bash
pi --extension "$PWD/pi-plugin/index.ts"
```

For everyday use, copy the directory (including `node_modules`) into your pi
extensions directory:

```bash
mkdir -p ~/.pi/agent/extensions
cp -R pi-plugin ~/.pi/agent/extensions/agentdock
```

pi will load `~/.pi/agent/extensions/agentdock/index.ts` automatically on the
next start.

### Manage with `/dock`

Inside pi, run `/dock` to open the management panel:

- select or rebind a device
- edit the KEY2 / KEY3 macros
- test LED states and their sounds (`auto`, `busy`, `attention`, `done`, `error`, `idle`)
- set LED brightness, the three sound volumes and the master mute
- force a reconnect

Configuration is stored in `~/.pi/agent/agentdock.json` and can also be edited by
hand:

```json
{
  "preferredDevice": "AgentDock-A1B2",
  "macros": ["继续", "不对"],
  "brightness": 100,
  "keyVolume": 100,
  "knobVolume": 60,
  "agentVolume": 100,
  "muted": false
}
```

## Controls

| Input | Action in pi |
|---|---|
| KEY1 short press | Abort the current agent run (`ctx.abort()`) |
| KEY1 long press (800 ms) | Master sound switch: mute ⇄ restore all three sound channels (persisted in NVS) |
| KEY2 short press | Send macro 0 (default: `继续`); uses steer while the agent is busy |
| KEY2 long press (800 ms) | Demo mode: bugle fanfare + seven-colour breathing LED, ~3 s (device-local self-test) |
| KEY3 short press | Send macro 1 (default: `不对`); uses steer while the agent is busy |
| Encoder push | Send `继续` |
| Encoder rotate | Scroll the agent transcript (±3 lines per step); each detent plays a tick |

Long presses are intentionally limited to KEY1 (all sounds) and KEY2 (demo).
Fine-grained sound control lives in `/dock` instead of on hidden key combinations.

### Sound categories and volume

Three independent channels, each with a volume from 0 to 100 % (0 = that channel
is off). `/dock` → **声音与灯光** adjusts them live and previews each change with
that channel's own sound.

| Channel | Fires on | Default |
|---|---|---|
| **Key** (`keyVolume`) | KEY1/2/3 and encoder-push confirmation | 100 % |
| **Knob** (`knobVolume`) | Encoder rotation ticks | 60 % (ticks are frequent, kept quieter) |
| **Agent** (`agentVolume`) | Boot / run finished / real error / waiting for you | 100 % |

`muted` is the master switch above all three. KEY1 long press toggles it on the
device (persisted in NVS); the `/dock` panel can toggle it too, and because the
device pushes a settings snapshot after the key press, the panel always shows the
true state.

### When does the LED turn red?

A single failed tool call is normal trial and error. The extension only reports
`error` after **3 consecutive** tool failures that are still not recovered after a
2.5 s observation window; any success in between cancels it, and it is reported at
most once per run. A run that settles with a provider error also reports `error`.

`done` / `error` / `demo` are sent together with a `then` target
(`{"t":"s","st":"error","then":"busy"}`), so the device flashes and returns to
the right state on its own — no host-side timers fighting over the LED.

### Needs you (`attention`)

When pi blocks on a user-facing prompt (`ui_prompt_start`: `ask_user_question`,
confirm / select / input dialogs), the device switches to an amber double pulse
and plays the attention chime. If nobody answers it repeats every 20 s, at most
3 times, and stops as soon as the prompt closes. The `/dock` panel itself is
excluded — you are already looking at it.

### Device settings (brightness / sound volumes)

`/dock` → **声音与灯光** adjusts LED brightness (10 % steps) and the three sound
volumes, and toggles the master mute. Each change is pushed immediately, so you
can watch/listen while adjusting: the LED re-renders within 100 ms, and **every
volume change previews that channel at the new level** (so 0 % is audibly
silent). All of it is stored in the device's NVS (volumes map onto the LEDC duty
cycle; brightness scales the existing colours, 100 % = the palette as designed).
If the device is muted the panel warns that the preview cannot be heard; if the
device is not connected the panel says so, and on the next connect the device
reports its stored values and those win.

## LED and sound language

LED states:

| State | LED |
|---|---|
| `idle` | Dim blue |
| `busy` | Green breathing |
| `attention` | Amber double pulse (needs you) |
| `done` | White flashes ×4, then back to `then` |
| `error` | Red flashes ×6, then back to `then` |
| `demo` | Seven-colour breathing for ~3 s, then back to `then` |
| Offline | Very dim blue heartbeat |

Sounds:

| Event | Channel | Melody |
|---|---|---|
| Boot | agent | Mario power-up arpeggio |
| Key short press / deck connect | key | Mario coin |
| Run finished | agent | Three-note rising chime (`FX_DONE`) |
| Real error | agent | Two low beeps + descending tritone |
| Needs you | agent | Two quick high pings + a held top note |
| Master mute on / off | key (max volume) | Short-long / long-short |
| Encoder clockwise | knob | Two-step rising tick (2200 → 3000 Hz), one per detent |
| Encoder counter-clockwise | knob | Two-step falling tick (2200 → 1500 Hz), one per detent |
| Demo (KEY2 long press) | key | Bugle fanfare: three stabs, rising triad, held top note |
| Volume change (`/dock`) | that channel | Short representative sound at the new volume |

Encoder ticks are local feedback, so they also play while the device is not
connected. During a melody they are inserted at the next note gap instead of
cutting it off. Pitch and length live in `CLICK_CW` / `CLICK_CCW` in
`firmware/main/fx.c`; if your encoder reads the wrong way round, swap those two
tables (or the wiring of A/B).

The master-mute confirmation is the one sound that ignores the master switch: it
plays at the loudest configured channel so you can always tell whether the device
is muted or simply not responding.

## BLE protocol

- Device name: `AgentDock-` + the last four hex digits of the MAC address
- Service: `8e7c1a10-c0de-4b1e-9f6a-000000000001`
- `EVENT` characteristic: `8e7c1a10-c0de-4b1e-9f6a-000000000002`
  (notify, device → host)
- `STATE` characteristic: `8e7c1a10-c0de-4b1e-9f6a-000000000003`
  (write, host → device)

Messages are UTF-8 JSON:

```jsonc
// device -> host (EVENT)
{"k":"key","id":1}        // KEY1 short press
{"k":"key","id":2}        // KEY2 short press
{"k":"key","id":3}        // KEY3 short press
{"k":"key","id":4}        // encoder push
{"k":"enc","v":-1}        // encoder step (-1 / +1)
{"k":"cfg","b":100,"m":0,"s":[100,60,100]}  // settings snapshot (on connect / after KEY1 long press)

// host -> device (STATE)
{"t":"s","st":"idle"}                     // idle | busy | attention
{"t":"s","st":"done","then":"idle"}      // done | error | demo: transient, returns to `then`
{"t":"cfg","b":80,"m":0,"s":[100,55,90]} // brightness / master mute / three volumes (all optional)
{"t":"pv","c":1}                          // preview channel 0=key 1=knob 2=agent
```

The three entries of `s` are always **key / knob / agent**, matching `sound_cat_t`
in the firmware; each is 0–100. `then` is optional and means "the state the device
should return to after the transient effect" — the device owns the timing, so the
host never has to schedule a state refresh.

BLE encryption and bonding are not enabled in the current firmware. The channel
carries only key events and agent state, and is intended for a trusted local
environment.

## Continuous integration

`.github/workflows/ci.yml` runs on every pull request and on pushes to
`master` / `main`:

| Job | What it does |
|---|---|
| **Firmware (ESP32-C2)** | Builds `firmware/` with ESP-IDF v5.4.2 in the official `espressif/idf` container, reports the image size and uploads the flashable binaries as a workflow artifact on every run, including pull requests. |
| **Plugin (TypeScript)** | Installs `pi-plugin/` with `npm ci --ignore-scripts`, checks that the lockfile uses the public npm registry, then runs `npm run typecheck` and `npm test` (Vitest unit tests for the BLE config layer, knob scrolling and the `/dock` panel rendering/interaction). |

The firmware artifact is named `agentdock-firmware-<run-number>` and contains:

- `agentdock.bin` — application image
- `bootloader/bootloader.bin` — bootloader image
- `partition_table/partition-table.bin` — partition table
- `merged-binary.bin` — single factory image for offset `0x0`
- `flash_args` — `esptool.py` flash arguments

The firmware job starts from `sdkconfig.defaults`, which also verifies that a
clean checkout still builds.

## License

[MIT](LICENSE)
