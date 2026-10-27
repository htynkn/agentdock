/*
 * helpers.ts — panel 测试用的最小 mock
 *
 * 要点:
 *   - theme 输出真实 ANSI 转义 (不占显示宽度), 与 pi 渲染路径一致,
 *     这样 truncateToWidth / visibleWidth 的行为和线上相同
 *   - channel 支持 onConnectionChange, 可主动触发连接变化
 *   - harness 记录 ui.custom 创建的组件, 供测试驱动按键并检查渲染结果
 */
import { visibleWidth } from "@earendil-works/pi-tui";
import type { DeckChannel, DeckPeripheralInfo } from "../ble.js";

const ANSI: Record<string, number> = {
  accent: 36,
  success: 32,
  warning: 33,
  error: 31,
  muted: 90,
  dim: 2,
  text: 37,
  border: 34,
  borderMuted: 34,
};

export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

export function makeTheme(): any {
  return {
    fg: (color: string, text: string) => `\x1b[${ANSI[color] ?? 37}m${text}\x1b[0m`,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => `\x1b[1m${text}\x1b[0m`,
    italic: (text: string) => text,
    underline: (text: string) => text,
    style: (text: string) => text,
    colors: {},
    appearance: "dark",
  };
}

/** 面板组件的最小接口 (pi 关闭交互时会调用 dispose) */
export interface PanelComponent {
  render(width: number): string[];
  invalidate(): void;
  handleInput?(data: string): void;
  dispose?(): void;
}

/** 可渲染的文本行 (已去 ANSI) */
export function plainLines(comp: PanelComponent, width: number): string[] {
  return comp.render(width).map(stripAnsi);
}

export function overflowLines(comp: PanelComponent, width: number): string[] {
  return comp.render(width).filter((l) => visibleWidth(l) > width);
}

/** 主菜单/列表当前选中项的文字 (SelectList 用 → 标出) */
export function selectedLabel(comp: PanelComponent, width = 72): string | undefined {
  const hit = plainLines(comp, width).find((l) => l.trimStart().startsWith("→"));
  return hit?.match(/→\s*(.+?)(?:\s{2,}.*)?$/)?.[1]?.trim();
}

export const KEY = {
  up: "\x1b[A",
  down: "\x1b[B",
  enter: "\r",
  esc: "\x1b",
} as const;

/**
 * DeckChannel 假件: 可控制连接状态, 可延迟/失败扫描.
 */
export class FakeChannel {
  connected = false;
  deviceName = "";
  rssi: number | null = null;
  /** scan() 的行为: 数组 = 立即返回; 函数 = 自定义 (可返回 deferred) */
  scanImpl: () => Promise<DeckPeripheralInfo[]> = async () => [];
  rssiImpl: (() => Promise<number | null>) | null = null;
  readonly statesWritten: string[] = [];
  private listeners = new Set<(connected: boolean) => void>();

  onConnectionChange(cb: (connected: boolean) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  get listenerCount(): number {
    return this.listeners.size;
  }

  /** 模拟后台连接成功/断开 (走真实监听链路) */
  emitConnection(connected: boolean, name = "", rssi: number | null = null): void {
    this.connected = connected;
    this.deviceName = name;
    this.rssi = rssi;
    for (const cb of [...this.listeners]) cb(connected);
  }

  async refreshRssi(): Promise<number | null> {
    if (this.rssiImpl) this.rssi = await this.rssiImpl();
    return this.rssi;
  }

  scan(): Promise<DeckPeripheralInfo[]> {
    return this.scanImpl();
  }

  async writeState(state: string): Promise<void> {
    this.statesWritten.push(state);
  }

  /** 转成 showPanel 需要的类型 */
  asChannel(): DeckChannel {
    return this as unknown as DeckChannel;
  }
}

export interface HarnessOptions {
  mode?: "tui" | "rpc";
}

/**
 * ExtensionContext 假件: 捕获 ui.custom 组件, 记录 input/select/notify 调用.
 */
export class Harness {
  readonly components: PanelComponent[] = [];
  readonly renders: number[] = []; // requestRender 次数按 tick 累积
  readonly inputs: string[] = [];
  readonly selects: string[] = [];
  readonly notifications: { message: string; type?: string }[] = [];
  /** ui.input 的返回值队列 (undefined = 用户取消) */
  inputAnswers: (string | undefined)[] = [];
  /** ui.select 的返回值队列 */
  selectAnswers: (string | undefined)[] = [];
  renderCount = 0;
  private doneResolvers: ((value: unknown) => void)[] = [];

  constructor(readonly opts: HarnessOptions = {}) {}

  get theme(): any {
    return makeTheme();
  }

  get ctx(): any {
    return {
      mode: this.opts.mode ?? "tui",
      ui: {
        theme: this.theme,
        custom: (factory: any) =>
          new Promise((resolve) => {
            const fakeTui = {
              mode: "regular",
              requestRender: () => {
                this.renderCount++;
              },
            };
            const comp = factory(fakeTui, this.theme, {}, resolve);
            this.components.push(comp);
            this.doneResolvers.push(resolve);
          }),
        input: async (title: string) => {
          this.inputs.push(title);
          return this.inputAnswers.shift();
        },
        select: async (title: string) => {
          this.selects.push(title);
          return this.selectAnswers.shift();
        },
        notify: (message: string, type?: string) => {
          this.notifications.push({ message, type });
        },
      },
    };
  }

  /** 当前交互中的组件 */
  get current(): PanelComponent {
    const comp = this.components[this.components.length - 1];
    if (!comp) throw new Error("还没有创建任何面板组件");
    return comp;
  }
}

/** 轮询等待条件成立 (避免依赖内部时序) */
export async function waitFor(
  cond: () => boolean,
  message = "条件未在超时前成立",
  timeoutMs = 1000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (cond()) return;
    if (Date.now() > deadline) throw new Error(message);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** 可手动 resolve 的 Promise, 用于控制扫描完成时机 */
export function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
