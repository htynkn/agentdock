/*
 * panel.test.ts — /dock 面板的渲染与交互测试
 *
 * 覆盖三个已修复的回归问题 (每个都对应一次真实 bug):
 *   1. 行宽溢出 / 空行过多  → 所有行 visibleWidth ≤ width, 状态区紧凑
 *   2. 上下键箭头不动        → 按键后选中项确实移动, Enter 选中箭头所指项
 *   3. 连接后 面板不刷新     → 订阅连接变化并重绘
 * 以及扫描流程 (Loader/信号条/取消回主面板)、灯效流程、非 TUI 回退。
 */
import { describe, expect, it } from "vitest";

import { showPanel, type PanelAction, type PanelStatus } from "../panel.js";
import {
  FakeChannel,
  Harness,
  KEY,
  deferred,
  overflowLines,
  plainLines,
  selectedLabel,
  waitFor,
} from "./helpers.js";

const config = { preferredDevice: "", macros: ["继续吧", "继续"] };
const idle: PanelStatus = { busy: false, scrollAvailable: true };

function connectedChannel(rssi = -58): FakeChannel {
  const ch = new FakeChannel();
  ch.connected = true;
  ch.deviceName = "AgentDock-04A8";
  ch.rssi = rssi;
  return ch;
}

/** 启动面板并等到主菜单出现 */
async function openPanel(
  harness: Harness,
  channel: FakeChannel,
  status: () => PanelStatus = () => idle,
): Promise<{ result: Promise<PanelAction | null> }> {
  const result = showPanel(harness.ctx, channel.asChannel(), config, status);
  await waitFor(() => harness.components.length > 0, "主菜单未创建");
  /* 包一层对象: 否则 await openPanel() 会连面板 promise 一起等待 (它要等关闭才 resolve) */
  return { result };
}

describe("主面板渲染", () => {
  it("各宽度下都不溢出, 且不出现多余空行", async () => {
    const h = new Harness();
    const ch = connectedChannel();
    const { result } = await openPanel(h, ch);

    for (const width of [40, 56, 72, 100]) {
      expect(overflowLines(h.current, width)).toEqual([]);
    }

    /* 状态区两行相邻 (没有 Text 默认 paddingY=1 造成的空行) */
    const lines = plainLines(h.current, 72);
    const boxTop = lines.findIndex((l) => l.startsWith("╭"));
    expect(lines[boxTop + 1]).toContain("已连接");
    expect(lines[boxTop + 2]).toContain("agent");
    expect(lines[boxTop + 3]).toContain("╰");
  });

  it("已连接时显示设备名和信号强度 (条 + dBm)", async () => {
    const h = new Harness();
    const { result } = await openPanel(h, connectedChannel(-58));
    const text = plainLines(h.current, 72).join("\n");

    expect(text).toContain("AgentDock-04A8");
    expect(text).toMatch(/▂▄▆. -58 dBm/);
  });

  it("未连接时提示后台重连, 不显示 dBm 数值", async () => {
    const h = new Harness();
    const { result } = await openPanel(h, new FakeChannel());
    const text = plainLines(h.current, 72).join("\n");

    expect(text).toContain("未连接");
    expect(text).toContain("后台重连中");
    expect(text).not.toMatch(/-\d+ dBm/);
  });

  it("状态行的 agent 忙闲与旋钮可用性实时读取", async () => {
    const h = new Harness();
    let status: PanelStatus = { busy: false, scrollAvailable: true };
    const { result } = await openPanel(h, connectedChannel(), () => status);

    expect(plainLines(h.current, 72).join("\n")).toContain("agent 空闲");

    status = { busy: true, scrollAvailable: false };
    h.current.invalidate();
    const text = plainLines(h.current, 72).join("\n");
    expect(text).toContain("agent 运行中");
    expect(text).toContain("旋钮滚动不可用");
  });

  it("键位图例包含两个宏内容", async () => {
    const h = new Harness();
    const { result } = await openPanel(h, connectedChannel());
    const text = plainLines(h.current, 72).join("\n");
    expect(text).toContain("KEY2");
    expect(text).toContain("继续吧");
    expect(text).toContain("KEY3");
  });
});

describe("主面板交互", () => {
  it("上下键移动选中项, 回车选中箭头所指项", async () => {
    const h = new Harness();
    const { result } = await openPanel(h, connectedChannel());
    const comp = h.current;

    expect(selectedLabel(comp)).toBe("扫描 / 绑定设备");

    comp.handleInput!(KEY.down);
    expect(selectedLabel(comp)).toBe("编辑宏 KEY2");

    comp.handleInput!(KEY.down);
    expect(selectedLabel(comp)).toBe("编辑宏 KEY3");

    comp.handleInput!(KEY.up);
    expect(selectedLabel(comp)).toBe("编辑宏 KEY2");

    /* 在「编辑宏 KEY2」上回车 → 打开 KEY2 输入框, 并返回 edit-macro 动作 */
    h.inputAnswers.push("好的");
    comp.handleInput!(KEY.enter);
    const action = await waitFor(() => h.inputs.length > 0).then(() => h.inputs[0]);
    expect(action).toContain("KEY2");
  });

  it("按键会请求重绘 (否则箭头不动)", async () => {
    const h = new Harness();
    const { result } = await openPanel(h, connectedChannel());
    const before = h.renderCount;
    h.current.handleInput!(KEY.down);
    expect(h.renderCount).toBeGreaterThan(before);
  });

  it("Esc 关闭面板返回 null", async () => {
    const h = new Harness();
    const { result } = await openPanel(h, connectedChannel());
    h.current.handleInput!(KEY.esc);
    await expect(result).resolves.toBeNull();
  });

  it("选「退出」返回 null", async () => {
    const h = new Harness();
    const { result } = await openPanel(h, connectedChannel());
    for (let i = 0; i < 5; i++) h.current.handleInput!(KEY.down); // → 退出
    expect(selectedLabel(h.current)).toBe("退出");
    h.current.handleInput!(KEY.enter);
    await expect(result).resolves.toBeNull();
  });

  it("选「重新连接」返回 reconnect 动作", async () => {
    const h = new Harness();
    const { result } = await openPanel(h, connectedChannel());
    for (let i = 0; i < 4; i++) h.current.handleInput!(KEY.down); // → 重新连接
    h.current.handleInput!(KEY.enter);
    await expect(result).resolves.toEqual({ kind: "reconnect" });
  });

  it("编辑宏返回 edit-macro 动作", async () => {
    const h = new Harness();
    const { result } = await openPanel(h, connectedChannel());
    h.current.handleInput!(KEY.down); // 编辑宏 KEY2
    h.inputAnswers.push("  继续加油  ");
    h.current.handleInput!(KEY.enter);
    await expect(result).resolves.toEqual({ kind: "edit-macro", index: 0, text: "继续加油" });
  });

  it("取消宏输入则回到主面板", async () => {
    const h = new Harness();
    const { result } = await openPanel(h, connectedChannel());
    h.current.handleInput!(KEY.down);
    h.inputAnswers.push(undefined); // 用户取消
    h.current.handleInput!(KEY.enter);
    await waitFor(() => h.components.length === 2, "未重新打开主面板");
    expect(selectedLabel(h.current)).toBe("扫描 / 绑定设备");
  });
});

describe("连接状态变化", () => {
  it("停留期间后台连上 → 面板重绘并显示设备与信号", async () => {
    const h = new Harness();
    const ch = new FakeChannel();
    const { result } = await openPanel(h, ch);
    expect(plainLines(h.current, 72).join("\n")).toContain("未连接");

    const before = h.renderCount;
    ch.emitConnection(true, "AgentDock-04A8", -52);
    await waitFor(() => h.renderCount > before, "连接变化未触发重绘");

    const text = plainLines(h.current, 72).join("\n");
    expect(text).toContain("已连接");
    expect(text).toContain("AgentDock-04A8");
    expect(text).toMatch(/-52 dBm/);
  });

  it("连接后主动刷新 RSSI", async () => {
    const h = new Harness();
    const ch = new FakeChannel();
    const { result } = await openPanel(h, ch);

    ch.rssiImpl = async () => -44;
    ch.emitConnection(true, "AgentDock-04A8", -80); // 初始值故意偏差
    await waitFor(() => /-44 dBm/.test(plainLines(h.current, 72).join("\n")), "RSSI 未刷新");
  });

  it("断开后面板回到未连接状态", async () => {
    const h = new Harness();
    const ch = connectedChannel();
    const { result } = await openPanel(h, ch);

    ch.emitConnection(false);
    await waitFor(() => plainLines(h.current, 72).join("\n").includes("未连接"), "未反映断开");
  });

  it("面板关闭后释放连接监听 (dispose)", async () => {
    const h = new Harness();
    const ch = new FakeChannel();
    const { result } = await openPanel(h, ch);
    expect(ch.listenerCount).toBe(1);

    h.current.handleInput!(KEY.esc);
    h.current.dispose?.();
    expect(ch.listenerCount).toBe(0);
  });
});

describe("扫描流程", () => {
  it("扫描中显示 Loader, 完成后列出设备与信号强度并可选中", async () => {
    const h = new Harness();
    const ch = connectedChannel();
    const scan = deferred<{ name: string; rssi: number }[]>();
    ch.scanImpl = () => scan.promise;
    const { result } = await openPanel(h, ch);

    h.current.handleInput!(KEY.enter); // 进入扫描
    await waitFor(() => h.components.length === 2, "扫描页未打开");

    const scanning = plainLines(h.current, 72).join("\n");
    expect(scanning).toContain("扫描中");
    expect(overflowLines(h.current, 72)).toEqual([]);

    scan.resolve([
      { name: "AgentDock-04A8", rssi: -48 },
      { name: "AgentDock-1B2C", rssi: -71 },
      { name: "AgentDock-9F0E", rssi: -88 },
    ]);
    await waitFor(
      () => plainLines(h.current, 72).join("\n").includes("AgentDock-1B2C"),
      "扫描结果未渲染",
    );

    const list = plainLines(h.current, 72).join("\n");
    expect(list).toContain("发现 3 台设备");
    expect(list).toMatch(/-48 dBm/);
    expect(list).toMatch(/-88 dBm/);
    /* 当前已连接设备带标记 */
    expect(list).toContain("当前绑定");
    expect(overflowLines(h.current, 72)).toEqual([]);

    /* Esc 取消 → 回到主面板 */
    h.current.handleInput!(KEY.esc);
    await waitFor(() => h.components.length === 3, "取消扫描后未回主面板");
    expect(selectedLabel(h.current)).toBe("扫描 / 绑定设备");
  });

  it("选中设备返回 bind-device 动作", async () => {
    const h = new Harness();
    const ch = new FakeChannel();
    ch.scanImpl = async () => [
      { name: "AgentDock-1B2C", rssi: -50 },
      { name: "AgentDock-9F0E", rssi: -80 },
    ];
    const { result } = await openPanel(h, ch);

    h.current.handleInput!(KEY.enter); // 进入扫描
    await waitFor(() => h.components.length === 2);
    await waitFor(() => plainLines(h.current, 72).join("\n").includes("AgentDock-9F0E"));

    h.current.handleInput!(KEY.down); // 选第二台
    h.current.handleInput!(KEY.enter);
    await expect(result).resolves.toEqual({ kind: "bind-device", name: "AgentDock-9F0E" });
  });

  it("扫描无结果时关闭扫描页并回到主面板", async () => {
    const h = new Harness();
    const ch = new FakeChannel();
    ch.scanImpl = async () => [];
    const { result } = await openPanel(h, ch);

    h.current.handleInput!(KEY.enter);
    await waitFor(() => h.components.length >= 3, "无结果后未回主面板");
    expect(selectedLabel(h.current)).toBe("扫描 / 绑定设备");
  });
});

describe("灯效测试流程", () => {
  async function openLed(
    h: Harness,
    ch: FakeChannel,
  ): Promise<{ result: Promise<PanelAction | null> }> {
    const result = showPanel(h.ctx, ch.asChannel(), config, () => idle);
    await waitFor(() => h.components.length > 0);
    for (let i = 0; i < 3; i++) h.current.handleInput!(KEY.down); // → 测试灯效
    h.current.handleInput!(KEY.enter);
    await waitFor(() => h.components.length === 2, "灯效页未打开");
    return { result };
  }

  it("列出四种状态且选中项语义正确", async () => {
    const h = new Harness();
    const ch = connectedChannel();
    await openLed(h, ch);

    const text = plainLines(h.current, 72).join("\n");
    for (const s of ["busy", "done", "error", "idle"]) expect(text).toContain(s);
    expect(overflowLines(h.current, 72)).toEqual([]);

    h.current.handleInput!(KEY.down);
    h.current.handleInput!(KEY.down); // error
    expect(selectedLabel(h.current)).toContain("error");
  });

  it("选中 error 返回 test-led 动作", async () => {
    const h = new Harness();
    const { result } = await openLed(h, connectedChannel());
    h.current.handleInput!(KEY.down);
    h.current.handleInput!(KEY.down);
    h.current.handleInput!(KEY.enter);
    await expect(result).resolves.toEqual({ kind: "test-led", state: "error" });
  });

  it("未连接时给出警告但允许选择", async () => {
    const h = new Harness();
    await openLed(h, new FakeChannel());
    const text = plainLines(h.current, 72).join("\n");
    expect(text).toContain("设备未连接");
  });

  it("Esc 取消后回到主面板", async () => {
    const h = new Harness();
    await openLed(h, connectedChannel());
    h.current.handleInput!(KEY.esc);
    await waitFor(() => h.components.length === 3, "取消灯效后未回主面板");
    expect(selectedLabel(h.current)).toBe("扫描 / 绑定设备");
  });
});

describe("非 TUI 回退", () => {
  it("用标准对话框走同样的动作", async () => {
    const h = new Harness({ mode: "rpc" });
    const ch = new FakeChannel();

    h.selectAnswers.push("编辑宏 KEY3");
    h.inputAnswers.push("重来");
    const result = await showPanel(h.ctx, ch.asChannel(), config, () => idle);

    expect(result).toEqual({ kind: "edit-macro", index: 1, text: "重来" });
    expect(h.selects[0]).toContain("管理面板");
  });

  it("回退模式标题里带信号强度", async () => {
    const h = new Harness({ mode: "rpc" });
    h.selectAnswers.push(undefined); // 取消
    await showPanel(h.ctx, connectedChannel(-58).asChannel(), config, () => idle);
    expect(h.selects[0]).toMatch(/-58 dBm/);
  });
});
