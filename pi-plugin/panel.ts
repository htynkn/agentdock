/*
 * panel.ts — /deck 可视化管理面板
 *
 * pi 内输入 /deck 打开; 全部走 ctx.ui 标准对话框 (TUI/RPC 均可用).
 * 面板只负责交互, 不直接操作 BLE — 返回动作由 index.ts 执行.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { DeckConfig } from "./config.js";
import type { DeckChannel } from "./ble.js";

export type PanelAction =
  | { kind: "bind-device"; name: string }
  | { kind: "edit-macro"; index: number; text: string }
  | { kind: "test-led"; state: string }
  | { kind: "reconnect" }
  | { kind: "exit" };

export async function showPanel(
  ctx: ExtensionContext,
  channel: DeckChannel,
  config: DeckConfig,
): Promise<PanelAction | null> {
  const status = channel.connected
    ? `✅ 已连接 ${channel.deviceName}`
    : `⚪ 未连接 (设备 LED 心跳待命)`;
  const macroLine = `KEY2→${config.macros[0] ?? "(空)"}   KEY3→${config.macros[1] ?? "(空)"}`;

  const choice = await ctx.ui.select(
    `智坞 AgentDock 管理面板\n${status}\n${macroLine}`,
    ["切换/选择设备", "编辑宏 KEY2", "编辑宏 KEY3", "测试灯效", "重新连接", "退出"],
  );
  if (choice === undefined) return null;

  switch (choice) {
    case "切换/选择设备": {
      ctx.ui.notify("正在扫描 (8s) ...");
      const devices = await channel.scan();
      if (!devices.length) {
        ctx.ui.notify("未发现 AgentDock 设备", "warning");
        return null;
      }
      const picked = await ctx.ui.select(
        `发现 ${devices.length} 台设备 (按信号强度排序, 回车绑定):`,
        devices.map((d) => `${d.name}   ${d.rssi} dBm`),
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
      const state = s.split(" ")[0];   // "busy" | "done" | ...
      return { kind: "test-led", state };
    }

    case "重新连接":
      return { kind: "reconnect" };

    case "退出":
      return { kind: "exit" };

    default:
      return null;
  }
}
