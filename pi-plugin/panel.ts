/*
 * panel.ts — /dock 可视化管理面板
 *
 * TUI 模式: 手工合成布局 (圆角状态框 + 按键图例 + SelectList 菜单),
 *   状态框内显示连接状态、信号强度条、agent 状态与旋钮可用性;
 *   扫描流程带 Loader 动画与信号强度条, 灯效测试用彩色圆点,
 *   设备设置用 SettingsList (Enter/Space 循环取值, 改一下就能看到/听到);
 * RPC 等非交互模式: 回退到 ctx.ui 标准对话框 (逻辑等价).
 *
 * 注意: pi-tui 的 Text 默认 paddingX=1/paddingY=1 (上下各一空行),
 * 面板内所有行用它时都显式传 0,0, 否则会多出空行与缩进.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  Container,
  Loader,
  type SelectItem,
  SelectList,
  type SettingItem,
  SettingsList,
  Text,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { clampPct, type DeckConfig, soundVolumes, type SoundVolumes } from "./config.js";
import type { DeckChannel, DeckPeripheralInfo } from "./ble.js";

export type PanelAction =
  | { kind: "bind-device"; name: string }
  | { kind: "edit-macro"; index: number; text: string }
  | { kind: "test-led"; state: string }
  | {
      kind: "settings";
      brightness: number;
      /** [按键, 旋钮, agent] 三类音量 0~100 (0 = 关) */
      sounds: SoundVolumes;
      muted: boolean;
    }
  | { kind: "reconnect" }
  | { kind: "exit" };

/** 面板展示用的会话状态快照 (由 index.ts 提供) */
export interface PanelStatus {
  busy: boolean;
  scrollAvailable: boolean;
  /** 设备侧总静音 (来自连接时的 cfg 快照; undefined = 未知) */
  muted?: boolean;
  /** 设备侧三类音量 (同上) */
  sounds?: SoundVolumes;
}

/* ---------------- 公共入口 ---------------- */

export async function showPanel(
  ctx: ExtensionContext,
  channel: DeckChannel,
  config: DeckConfig,
  getStatus: () => PanelStatus,
): Promise<PanelAction | null> {
  if (ctx.mode === "tui") return showPanelTui(ctx, channel, config, getStatus);
  return showPanelFallback(ctx, channel, config);
}

/* ---------------- TUI 仪表盘 ---------------- */

async function showPanelTui(
  ctx: ExtensionContext,
  channel: DeckChannel,
  config: DeckConfig,
  getStatus: () => PanelStatus,
): Promise<PanelAction | null> {
  for (;;) {
    /* 每次进入面板主动刷新一次信号强度 (超时/失败回退缓存) */
    if (channel.connected) await channel.refreshRssi();
    const pick = await mainMenu(ctx, channel, config, getStatus);
    if (!pick) return null; // Esc / 退出

    switch (pick) {
      case "bind": {
        const name = await scanFlow(ctx, channel);
        if (name) return { kind: "bind-device", name };
        continue; // 取消扫描 → 回主面板
      }
      case "macro-2":
      case "macro-3": {
        const index = pick === "macro-2" ? 0 : 1;
        const text = await ctx.ui.input(
          `KEY${index + 2} 宏内容 — 发送给 agent 的提示词`,
          config.macros[index] ?? (index === 0 ? "继续" : "不对"),
        );
        if (text === undefined || !text.trim()) continue;
        return { kind: "edit-macro", index, text: text.trim() };
      }
      case "led": {
        const state = await ledFlow(ctx, channel);
        if (state) return { kind: "test-led", state };
        continue; // 取消 → 回主面板
      }
      case "settings": {
        const next = await settingsFlow(ctx, channel, config, getStatus());
        if (next) return { kind: "settings", ...next };
        continue;
      }
      case "reconnect":
        return { kind: "reconnect" };
      default:
        return null;
    }
  }
}

/* ---------------- 布局工具 ---------------- */

/** 单行 Text (无上下空行/左右缩进) */
const line = (s: string) => new Text(s, 0, 0);

/** 整宽水平分隔线 (随宽度铺满) */
class Rule {
  constructor(private style: (s: string) => string) {}
  invalidate(): void {}
  render(width: number): string[] {
    return [this.style("─".repeat(Math.max(1, width)))];
  }
}

function padTo(s: string, width: number): string {
  const rest = width - visibleWidth(s);
  return rest > 0 ? s + " ".repeat(rest) : truncateToWidth(s, width);
}

/** 左对齐 + 右对齐铺满一行; 空间不足时退化为左内容截断 */
function spread(left: string, right: string, width: number): string {
  const lw = visibleWidth(left);
  const rw = visibleWidth(right);
  if (lw + rw + 1 > width) return truncateToWidth(left, width);
  return left + " ".repeat(width - lw - rw) + right;
}

/** 圆角状态框: 内容行左右各留 1 空格, 框线用 accent 色 */
function boxed(content: string[], width: number, border: (s: string) => string): string[] {
  const inner = Math.max(1, width - 4);
  const edge = "─".repeat(Math.max(1, width - 2));
  const close = border("│");
  return [
    border(`╭${edge}╮`),
    ...content.map((l) => `${close} ${padTo(l, inner)} ${close}`),
    border(`╰${edge}╯`),
  ];
}

/** RSSI → 4 段信号条 (BLE 常见区间 -50 ~ -85 dBm) */
function rssiBars(rssi: number | null): string {
  if (rssi === null) return "▁▁▁▁";
  if (rssi >= -55) return "▂▄▆█";
  if (rssi >= -65) return "▂▄▆▁";
  if (rssi >= -75) return "▂▄▁▁";
  return "▂▁▁▁";
}

function rssiText(rssi: number | null): string {
  return rssi === null ? "信号未知" : `${rssiBars(rssi)} ${rssi} dBm`;
}

/* ---------------- 主菜单 ---------------- */

function mainMenu(
  ctx: ExtensionContext,
  channel: DeckChannel,
  config: DeckConfig,
  getStatus: () => PanelStatus,
): Promise<string | null> {
  const macro2 = config.macros[0] ?? "(未配置)";
  const macro3 = config.macros[1] ?? "(未配置)";
  const sounds = soundVolumes(config);

  return ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
    /* --- 菜单项 --- */
    const items: SelectItem[] = [
      { value: "bind", label: "扫描 / 绑定设备", description: "发现附近设备, 按信号强度排序" },
      { value: "macro-2", label: "编辑宏 KEY2", description: `当前「${macro2}」` },
      { value: "macro-3", label: "编辑宏 KEY3", description: `当前「${macro3}」` },
      {
        value: "led",
        label: "测试灯效与提示音",
        description: "推送 auto / busy / attention / done / error / idle",
      },
      {
        value: "settings",
        label: "声音与灯光",
        description: `亮度 ${config.brightness}% · 声音 ${sounds[0]}/${sounds[1]}/${sounds[2]}%`,
      },
      { value: "reconnect", label: "重新连接", description: "断开后立即重连" },
      { value: "exit", label: "退出", description: "关闭面板" },
    ];
    const list = new SelectList(items, items.length, {
      selectedPrefix: (t) => theme.fg("accent", t),
      selectedText: (t) => theme.fg("accent", theme.bold(t)),
      description: (t) => theme.fg("muted", t),
      scrollInfo: (t) => theme.fg("dim", t),
      noMatch: (t) => theme.fg("warning", t),
    });
    list.onSelect = (item) => done(item.value);
    list.onCancel = () => done(null);

    /* --- 渲染 --- */
    let cachedWidth: number | undefined;
    let cachedLines: string[] | undefined;
    const invalidate = () => {
      cachedWidth = undefined;
      cachedLines = undefined;
      list.invalidate();
    };

    const render = (width: number): string[] => {
      if (cachedLines && cachedWidth === width) return cachedLines;
      const w = Math.max(20, width);
      const inner = Math.max(1, w - 4);

      /* 状态行每帧实时读取: 连接成功后后台重连可立即反映到面板 */
      const status = getStatus();
      const rssi = channel.rssi;
      const connLeft = channel.connected
        ? `${theme.fg("success", "●")} 已连接  ${theme.bold(channel.deviceName)}`
        : `${theme.fg("warning", "○")} 未连接  ${theme.fg("muted", "LED 心跳待命")}`;
      const connRight = channel.connected
        ? theme.fg(rssi === null ? "muted" : rssi >= -75 ? "success" : "warning", rssiText(rssi))
        : theme.fg("dim", "后台重连中 ...");
      const sessionLeft = status.busy
        ? `${theme.fg("accent", "◐")} agent 运行中`
        : `${theme.fg("muted", "◯")} agent 空闲`;
      const sessionRight = status.scrollAvailable
        ? theme.fg("muted", "旋钮滚动可用")
        : theme.fg("dim", "旋钮滚动不可用");

      const title = spread(
        theme.bold(theme.fg("accent", "AgentDock")) + theme.fg("muted", " 管理面板"),
        theme.fg("dim", "/dock"),
        w,
      );

      const legend = spread(
        theme.fg("muted", "按键 ") +
          theme.fg("text", "KEY1") + theme.fg("dim", " 打断/长按声音总开关 · ") +
          theme.fg("text", "KEY2") + theme.fg("dim", `「${macro2}」/长按演示 · `) +
          theme.fg("text", "KEY3") + theme.fg("dim", `「${macro3}」`),
        theme.fg("muted", "旋钮 ") + theme.fg("dim", "滚动/继续"),
        w,
      );

      const rule = theme.fg("borderMuted", "─".repeat(w));

      const out: string[] = [
        title,
        "",
        ...boxed(
          [
            spread(connLeft, connRight, inner),
            spread(sessionLeft, sessionRight, inner),
          ],
          w,
          (s) => theme.fg("border", s),
        ),
        legend,
        rule,
        ...list.render(w),
        rule,
        theme.fg("dim", "↑↓ 移动 · Enter 确认 · Esc 关闭"),
      ];
      cachedWidth = width;
      cachedLines = out.map((l) => truncateToWidth(l, width));
      return cachedLines;
    };

    /* 连接状态变化 (后台重连成功/断开) → 刷新 RSSI 并重绘面板,
     * 否则面板会停在打开时的快照上, 只有底部状态栏在变 */
    const unsubscribe = channel.onConnectionChange((connected) => {
      const refresh = connected ? channel.refreshRssi() : Promise.resolve(null);
      void refresh.then(() => {
        invalidate();
        tui.requestRender();
      });
    });

    return {
      render,
      invalidate,
      handleInput: (data: string) => {
        list.handleInput(data);
        invalidate(); // 选中项可能已变 → 丢弃合成缓存, 否则箭头不动
        tui.requestRender();
      },
      dispose: () => unsubscribe(),
    };
  });
}

/* ---------------- 扫描流程 ---------------- */

function scanFlow(ctx: ExtensionContext, channel: DeckChannel): Promise<string | null> {
  return ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
    const container = new Container();
    const rule = () => new Rule((s) => theme.fg("borderMuted", s));

    container.addChild(line(theme.bold(theme.fg("accent", "扫描 AgentDock 设备"))));
    const headRule = new Rule((s) => theme.fg("borderMuted", s));
    container.addChild(headRule);

    const loader = new Loader(
      tui,
      (s) => theme.fg("accent", s),
      (s) => theme.fg("muted", s),
      "BLE 扫描中 (约 8s) · Esc 取消",
    );
    container.addChild(loader);
    container.addChild(rule());

    let list: SelectList | null = null;
    let resolved = false;
    const finish = (name: string | null) => {
      if (resolved) return;
      resolved = true;
      loader.stop();
      done(name);
    };

    loader.start();
    void channel.scan().then((devices) => {
      if (resolved) return; // 用户已取消
      container.removeChild(loader);
      container.removeChild(headRule);
      if (!devices.length) {
        finish(null);
        return;
      }
      const items: SelectItem[] = devices.map((d: DeckPeripheralInfo) => {
        const bound = channel.connected && d.name === channel.deviceName;
        return {
          value: d.name,
          label: bound ? `${d.name} ${theme.fg("success", "✓")}` : d.name,
          description:
            theme.fg(d.rssi >= -75 ? "success" : "warning", rssiBars(d.rssi)) +
            theme.fg("muted", ` ${String(d.rssi).padStart(4)} dBm`) +
            (bound ? theme.fg("dim", "  · 当前绑定") : ""),
        };
      });
      list = new SelectList(items, Math.min(items.length, 8), {
        selectedPrefix: (t) => theme.fg("accent", t),
        selectedText: (t) => theme.fg("accent", theme.bold(t)),
        description: (t) => t,
        scrollInfo: (t) => theme.fg("dim", t),
        noMatch: (t) => theme.fg("warning", t),
      });
      list.onSelect = (item) => finish(item.value);
      list.onCancel = () => finish(null);
      container.addChild(
        line(theme.fg("muted", `发现 ${devices.length} 台设备 · 回车绑定 · Esc 取消`)),
      );
      container.addChild(list);
      container.addChild(rule());
      container.invalidate();
      tui.requestRender();
    });

    return {
      render: (width: number) => container.render(width).map((l) => truncateToWidth(l, width)),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        if (data === "\x1b") {
          finish(null);
          return;
        }
        list?.handleInput(data);
        tui.requestRender();
      },
      dispose: () => loader.stop(),
    };
  });
}

/* ---------------- 灯效测试 ---------------- */

function ledFlow(ctx: ExtensionContext, channel: DeckChannel): Promise<string | null> {
  return ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
    const container = new Container();
    const rule = () => new Rule((s) => theme.fg("borderMuted", s));

    container.addChild(
      line(
        theme.bold(theme.fg("accent", "测试灯效与提示音")) +
          theme.fg("muted", "  推送一次状态给设备 (含对应提示音)"),
      ),
    );
    if (!channel.connected) {
      container.addChild(line(theme.fg("warning", "⚠ 设备未连接, 推送不会生效")));
    }
    container.addChild(rule());

    /* label 自带彩色圆点 → selectedText 保持原样, 不整体染色 */
    const items: SelectItem[] = [
      {
        value: "demo",
        label: `${theme.fg("accent", "●")} auto`,
        description: "七彩呼吸一次 (约 3s) 后自动回当前状态",
      },
      { value: "busy", label: `${theme.fg("success", "●")} busy`, description: "绿色呼吸 · agent 运行中" },
      {
        value: "attention",
        label: `${theme.fg("warning", "●")} attention`,
        description: "琥珀双脉冲 + 提示音 · agent 等你处理",
      },
      { value: "done", label: `${theme.fg("text", "●")} done`, description: "白色闪烁 + 完成音 · 任务结束" },
      { value: "error", label: `${theme.fg("error", "●")} error`, description: "红色闪烁 + 出错音 · 真的失败" },
      { value: "idle", label: `${theme.fg("accent", "●")} idle`, description: "蓝色微亮 · 待命" },
    ];
    const list = new SelectList(items, items.length, {
      selectedPrefix: (t) => theme.fg("accent", t),
      selectedText: (t) => t,
      description: (t) => theme.fg("muted", t),
      scrollInfo: (t) => theme.fg("dim", t),
      noMatch: (t) => theme.fg("warning", t),
    });
    list.onSelect = (item) => done(item.value);
    list.onCancel = () => done(null);
    container.addChild(list);
    container.addChild(rule());
    container.addChild(line(theme.fg("dim", "↑↓ 移动 · Enter 推送 · Esc 取消")));

    return {
      render: (width: number) => container.render(width).map((l) => truncateToWidth(l, width)),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        list.handleInput(data);
        tui.requestRender();
      },
    };
  });
}

/* ---------------- 声音与灯光设置 ---------------- */

/* 10% 一档: 11 个值, Enter/Space 循环; 配合设备侧的实时生效就是滑动条 */
const PCT_VALUES = Array.from({ length: 11 }, (_, i) => `${i * 10}%`);

/** 三类声音的滑杆定义 — index 与固件 sound_cat_t 一致 */
const SOUND_ROWS: { id: string; index: 0 | 1 | 2; label: string; tip: string }[] = [
  { id: "sound-key", index: 0, label: "按键音", tip: "KEY1/2/3 与旋钮按压的确认音 (0% = 关)" },
  { id: "sound-knob", index: 1, label: "旋钮刻度音", tip: "旋转时的齿轮声 (0% = 关), 默认比其它两类轻" },
  { id: "sound-agent", index: 2, label: "agent 提示音", tip: "完成 / 出错 / 需要你处理 (0% = 关)" },
];

function settingsFlow(
  ctx: ExtensionContext,
  channel: DeckChannel,
  config: DeckConfig,
  device: PanelStatus = { busy: false, scrollAvailable: false },
): Promise<{ brightness: number; sounds: SoundVolumes; muted: boolean } | null> {
  return ctx.ui.custom<{ brightness: number; sounds: SoundVolumes; muted: boolean } | null>(
    (tui, theme, _kb, done) => {
      const container = new Container();
      let brightness = config.brightness;
      const sounds: SoundVolumes = [...soundVolumes(config)] as SoundVolumes;
      let muted = device.muted ?? config.muted;

      container.addChild(
        line(
          theme.bold(theme.fg("accent", "声音与灯光")) +
            theme.fg("muted", "  改一档立即生效并写入设备"),
        ),
      );
      if (!channel.connected) {
        container.addChild(
          line(theme.fg("warning", "⚠ 设备未连接: 调整不会生效, 连上后以设备当前值为准")),
        );
      } else if (muted) {
        /* 总静音是设备侧总开关: 这时调音量听不到, 必须先解除静音 */
        container.addChild(
          line(theme.fg("warning", "⚠ 总静音中: 试听音听不到 (把「总静音」切到「关」或长按 KEY1)")),
        );
      }
      const flags = [
        `按键 ${sounds[0]}%`,
        `旋钮 ${sounds[1]}%`,
        `agent ${sounds[2]}%`,
        muted ? "总静音 开" : "总静音 关",
      ];
      container.addChild(line(theme.fg("dim", `设备状态: ${flags.join(" · ")}`)));
      container.addChild(new Rule((s) => theme.fg("borderMuted", s)));

      const items: SettingItem[] = [
        {
          id: "brightness",
          label: "LED 亮度",
          currentValue: `${brightness}%`,
          values: PCT_VALUES,
          description: "WS2812 明暗, 改一档立即生效 (0% = 全灭)",
        },
        ...SOUND_ROWS.map((row) => ({
          id: row.id,
          label: row.label,
          currentValue: `${sounds[row.index]}%`,
          values: PCT_VALUES,
          description: row.tip,
        })),
        {
          id: "mute",
          label: "总静音",
          currentValue: muted ? "开" : "关",
          values: ["关", "开"],
          description: "一键关掉三类声音; 设备上长按 KEY1 也能切换",
        },
      ];

      const list = new SettingsList(
        items,
        items.length,
        {
          label: (t, selected) => (selected ? theme.fg("accent", theme.bold(t)) : theme.fg("text", t)),
          value: (t, selected) => (selected ? theme.fg("accent", t) : theme.fg("muted", t)),
          description: (t) => theme.fg("muted", t),
          cursor: theme.fg("accent", "→ "),
          /* SettingsList 自带的提示是英文 "Esc to cancel"; 这里值已经实时下发,
           * Esc 是「完成」而非取消 —— 直接替换成自己的文案 */
          hint: () => theme.fg("dim", "  ↑↓ 选择 · Enter/Space 增减 10% · Esc 完成"),
        },
        (id, value) => {
          if (id === "brightness") {
            brightness = clampPct(parseInt(value, 10), brightness);
            if (channel.connected) channel.writeConfig({ brightness });
          } else if (id === "mute") {
            muted = value === "开";
            if (channel.connected) {
              channel.writeConfig({ muted });
              /* 解除静音时给一个确认音, 否则面板里点完没任何反馈 */
              if (!muted) channel.previewSound(0);
            }
          } else {
            const row = SOUND_ROWS.find((r) => r.id === id);
            if (!row) return;
            sounds[row.index] = clampPct(parseInt(value, 10), sounds[row.index]);
            /* 实时预览: 每改一档立即下发新音量, 再用该类代表音试听
             * (worker 侧串行处理, 保证「先设音量, 再试听」) */
            if (channel.connected) {
              channel.writeConfig({ sounds });
              channel.previewSound(row.index);
            }
          }
          tui.requestRender();
        },
        () => done({ brightness, sounds, muted }),
      );
      container.addChild(list);

      return {
        render: (width: number) => container.render(width).map((l) => truncateToWidth(l, width)),
        invalidate: () => container.invalidate(),
        handleInput: (data: string) => {
          list.handleInput(data);
          container.invalidate(); // 选中项可能已变 → 丢弃合成缓存
          tui.requestRender();
        },
      };
    },
  );
}

/* ---------------- 非 TUI 回退 (标准对话框) ---------------- */

async function showPanelFallback(
  ctx: ExtensionContext,
  channel: DeckChannel,
  config: DeckConfig,
): Promise<PanelAction | null> {
  const status = channel.connected
    ? `✅ 已连接 ${channel.deviceName} (${rssiText(channel.rssi)})`
    : "⚪ 未连接 (设备 LED 心跳待命)";
  const macroLine = `KEY2→${config.macros[0] ?? "(空)"}   KEY3→${config.macros[1] ?? "(空)"}`;

  const sounds = soundVolumes(config);
  const choice = await ctx.ui.select(
    `AgentDock 管理面板 (/dock)\n${status}\n${macroLine}\n` +
      `声音: 按键 ${sounds[0]}% · 旋钮 ${sounds[1]}% · agent ${sounds[2]}%` +
      `${config.muted ? " · 总静音" : ""}`,
    [
      "扫描 / 绑定设备",
      "编辑宏 KEY2",
      "编辑宏 KEY3",
      "测试灯效与提示音",
      "声音与灯光",
      "重新连接",
      "退出",
    ],
  );
  if (choice === undefined) return null;

  switch (choice) {
    case "扫描 / 绑定设备": {
      ctx.ui.notify("正在扫描 (8s) ...");
      const devices = await channel.scan();
      if (!devices.length) {
        ctx.ui.notify("未发现 AgentDock 设备", "warning");
        return null;
      }
      const picked = await ctx.ui.select(
        `发现 ${devices.length} 台设备 (按信号强度排序, 回车绑定):`,
        devices.map((d) => `${d.name}   ${rssiText(d.rssi)}`),
      );
      if (picked === undefined) return null;
      const name = picked.split(/\s{2,}/)[0];
      return { kind: "bind-device", name };
    }

    case "编辑宏 KEY2":
    case "编辑宏 KEY3": {
      const index = choice === "编辑宏 KEY2" ? 0 : 1;
      const placeholder = index === 0 ? "继续" : "不对";
      const text = await ctx.ui.input(
        `KEY${index + 2} 宏内容 (发送给 agent 的提示词)`,
        config.macros[index] ?? placeholder,
      );
      if (text === undefined || !text.trim()) return null;
      return { kind: "edit-macro", index, text: text.trim() };
    }

    case "测试灯效与提示音": {
      const s = await ctx.ui.select("测试哪个状态?", [
        "demo — 七彩呼吸一次",
        "busy — 绿色呼吸",
        "attention — 琥珀双脉冲 + 提示音",
        "done — 白色闪烁 + 完成音",
        "error — 红色闪烁 + 出错音",
        "idle — 蓝色微亮",
      ]);
      if (s === undefined) return null;
      const state = s.split(" ")[0]; // "demo" | "busy" | ...
      return { kind: "test-led", state };
    }

    case "声音与灯光": {
      const pick = async (title: string, current: number): Promise<number | undefined> => {
        const opts = PCT_VALUES;
        const sel = await ctx.ui.select(`${title} (当前 ${current}%)`, opts);
        if (sel === undefined) return undefined;
        return clampPct(parseInt(sel, 10), current);
      };
      const brightness = await pick("LED 亮度", config.brightness);
      if (brightness === undefined) return null;
      const next: SoundVolumes = [...soundVolumes(config)] as SoundVolumes;
      for (const row of SOUND_ROWS) {
        const v = await pick(row.label, next[row.index]);
        if (v === undefined) return null;
        next[row.index] = v;
      }
      const mutedPick = await ctx.ui.select(`总静音 (当前 ${config.muted ? "开" : "关"})`, [
        "关",
        "开",
      ]);
      if (mutedPick === undefined) return null;
      return { kind: "settings", brightness, sounds: next, muted: mutedPick === "开" };
    }

    case "重新连接":
      return { kind: "reconnect" };

    default:
      return null;
  }
}
