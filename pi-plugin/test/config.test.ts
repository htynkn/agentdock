/*
 * config.test.ts — 配置持久化 (~/.pi/agent/agentdock.json)
 *
 * 用临时 HOME 目录隔离, 每个用例重新加载模块 (CONFIG_PATH 在模块加载时确定).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type ConfigModule = typeof import("../config.js");

let home: string;
let configPath: string;
let mod: ConfigModule;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "agentdock-config-"));
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  configPath = join(home, ".pi", "agent", "agentdock.json");

  vi.stubEnv("HOME", home);
  vi.resetModules();
  mod = await import("../config.js");
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

const DEFAULTS = {
  preferredDevice: "",
  macros: ["继续", "不对"],
  brightness: 100,
  keyVolume: 100,
  knobVolume: 60, // 刻度音最频繁, 默认压低一档
  agentVolume: 100,
  muted: false,
};

describe("loadConfig", () => {
  it("配置文件不存在时返回默认值", () => {
    expect(mod.loadConfig()).toEqual(DEFAULTS);
  });

  it("JSON 损坏时降级为默认值而不抛异常", () => {
    writeFileSync(configPath, "{ 这不是 JSON ", "utf8");
    expect(mod.loadConfig()).toEqual(DEFAULTS);
  });

  it("读取完整配置", () => {
    writeFileSync(
      configPath,
      JSON.stringify({ preferredDevice: "AgentDock-04A8", macros: ["继续吧", "重来"] }),
      "utf8",
    );
    expect(mod.loadConfig()).toEqual({
      preferredDevice: "AgentDock-04A8",
      macros: ["继续吧", "重来"],
      brightness: 100,
      keyVolume: 100,
      knobVolume: 60,
      agentVolume: 100,
      muted: false,
    });
  });

  it("亮度/三类音量读入并在越界时钳制到 0~100", () => {
    writeFileSync(
      configPath,
      JSON.stringify({ brightness: 55, keyVolume: 80, knobVolume: 30, agentVolume: 0 }),
      "utf8",
    );
    expect(mod.loadConfig()).toMatchObject({
      brightness: 55,
      keyVolume: 80,
      knobVolume: 30,
      agentVolume: 0,
    });

    writeFileSync(
      configPath,
      JSON.stringify({ brightness: 180, keyVolume: -20, knobVolume: 300 }),
      "utf8",
    );
    expect(mod.loadConfig()).toMatchObject({ brightness: 100, keyVolume: 0, knobVolume: 100 });

    writeFileSync(
      configPath,
      JSON.stringify({ brightness: "abc", agentVolume: null }),
      "utf8",
    );
    expect(mod.loadConfig()).toMatchObject({ brightness: 100, agentVolume: 100 });
  });

  it("旧版单一 volume 升级为三类音量 (不改变实际响度)", () => {
    writeFileSync(configPath, JSON.stringify({ volume: 30 }), "utf8");
    expect(mod.loadConfig()).toMatchObject({ keyVolume: 30, knobVolume: 30, agentVolume: 30 });
  });

  it("新字段优先于旧 volume", () => {
    writeFileSync(configPath, JSON.stringify({ volume: 30, keyVolume: 90 }), "utf8");
    expect(mod.loadConfig()).toMatchObject({ keyVolume: 90, knobVolume: 30, agentVolume: 30 });
  });

  it("muted 只接受布尔 true", () => {
    writeFileSync(configPath, JSON.stringify({ muted: true }), "utf8");
    expect(mod.loadConfig().muted).toBe(true);
    writeFileSync(configPath, JSON.stringify({ muted: "yes" }), "utf8");
    expect(mod.loadConfig().muted).toBe(false);
  });

  it("缺失字段逐项回退默认值", () => {
    writeFileSync(configPath, JSON.stringify({ preferredDevice: "AgentDock-1B2C" }), "utf8");
    const cfg = mod.loadConfig();
    expect(cfg.preferredDevice).toBe("AgentDock-1B2C");
    expect(cfg.macros).toEqual(DEFAULTS.macros);
  });

  it("macros 为空数组或非数组时回退默认值", () => {
    writeFileSync(configPath, JSON.stringify({ macros: [] }), "utf8");
    expect(mod.loadConfig().macros).toEqual(DEFAULTS.macros);

    writeFileSync(configPath, JSON.stringify({ macros: "继续" }), "utf8");
    expect(mod.loadConfig().macros).toEqual(DEFAULTS.macros);
  });

  it("每次返回独立的 macros 数组 (默认值不会被调用方改坏)", () => {
    const a = mod.loadConfig();
    a.macros.push("脏数据");
    expect(mod.loadConfig().macros).toEqual(DEFAULTS.macros);
  });
});

describe("saveConfig", () => {
  it("写入后可被 loadConfig 原样读回", () => {
    const cfg = {
      preferredDevice: "AgentDock-04A8",
      macros: ["继续吧", "重来"],
      brightness: 80,
      keyVolume: 90,
      knobVolume: 40,
      agentVolume: 70,
      muted: true,
    };
    mod.saveConfig(cfg);
    expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual(cfg);
    expect(mod.loadConfig()).toEqual(cfg);
  });

  it("soundVolumes 按 按键/旋钮/agent 顺序输出", () => {
    expect(
      mod.soundVolumes({ ...DEFAULTS, keyVolume: 10, knobVolume: 20, agentVolume: 30 }),
    ).toEqual([10, 20, 30]);
  });

  it("写入内容是 2 空格缩进的 JSON (便于手工编辑)", () => {
    mod.saveConfig({ ...DEFAULTS });
    const raw = readFileSync(configPath, "utf8");
    expect(raw).toContain('\n  "preferredDevice"');
  });

  it("覆盖已有配置", () => {
    mod.saveConfig({ ...DEFAULTS, preferredDevice: "A", macros: ["1", "2"] });
    mod.saveConfig({ ...DEFAULTS, preferredDevice: "B", macros: ["3", "4"] });
    expect(mod.loadConfig()).toMatchObject({ preferredDevice: "B", macros: ["3", "4"] });
  });
});

describe("clampPct", () => {
  it("取整并限制在 0~100, 非数字回退", () => {
    expect(mod.clampPct(42.6, 0)).toBe(43);
    expect(mod.clampPct(-5, 50)).toBe(0);
    expect(mod.clampPct(150, 50)).toBe(100);
    expect(mod.clampPct(undefined, 70)).toBe(70);
    expect(mod.clampPct("abc", 70)).toBe(70);
  });
});
