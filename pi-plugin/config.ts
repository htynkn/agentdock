/*
 * config.ts — 智坞 AgentDock 扩展配置持久化
 *
 * 存放: ~/.pi/agent/agentdock.json
 * 人可直接编辑; 扩展经 /deck 面板修改后写回.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface DeckConfig {
  /** 首选设备广播名 (AgentDock-XXXX); 空 = 自动连接唯一/首个发现的设备 */
  preferredDevice: string;
  /**
   * 宏表: 设备按键触发, {"k":"key","id":N} 时查此表
   *   [0] → KEY2「继续」(肯定/推进)   [1] → KEY3「不对」(否定/要求重来)
   */
  macros: string[];
}

const DEFAULTS: DeckConfig = {
  preferredDevice: "",
  macros: ["继续", "不对"],
};

const CONFIG_PATH = join(homedir(), ".pi", "agent", "agentdock.json");

export function loadConfig(): DeckConfig {
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<DeckConfig>;
    return {
      preferredDevice: raw.preferredDevice ?? DEFAULTS.preferredDevice,
      macros: Array.isArray(raw.macros) && raw.macros.length ? raw.macros : DEFAULTS.macros,
    };
  } catch {
    return { ...DEFAULTS, macros: [...DEFAULTS.macros] };
  }
}

export function saveConfig(config: DeckConfig): void {
  const payload = JSON.stringify(config, null, 2);
  // 原子写: 先写临时文件再改名
  const tmp = CONFIG_PATH + ".tmp";
  writeFileSync(tmp, payload, "utf8");
  writeFileSync(CONFIG_PATH, payload, "utf8");
}
