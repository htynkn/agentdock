/*
 * panel.ts — /dock 可视化管理面板
 *
 * TUI 模式: 手工合成布局 (圆角状态框 + 按键图例 + SelectList 菜单),
 *   状态框内显示连接状态、信号强度条、agent 状态与旋钮可用性;
 *   扫描流程带 Loader 动画与信号强度条, 灯效测试用彩色圆点;
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
  Text,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { DeckConfig } from "./config.js";
import type { DeckChannel, DeckPeripheralInfo } from "./ble.js";

export type PanelAction =
  | { kind: "bind-device"; name: string }
  | { kind: "edit-macro"; index: number; text: string }
  | { kind: "test-led"; state: string }
  | { kind: "reconnect" }
  | { kind: "exit" };

/** 面板展示用的会话状态快照 (由 index.ts 提供) */
export interface PanelStatus {
  busy: boolean;
  scrollAvailable: boolean;
}

/* ---------------- 公共入口 ---------------- */

export async function showPanel(
  ctx: ExtensionContext,
  channel: DeckChannel,
  config: DeckConfig,
  status: PanelStatus,
): Promise<PanelAction | null> {
  if (ctx.mode === "tui") return showPanelTui(ctx, channel, config, status);
  return showPanelFallback(ctx, channel, config);
}

/* ---------------- TUI 仪表盘 ---------------- */

async function showPanelTui(
  ctx: ExtensionContext,
  channel: DeckChannel,
  config: DeckConfig,
  status: PanelStatus,
): Promise<PanelAction | null> {
  for (;;) {
    /* 每次进入面板主动刷新一次信号强度 (超时/失败回退缓存) */
    const rssi = channel.connected ? await channel.refreshRssi() : null;
    const pick = await mainMenu(ctx, channel, config, status, rssi);
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
  status: PanelStatus,
  rssi: number | null,
): Promise<string | null> {
  const macro2 = config.macros[0] ?? "(未配置)";
  const macro3 = config.macros[1] ?? "(未配置)";

  return ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
    /* --- 状态框内容 --- */
    const connLeft = channel.connected
      ? `${theme.fg("success", "●")} 已连接  ${theme.bold(channel.deviceName)}`
      : `${theme.fg("warning", "○")} 未连接  ${theme.fg("muted", "LED 心跳待命")}`;
    const connRight = channel.connected
      ? theme.fg(rssi === null ? "muted" : rssi >= -75 ? "success" : "warning", rssiText(rssi))
      : theme.fg("dim", "— dBm");

    const sessionLeft = status.busy
      ? `${theme.fg("accent", "◐")} agent 运行中`
      : `${theme.fg("muted", "◯")} agent 空闲`;
    const sessionRight = status.scrollAvailable
      ? theme.fg("muted", "旋钮滚动可用")
      : theme.fg("dim", "旋钮滚动不可用");

    /* --- 菜单项 --- */
    const items: SelectItem[] = [
      { value: "bind", label: "扫描 / 绑定设备", description: "发现附近设备, 按信号强度排序" },
      { value: "macro-2", label: "编辑宏 KEY2", description: `当前「${macro2}」` },
      { value: "macro-3", label: "编辑宏 KEY3", description: `当前「${macro3}」` },
      { value: "led", label: "测试灯效", description: "推送 busy / done / error / idle" },
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

      const title = spread(
        theme.bold(theme.fg("accent", "AgentDock")) + theme.fg("muted", " 管理面板"),
        theme.fg("dim", "/dock"),
        w,
      );

      const legend = spread(
        theme.fg("muted", "按键 ") +
          theme.fg("text", "KEY1") + theme.fg("dim", " 打断/长按静音 · ") +
          theme.fg("text", "KEY2") + theme.fg("dim", `「${macro2}」 · `) +
          theme.fg("text", "KEY3") + theme.fg("dim", `「${macro3}」`),
        theme.fg("muted", "旋钮 ") + theme.fg("dim", "滚动/继续"),
        w,
      );

      const rule = theme.fg("borderMuted", "─".repeat(w));

      const out: string[] = [
        title,
        "",
        ...boxed(
          [spread(connLeft, connRight, Math.max(1, w - 4)), spread(sessionLeft, sessionRight, Math.max(1, w - 4))],
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

    return {
      render,
      invalidate,
      handleInput: (data: string) => {
        list.handleInput(data);
        tui.requestRender();
      },
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
      line(theme.bold(theme.fg("accent", "测试灯效")) + theme.fg("muted", "  推送一次状态给设备")),
    );
    if (!channel.connected) {
      container.addChild(line(theme.fg("warning", "⚠ 设备未连接, 推送不会生效")));
    }
    container.addChild(rule());

    /* label 自带彩色圆点 → selectedText 保持原样, 不整体染色 */
    const items: SelectItem[] = [
      { value: "busy", label: `${theme.fg("success", "●")} busy`, description: "绿色呼吸 · agent 运行中" },
      { value: "done", label: `${theme.fg("text", "●")} done`, description: "白色双闪 · 任务完成" },
      { value: "error", label: `${theme.fg("error", "●")} error`, description: "红色三连闪 · 工具出错" },
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

  const choice = await ctx.ui.select(
    `AgentDock 管理面板 (/dock)\n${status}\n${macroLine}`,
    ["扫描 / 绑定设备", "编辑宏 KEY2", "编辑宏 KEY3", "测试灯效", "重新连接", "退出"],
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

    case "测试灯效": {
      const s = await ctx.ui.select("测试哪个灯效?", [
        "busy — 绿色呼吸",
        "done — 白色双闪",
        "error — 红色三连闪",
        "idle — 蓝色微亮",
      ]);
      if (s === undefined) return null;
      const state = s.split(" ")[0]; // "busy" | "done" | ...
      return { kind: "test-led", state };
    }

    case "重新连接":
      return { kind: "reconnect" };

    default:
      return null;
  }
}
