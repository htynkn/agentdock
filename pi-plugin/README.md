# AgentDock pi extension

A [pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
extension that bridges AgentDock hardware to pi over BLE.

It connects to an `AgentDock-XXXX` device, forwards key and encoder events to the
pi API, and pushes the agent state back to the device so the LED shows what the
agent is doing.

## Requirements

- Node.js 22 or newer
- Bluetooth LE support on the host
- The AgentDock firmware from `../firmware`

On macOS, grant Bluetooth permission to the terminal application the first time
the extension scans.

## Install

Install it as a pi package:

```bash
pi install npm:agentdock-pi-plugin
```

To pin a version: `pi install npm:agentdock-pi-plugin@0.4.0`. Project scope:
add `-l`. Remove with `pi remove npm:agentdock-pi-plugin`.

`@stoprocent/noble` is a native BLE binding installed as a dependency. On Linux
you may need the Bluetooth headers first (for example `libbluetooth-dev` on
Debian/Ubuntu).

## Load without installing

During development:

```bash
pi --extension /absolute/path/to/agentdock/pi-plugin/index.ts
```

Or try the npm tarball for a single invocation:

```bash
pi -e npm:agentdock-pi-plugin
```

## Usage

Run `/dock` inside pi to open the management panel:

- select or rebind a device
- edit the KEY2 / KEY3 macros
- test LED states and their sounds (including `auto` for the seven-colour cycle and
  `attention` for the "needs you" state)
- set LED brightness, the three independent sound volumes and the master mute
  (applied live, persisted on the device)
- force a reconnect

Configuration is stored in `~/.pi/agent/agentdock.json`:

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

`brightness` / the three volumes / `muted` are a display cache only: the device's
own NVS is the source of truth, and the values reported by the device on connect
overwrite the local ones.

### Sounds

Three independent sound categories, each with its own volume (0 % = that category
is off). Adjust them in `/dock` → **声音与灯光**; every change is applied live and
immediately previewed with that category's own sound.

| Category | Fires on | Default |
|---|---|---|
| 按键音 (`keyVolume`) | KEY1/2/3 and encoder push confirmation | 100 % |
| 旋钮刻度音 (`knobVolume`) | Encoder rotation ticks | 60 % (ticks are frequent, so quieter) |
| agent 提示音 (`agentVolume`) | Run finished / real error / waiting for you | 100 % |

`muted` is the master switch: KEY1 long press toggles all three at once
(persisted on the device), and the panel can toggle it too.

### Controls

| Device input | pi action |
|---|---|
| KEY1 short press | Abort the current run |
| KEY1 long press | Toggle all sounds (master mute ⇄ restore, device-local) |
| KEY2 short press | Send macro 0 (default `继续`) |
| KEY2 long press | Demo mode: bugle fanfare + seven-colour breathing LED (3 s, device-local) |
| KEY3 short press | Send macro 1 (default `不对`) |
| Encoder push | Send `继续` |
| Encoder rotate | Scroll the transcript by ±3 lines per step |

### LED states

| State | Meaning |
|---|---|
| Dim blue | Idle |
| Green breathing | Agent is running |
| Amber double pulse | Agent is waiting for you (`attention`) |
| White flashes, then back | Run finished (`done`) |
| Red flashes, then back | Real failure (`error`) |
| Seven-colour breathing | Demo / `auto` LED test (3 s) |
| Very dim blue heartbeat | Not connected |

### When does it turn red?

A single failed tool call is normal trial and error — the agent usually fixes it
itself, so one or two errors never light the LED. The extension only reports
`error` after **3 consecutive** tool failures that are still not recovered after a
2.5 s observation window; any success in between cancels the alarm. A run that
ends through a provider error also reports `error` once it settles.

`done` and `error` are transient: the extension sends the state together with a
`then` target, and the device flashes and returns to that state by itself, so the
LED never jumps back to the wrong colour.

### Needs you (`attention`)

When pi blocks on a user-facing prompt (`ui_prompt_start` — `ask_user_question`,
confirm/select/input dialogs), the device switches to an amber double pulse and
plays a dedicated attention chime. If nobody answers, the chime repeats every
20 s, at most 3 times, and stops the moment the prompt is gone. The `/dock` panel
itself does not trigger it.

### Transcript scrolling

Scrolling relies on pi's fullscreen TUI internals. If the API is unavailable in
your pi version, encoder events are logged and other features keep working.

## Protocol

The extension talks to `firmware/main/deck.c` over a custom GATT service:

- Service: `8e7c1a10-c0de-4b1e-9f6a-000000000001`
- `EVENT` notify (device → host):
  `8e7c1a10-c0de-4b1e-9f6a-000000000002`
- `STATE` write (host → device):
  `8e7c1a10-c0de-4b1e-9f6a-000000000003`

```jsonc
// device -> host
{"k":"key","id":2}
{"k":"enc","v":-1}
{"k":"cfg","b":100,"m":0,"s":[100,60,100]}  // 设置快照 (连接后/KEY1 长按后推)

// host -> device
{"t":"s","st":"busy"}                        // idle | busy | attention
{"t":"s","st":"error","then":"busy"}        // done|error|demo + 播完回哪
{"t":"cfg","b":80,"m":0,"s":[100,55,90]}    // 亮度 / 总静音 / 三类音量 (均可选)
{"t":"pv","c":1}                              // 试听: 0=按键 1=旋钮 2=agent
```

`s` 的三项顺序固定为 **按键 / 旋钮 / agent**, 与固件 `sound_cat_t` 一致;
每项 0~100 (0 = 该类关闭). 旧固件只认识 `{"t":"cfg","b":..,"v":..}`,
新插件发的 `s` 会被忽略 (面板仍提示已应用, 建议固件与插件同步升级).

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest: 纯逻辑 + /dock 面板渲染与交互
npm run check:pack  # 校验 npm tarball 内容 (入口齐全、无测试泄漏)
```

Publishing is described in
[PUBLISHING.md](https://github.com/htynkn/agentdock/blob/master/pi-plugin/PUBLISHING.md),
or in short:

```bash
npm version patch
npm publish --registry https://registry.npmjs.com/
```

单测不依赖真实蓝牙硬件: BLE 通道与 pi 的 `ctx.ui` 都是 mock 的,
主题用真实 ANSI 转义以保证宽度计算与线上一致。

## Troubleshooting

- Extension logs are prefixed with `[agentdock]` in non-TUI modes.
- macOS: check **System Settings → Privacy & Security → Bluetooth** for the
  terminal application.
- The extension scans for 8 seconds and retries every 5 seconds. The device shows
  a dim blue heartbeat while it is not connected.
- Use `npm run scan` to list all visible BLE devices and verify that the device
  is advertising.
