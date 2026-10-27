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

```bash
npm install
```

`@stoprocent/noble` is a native BLE binding. On Linux you may need the Bluetooth
headers first (for example `libbluetooth-dev` on Debian/Ubuntu).

## Load

During development:

```bash
pi --extension /absolute/path/to/agentdock/pi-plugin/index.ts
```

For everyday use, copy the directory including `node_modules` to the pi
extensions directory:

```bash
mkdir -p ~/.pi/agent/extensions
cp -R . ~/.pi/agent/extensions/agentdock
```

## Usage

Run `/dock` inside pi to open the management panel:

- select or rebind a device
- edit the KEY2 / KEY3 macros
- test LED states
- force a reconnect

Configuration is stored in `~/.pi/agent/agentdock.json`:

```json
{
  "preferredDevice": "AgentDock-A1B2",
  "macros": ["继续", "不对"]
}
```

### Controls

| Device input | pi action |
|---|---|
| KEY1 short press | Abort the current run |
| KEY1 long press | Toggle the device buzzer mute (device-local) |
| KEY2 short press | Send macro 0 (default `继续`) |
| KEY3 short press | Send macro 1 (default `不对`) |
| Encoder push | Send `继续` |
| Encoder rotate | Scroll the transcript by ±3 lines per step |

### LED states

| State | Meaning |
|---|---|
| Dim blue | Idle |
| Green breathing | Agent is running |
| White double flash | Run finished |
| Red triple flash | A tool returned an error |
| Very dim blue heartbeat | Not connected |

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

// host -> device
{"t":"s","st":"busy"}
```

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest: 纯逻辑 + /dock 面板渲染与交互
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
