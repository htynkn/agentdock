/*
 * config.ts — 智坞 AgentDock 扩展配置持久化
 *
 * 存放: ~/.pi/agent/agentdock.json
 * 人可直接编辑; 扩展经 /dock 面板修改后写回.
 *
 * 注意 brightness / 三类音量 / muted 只是「面板显示用缓存」: 设备 NVS 才是
 * 唯一真源, 每次连上设备都会以设备上报的值覆盖本地 (见 index.ts 的 cfg 事件).
 */
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** 三类声音的音量 (0~100, 0 = 该类关闭) */
export type SoundVolumes = [number, number, number];

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
  /** 按键音音量 (KEY1/2/3 与旋钮按压) */
  keyVolume: number;
  /** 旋钮旋转刻度音音量 */
  knobVolume: number;
  /** agent 提示音音量 (完成/出错/需要人处理) */
  agentVolume: number;
  /** 总静音: 一键关掉三类声音 (KEY1 长按切换) */
  muted: boolean;
}

export const DEFAULT_BRIGHTNESS = 100;
export const DEFAULT_KEY_VOLUME = 100;
/** 刻度音最频繁, 默认压低一档, 手感更好 */
export const DEFAULT_KNOB_VOLUME = 60;
export const DEFAULT_AGENT_VOLUME = 100;

/** 声音类别序号 (与固件 sound_cat_t 一致) */
export const SOUND_KEY = 0;
export const SOUND_KNOB = 1;
export const SOUND_AGENT = 2;

const DEFAULTS: DeckConfig = {
  preferredDevice: "",
  macros: ["继续", "不对"],
  brightness: DEFAULT_BRIGHTNESS,
  keyVolume: DEFAULT_KEY_VOLUME,
  knobVolume: DEFAULT_KNOB_VOLUME,
  agentVolume: DEFAULT_AGENT_VOLUME,
  muted: false,
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

/** 三类音量 → 定长元组 (出站报文与面板都用这个形状) */
export function soundVolumes(config: DeckConfig): SoundVolumes {
  return [config.keyVolume, config.knobVolume, config.agentVolume];
}

export function loadConfig(): DeckConfig {
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<DeckConfig> & {
      /** 旧版单一音量 (0.3.x): 升级时作为三类音量初值 */
      volume?: unknown;
    };
    /* 旧配置没有分类型音量: 用旧 volume 填充, 保持升级前后响度一致;
     * 旧配置也没有 volume 时, 各类用自己的默认值 (旋钮音默认更轻) */
    const legacy = clampPct(raw.volume, Number.NaN);
    const fallback = (own: number) => (Number.isFinite(legacy) ? legacy : own);
    return {
      preferredDevice: raw.preferredDevice ?? DEFAULTS.preferredDevice,
      macros: Array.isArray(raw.macros) && raw.macros.length ? raw.macros : DEFAULTS.macros,
      brightness: clampPct(raw.brightness, DEFAULT_BRIGHTNESS),
      keyVolume: clampPct(raw.keyVolume, fallback(DEFAULT_KEY_VOLUME)),
      knobVolume: clampPct(raw.knobVolume, fallback(DEFAULT_KNOB_VOLUME)),
      agentVolume: clampPct(raw.agentVolume, fallback(DEFAULT_AGENT_VOLUME)),
      muted: raw.muted === true,
    };
  } catch {
    return { ...DEFAULTS, macros: [...DEFAULTS.macros] };
  }
}

export function saveConfig(config: DeckConfig): void {
  const payload = JSON.stringify(config, null, 2);
  /* 原子写: 临时文件 + rename (同分区 rename 是原子的), 中途崩溃不会写坏配置 */
  const tmp = CONFIG_PATH + ".tmp";
  writeFileSync(tmp, payload, "utf8");
  renameSync(tmp, CONFIG_PATH);
}
