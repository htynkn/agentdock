/*
 * config.ts — 智坞 AgentDock 扩展配置持久化
 *
 * 存放: ~/.pi/agent/agentdock.json
 * 人可直接编辑; 扩展经 /dock 面板修改后写回.
 *
 * 注意 brightness / volume 只是「面板显示用缓存」: 设备 NVS 才是唯一真源,
 * 每次连上设备都会以设备上报的值覆盖本地 (见 index.ts 的 cfg 事件).
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
  /** LED 亮度 0~100 (设备寄存器为准, 连接后同步) */
  brightness: number;
  /** 蜂鸣器音量 0~100 (设备寄存器为准, 连接后同步) */
  volume: number;
}

export const DEFAULT_BRIGHTNESS = 100;
export const DEFAULT_VOLUME = 100;

const DEFAULTS: DeckConfig = {
  preferredDevice: "",
  macros: ["继续", "不对"],
  brightness: DEFAULT_BRIGHTNESS,
  volume: DEFAULT_VOLUME,
};

const CONFIG_PATH = join(homedir(), ".pi", "agent", "agentdock.json");

/** 百分比钳制: 只接受数字 (或纯数字字符串), 其余 (null/undefined/"abc") 回落 fallback */
export function clampPct(value: unknown, fallback: number): number {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(100, Math.max(0, Math.round(n)));
}

export function loadConfig(): DeckConfig {
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<DeckConfig>;
    return {
      preferredDevice: raw.preferredDevice ?? DEFAULTS.preferredDevice,
      macros: Array.isArray(raw.macros) && raw.macros.length ? raw.macros : DEFAULTS.macros,
      brightness: clampPct(raw.brightness, DEFAULT_BRIGHTNESS),
      volume: clampPct(raw.volume, DEFAULT_VOLUME),
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
