# Changelog

All notable changes to the `agentdock-pi-plugin` npm package.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
the package adheres to [Semantic Versioning](https://semver.org/).

See [PUBLISHING.md](./PUBLISHING.md) for the release process.

## [Unreleased]

## [0.3.0] - 2026-11-12

设备体验四件套 + `/dock` 死锁修复。固件与插件建议同步升级：新增 `cfg` 报文，
旧固件会忽略它（面板提示「已应用」但设备无反应），旧插件连新固件只是看不到
设置快照里的 `m` / `c` 字段。

### Added

- 长按 KEY2 进入演示模式: 播一段号角式 fanfare (三连突进 + 上行号角 + 高音长收),
  LED 走一圈七彩呼吸 (3 秒后回到 agent 真实状态). 设备本地动作, 不依赖 BLE 连接.
- 长按 KEY3 开关旋钮刻度音 (与静音一样写 NVS 持久化).
- 固件新增亮度/音量设置并持久化到 NVS; 亮度是对原配色的百分比缩放,
  音量映射到蜂鸣器 PWM 占空比 (0% = 无声).
- BLE 新增两类报文: `{"t":"cfg","b":..,"v":..}` (host→device 设置) 与
  `{"k":"cfg","b":..,"v":..,"m":..,"c":..}` (device→host 设置快照, 连接后立即推一次);
  STATE 状态新增 `demo` (七彩呼吸一次).
- `/dock` 面板新增「设备设置」: 用 SettingsList 调 LED 亮度与音量, 每改一档
  立即下发 (可边调边看/听), Esc 收尾. 未连接时明确提示调整不会生效.
  **改音量会用一个短音试听新响度** (设备侧 `FX_PREVIEW`), 否则只有灯在变;
  设备静音时面板会提醒试听音听不到 (长按 KEY1 解除).
- `/dock` 灯效测试新增 `auto`: 一次展示七彩颜色 (设备侧 3 秒后自动回当前状态).
- 固件 LED 改由独立任务渲染: 旋律播放时灯光不再冻结 (演示模式需要声光同时).

### Fixed

- **`/dock` 用一段时间后就打不开**. 根因: worker 侧 `writeState` 不回 `result`,
  而主进程的 `request()` 只在收到 `result` 时 resolve, 且没有任何超时。于是
  `/dock` 里 `await channel.writeState()` (测试灯效) 与新增的
  `await channel.writeSettings()` (设备设置) 永久挂起 → 面板的 `while` 循环停在
  半途 → 命令 handler 永不返回, 之后的 `/dock` 就全部失效。现在写操作改为纯
  发送不等回包 (`send()`, 同步返回 boolean), worker 也会补回 `result`;`request()`
  增加按 op 区分的超时兜底, 任何请求都不会再永久挂起。
- `/dock` 面板增加重入保护: 同时只允许一份模态循环, 异常退出也不会把状态锁死。
- `saveConfig` 改为真正的原子写 (`writeFileSync` + `renameSync`), 不再残留
  `agentdock.json.tmp`。
- 固件日志 `KEYx 长按 %lldms` 一直打成 `长按 ldms`: ESP-IDF 的日志格式化不支持
  `%lld`, 改用 `%d` + `(int)` 强转。

## [0.2.0] - 2026-11-11

BLE 连接稳定性版本: noble 移入子进程, 连接/发现/重连不再卡死。

### Fixed

- Fixed the "device discovered but never connects" failure loop. Root cause: noble's
  `connectAsync()` resolves `undefined` on success, and the timeout guard treated that
  falsy value as a timeout — then cancelled the just-established connection (the device
  stops advertising while connected, so every later rescan came back empty). Success
  values are now normalized with `.then(() => true)`.
- When the bound device is offline and exactly one other AgentDock is present, the
  extension now re-binds to it automatically (with a notification) instead of retrying
  silently forever. Device names embed the MAC suffix, so swapped boards change the name.
- The `/dock` panel's bind / reconnect actions no longer permanently disable the
  channel (`dispose()` used to leave `disposed` latched; every later `connect()` failed
  immediately).
- Added timeouts around GAP connect, GATT discovery and characteristic subscription:
  a hung step now fails fast and the reconnect loop keeps working instead of latching
  the connecting flag forever.
- Failure notifications are deduplicated per reason instead of firing on every retry,
  and "no device found" is now surfaced once in the TUI.

### Changed

- noble now runs in a dedicated child process (`ble-worker.mjs`) instead of inside the
  pi process. Motivation beyond crash isolation: the in-process path was fragile on
  macOS (scanning worked, `connectAsync` hung; verified on pi 1.4.0 and 1.5.0). The
  worker speaks a JSONL protocol over stdio; the `DeckChannel` API is unchanged, so
  the extension and panel code are untouched. Scan results are briefly cached (3 s)
  to avoid a second 8 s scan when re-checking the device list after a failed connect.

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

[Unreleased]: https://github.com/htynkn/agentdock/compare/pi-plugin-v0.3.0...HEAD
[0.3.0]: https://github.com/htynkn/agentdock/releases/tag/pi-plugin-v0.3.0
[0.2.0]: https://github.com/htynkn/agentdock/releases/tag/pi-plugin-v0.2.0
[0.1.0]: https://github.com/htynkn/agentdock/releases/tag/pi-plugin-v0.1.0
