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

const DEFAULTS = { preferredDevice: "", macros: ["继续", "不对"] };

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
    });
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
    const cfg = { preferredDevice: "AgentDock-04A8", macros: ["继续吧", "重来"] };
    mod.saveConfig(cfg);
    expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual(cfg);
    expect(mod.loadConfig()).toEqual(cfg);
  });

  it("写入内容是 2 空格缩进的 JSON (便于手工编辑)", () => {
    mod.saveConfig({ preferredDevice: "", macros: ["继续", "不对"] });
    const raw = readFileSync(configPath, "utf8");
    expect(raw).toContain('\n  "preferredDevice"');
  });

  it("覆盖已有配置", () => {
    mod.saveConfig({ preferredDevice: "A", macros: ["1", "2"] });
    mod.saveConfig({ preferredDevice: "B", macros: ["3", "4"] });
    expect(mod.loadConfig()).toEqual({ preferredDevice: "B", macros: ["3", "4"] });
  });
});
