# Changelog

All notable changes to the `agentdock-pi-plugin` npm package.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
the package adheres to [Semantic Versioning](https://semver.org/).

See [PUBLISHING.md](./PUBLISHING.md) for the release process.

## [Unreleased]

## [0.1.0] - 2026-10-30

First published version.

### Added

- pi extension that bridges AgentDock hardware over BLE: key and encoder events
  are forwarded to pi, and the agent state is pushed back to the device so its
  LED shows what the agent is doing.
  - KEY1 short press aborts the current run, long press toggles the device buzzer mute
  - KEY2 / KEY3 short press sends a configurable macro (defaults: `继续` / `不对`)
  - Encoder push sends `继续`; encoder rotate scrolls the transcript by ±3 lines per step
  - LED states: dim blue idle, green breathing while running, white double flash on
    finish, red triple flash on tool error, very dim blue heartbeat while disconnected
- `/dock` management panel: select or rebind a device, edit the KEY2 / KEY3
  macros, test LED states, force a reconnect.
- Configuration persisted to `~/.pi/agent/agentdock.json`.
- Automatic BLE reconnect (scans for 8 seconds, retries every 5 seconds).
- Distributed as a pi package: `pi install npm:agentdock-pi-plugin`. The
  `pi.extensions` manifest points at `index.ts`; the TypeScript sources are
  loaded directly by pi's jiti, so no build step is involved.

### Known limitations

- Transcript scrolling relies on pi's fullscreen TUI internals. If that API is
  unavailable in the pi version in use, encoder events are only logged and every
  other feature keeps working.
- `@stoprocent/noble` is a native BLE binding: installing it needs a build
  toolchain, plus Bluetooth headers on Linux (`libbluetooth-dev` on Debian/Ubuntu).

[Unreleased]: https://github.com/htynkn/agentdock/compare/pi-plugin-v0.1.0...HEAD
[0.1.0]: https://github.com/htynkn/agentdock/releases/tag/pi-plugin-v0.1.0
