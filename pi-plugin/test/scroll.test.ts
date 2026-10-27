/*
 * scroll.test.ts — 旋钮滚动: 步进合并 / 快转 / 到底恢复跟随
 *
 * 用假 TUI 对象驱动, 配合假定时器验证 120ms 合并窗口与行数换算。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DeckScroller } from "../scroll.js";

/** 假 TUI: 记录 scrollBy 的行数, moved 可配置 */
function fakeTui(opts: { moved?: number | ((lines: number) => number); throw?: boolean } = {}) {
  const calls: number[] = [];
  const bottomCalls: number[] = [];
  return {
    calls,
    bottomCalls,
    scrollBy(lines: number) {
      calls.push(lines);
      if (opts.throw) throw new Error("API 变了");
      if (typeof opts.moved === "function") return opts.moved(lines);
      return opts.moved ?? 10;
    },
    scrollToBottom() {
      bottomCalls.push(1);
    },
  };
}

const noop = () => {};

describe("DeckScroller", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("未 attach 时不可用, 输入返回 false", () => {
    const s = new DeckScroller();
    expect(s.available).toBe(false);
    expect(s.scrollByInput(1, noop)).toBe(false);
  });

  it("attach 后按 1 格 = 3 行滚动", async () => {
    const s = new DeckScroller();
    const tui = fakeTui();
    s.attach(tui);

    expect(s.scrollByInput(1, noop)).toBe(true);
    await vi.advanceTimersByTimeAsync(120);
    expect(tui.calls).toEqual([3]);
  });

  it("反向输入滚动负行数 (向上)", async () => {
    const s = new DeckScroller();
    const tui = fakeTui();
    s.attach(tui);

    s.scrollByInput(-1, noop);
    await vi.advanceTimersByTimeAsync(120);
    expect(tui.calls).toEqual([-3]);
  });

  it("窗口内多格累积合并为一次滚动", async () => {
    const s = new DeckScroller();
    const tui = fakeTui();
    s.attach(tui);

    s.scrollByInput(1, noop);
    s.scrollByInput(1, noop);
    s.scrollByInput(1, noop);
    await vi.advanceTimersByTimeAsync(120);

    /* 3 格 → 3 × 3 = 9 行, 只调用一次 */
    expect(tui.calls).toEqual([9]);
  });

  it("快转 (≥5 格) 合并为半页 24 行", async () => {
    const s = new DeckScroller();
    const tui = fakeTui();
    s.attach(tui);

    for (let i = 0; i < 7; i++) s.scrollByInput(1, noop);
    await vi.advanceTimersByTimeAsync(120);
    expect(tui.calls).toEqual([24]);

    for (let i = 0; i < 5; i++) s.scrollByInput(-1, noop);
    await vi.advanceTimersByTimeAsync(120);
    expect(tui.calls).toEqual([24, -24]);
  });

  it("不足 5 格的累积按比例换算且不超过上限", async () => {
    const s = new DeckScroller();
    const tui = fakeTui();
    s.attach(tui);

    s.scrollByInput(1, noop);
    s.scrollByInput(1, noop);
    s.scrollByInput(-1, noop); // 净 1 格
    await vi.advanceTimersByTimeAsync(120);
    expect(tui.calls).toEqual([3]);
  });

  it("净步数为 0 时不滚动", async () => {
    const s = new DeckScroller();
    const tui = fakeTui();
    s.attach(tui);

    s.scrollByInput(1, noop);
    s.scrollByInput(-1, noop);
    await vi.advanceTimersByTimeAsync(120);
    expect(tui.calls).toEqual([]);
  });

  it("快转到底 (moved=0) 时恢复跟随输出", async () => {
    const s = new DeckScroller();
    const tui = fakeTui({ moved: 0 });
    s.attach(tui);
    const logs: unknown[][] = [];

    for (let i = 0; i < 5; i++) s.scrollByInput(1, (...a) => logs.push(a));
    await vi.advanceTimersByTimeAsync(120);

    expect(tui.calls).toEqual([24]);
    expect(tui.bottomCalls).toEqual([1]);
    expect(logs.length).toBe(1);
  });

  it("慢速滚到底 (moved=0) 不恢复跟随 (仍可继续上翻)", async () => {
    const s = new DeckScroller();
    const tui = fakeTui({ moved: 0 });
    s.attach(tui);

    s.scrollByInput(1, noop);
    await vi.advanceTimersByTimeAsync(120);
    expect(tui.bottomCalls).toEqual([]);
  });

  it("TUI 抛异常时被吞掉并通过 log 上报", async () => {
    const s = new DeckScroller();
    const tui = fakeTui({ throw: true });
    s.attach(tui);
    const logs: unknown[][] = [];

    s.scrollByInput(1, (...a) => logs.push(a));
    await vi.advanceTimersByTimeAsync(120);
    /* 异常不能冒泡到事件循环 (否则会打崩 pi), 只记录日志 */
    expect(logs.length).toBe(1);
    expect(tui.calls).toEqual([3]);
  });

  it("detach 后不可用, 排队中的滚动不会落到已分离的 TUI 上", async () => {
    const s = new DeckScroller();
    const tui = fakeTui();
    s.attach(tui);

    s.scrollByInput(1, noop);
    s.detach();
    expect(s.available).toBe(false);
    expect(s.scrollByInput(1, noop)).toBe(false);

    await vi.advanceTimersByTimeAsync(120);
    /* apply() 读取 this.tui 已被置空 → 不滚动 (也不抛异常) */
    expect(tui.calls).toEqual([]);
  });
});
