/*
 * panel.ts — /dock 可视化管理面板
 *
 * TUI 模式: ctx.ui.custom() 渲染主题化仪表盘 (状态区 + SelectList 菜单),
 *   扫描流程带 Loader 动画与信号强度条, 灯效测试用彩色圆点;
 * RPC 等非交互模式: 回退到 ctx.ui 标准对话框 (逻辑等价).
 * 面板只负责交互, 不直接操作 BLE — 返回动作由 index.ts 执行.
 * 面板状态 (busy / 旋钮) 为打开时刻的快照, 每次操作后循环重开即刷新.
 */
import { DynamicBorder, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, Loader, type SelectItem, SelectList, Text, truncateToWidth } from "@earendil-works/pi-tui";
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
    const pick = await mainMenu(ctx, channel, config, status);
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

/* 主菜单: 返回用户选择的子流程标识, null = 关闭面板 */
function mainMenu(
  ctx: ExtensionContext,
  channel: DeckChannel,
  config: DeckConfig,
  status: PanelStatus,
): Promise<string | null> {
  const macro2 = config.macros[0] ?? "(未配置)";
  const macro3 = config.macros[1] ?? "(未配置)";

  return ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
    const container = new Container();
    const border = () => new DynamicBorder((s) => theme.fg("borderMuted", s));
    const pad = (s: string) => `  ${s}`;

    /* 标题 + 连接状态 */
    container.addChild(
      new Text(theme.bold(theme.fg("accent", "AgentDock 管理面板")) + theme.fg("dim", "  ·  /dock")),
    );
    const conn = channel.connected
      ? theme.fg("success", `● 已连接 ${channel.deviceName}`)
      : theme.fg("warning", "○ 未连接 · 设备 LED 心跳待命");
    const session = status.busy
      ? theme.fg("accent", "agent 运行中")
      : theme.fg("muted", "agent 空闲");
    const scroll = status.scrollAvailable
      ? theme.fg("muted", "旋钮滚动可用")
      : theme.fg("dim", "旋钮滚动不可用");
    container.addChild(new Text(pad(`设备  ${conn}`)));
    container.addChild(new Text(pad(`会话  ${session} · ${scroll}`)));
    container.addChild(new Text(pad(`宏    KEY2「${macro2}」 · KEY3「${macro3}」`)));
    container.addChild(border());

    /* 菜单 */
    const items: SelectItem[] = [
      { value: "bind", label: "扫描 / 绑定设备", description: "发现附近 AgentDock, 按信号强度排序" },
      { value: "macro-2", label: "编辑宏 KEY2", description: `当前: ${macro2}` },
      { value: "macro-3", label: "编辑宏 KEY3", description: `当前: ${macro3}` },
      { value: "led", label: "测试灯效", description: "向设备推送状态灯效" },
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
    container.addChild(list);

    container.addChild(border());
    container.addChild(new Text(theme.fg("dim", "  ↑↓ 移动 · Enter 确认 · Esc 关闭")));

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

/* 扫描流程: Loader 动画 → 设备列表 (信号强度条). 返回选中的设备名, null = 取消/无设备 */
function scanFlow(ctx: ExtensionContext, channel: DeckChannel): Promise<string | null> {
  return ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
    const container = new Container();
    const border = () => new DynamicBorder((s) => theme.fg("borderMuted", s));

    container.addChild(new Text(theme.bold(theme.fg("accent", "扫描 AgentDock 设备"))));
    container.addChild(border());

    const loader = new Loader(
      tui,
      (s) => theme.fg("accent", s),
      (s) => theme.fg("muted", s),
      "BLE 扫描中 (约 8s), Esc 取消 ...",
    );
    container.addChild(loader);
    container.addChild(border());

    let list: SelectList | null = null;
    let resolved = false;
    const finish = (name: string | null) => {
      if (resolved) return;
      resolved = true;
      done(name);
    };

    loader.start();
    void channel.scan().then((devices) => {
      if (resolved) return; // 用户已取消
      loader.stop();
      container.removeChild(loader);
      if (!devices.length) {
        finish(null);
        return;
      }
      const items: SelectItem[] = devices.map((d: DeckPeripheralInfo) => ({
        value: d.name,
        label: d.name,
        description: `${rssiBars(d.rssi)} ${d.rssi} dBm`,
      }));
      list = new SelectList(items, Math.min(items.length, 8), {
        selectedPrefix: (t) => theme.fg("accent", t),
        selectedText: (t) => theme.fg("accent", theme.bold(t)),
        description: (t) => theme.fg("muted", t),
        scrollInfo: (t) => theme.fg("dim", t),
        noMatch: (t) => theme.fg("warning", t),
      });
      list.onSelect = (item) => finish(item.value);
      list.onCancel = () => finish(null);
      container.addChild(
        new Text(theme.fg("muted", `  发现 ${devices.length} 台设备 — 回车绑定, Esc 取消`)),
      );
      container.addChild(list);
      container.addChild(border());
      container.invalidate();
      tui.requestRender();
    });

    return {
      render: (width: number) => container.render(width).map((l) => truncateToWidth(l, width)),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        if (data === "\x1b") {
          loader.stop();
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

/* 灯效测试: 彩色圆点列表. 返回状态名, null = 取消 */
function ledFlow(ctx: ExtensionContext, channel: DeckChannel): Promise<string | null> {
  return ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
    const connected = channel.connected;
    const container = new Container();
    const border = () => new DynamicBorder((s) => theme.fg("borderMuted", s));

    container.addChild(new Text(theme.bold(theme.fg("accent", "测试灯效")) + theme.fg("dim", "  ·  选择要推送的状态")));
    if (!connected) {
      container.addChild(new Text(theme.fg("warning", "  ⚠ 设备未连接, 推送将不会生效")));
    }
    container.addChild(border());

    /* label 自带彩色圆点 → selectedText 保持原样, 不再整体包色 */
    const items: SelectItem[] = [
      { value: "busy", label: `${theme.fg("success", "●")} busy`, description: "绿色呼吸 — agent 运行中" },
      { value: "done", label: `${theme.fg("text", "●")} done`, description: "白色双闪 — 任务完成" },
      { value: "error", label: `${theme.fg("error", "●")} error`, description: "红色三连闪 — 工具出错" },
      { value: "idle", label: `${theme.fg("accent", "●")} idle`, description: "蓝色微亮 — 待命" },
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
    container.addChild(border());
    container.addChild(new Text(theme.fg("dim", "  ↑↓ 移动 · Enter 推送 · Esc 取消")));

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

/** RSSI → 信号强度条 (BLE 常见区间 -40 ~ -95 dBm) */
function rssiBars(rssi: number): string {
  if (rssi >= -55) return "▂▄▆█";
  if (rssi >= -67) return "▂▄▆ ";
  if (rssi >= -78) return "▂▄  ";
  return "▂   ";
}

/* ---------------- 非 TUI 回退 (标准对话框) ---------------- */

async function showPanelFallback(
  ctx: ExtensionContext,
  channel: DeckChannel,
  config: DeckConfig,
): Promise<PanelAction | null> {
  const status = channel.connected
    ? `✅ 已连接 ${channel.deviceName}`
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
        devices.map((d) => `${d.name}   ${rssiBars(d.rssi)} ${d.rssi} dBm`),
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
