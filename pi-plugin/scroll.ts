/*
 * scroll.ts — 旋钮 → agent 输出滚动
 *
 * 通过 /deck widget 工厂捕获 pi 内部 TUI 实例 (fullscreen 模式的 TuiAltScreen),
 * 其公开方法 scrollBy(lines)/scrollToBottom() 即可滚动 transcript.
 *
 * ⚠️ TUI 实例的滚动方法属于 pi-tui 的公开 API, 但经扩展 widget 工厂获取实例
 *    属于未文档化路径 — pi 升级可能变化, 全部调用有特性检测与异常兜底:
 *    不可用时 scrollByInput() 静默返回 false, 事件仍走日志, 不影响其他功能.
 */

/* 1 格旋钮 = 3 行 */
const LINES_PER_STEP = 3;
/* 快转判定: 累积步数达到即翻半页 */
const FAST_SCROLL_STEPS = 5;
const FAST_SCROLL_LINES = 24;

export class DeckScroller {
  private tui: any = null;
  /* 快转累积器: 250ms 窗口内的步数合并 */
  private pending = 0;
  private flushTimer: NodeJS.Timeout | null = null;

  /** 由 setWidget 工厂捕获 TUI 实例 (widget 本身不渲染任何内容) */
  attach(tui: unknown): void {
    this.tui = tui;
  }

  detach(): void {
    this.tui = null;
  }

  get available(): boolean {
    return typeof (this.tui as any)?.scrollBy === "function";
  }

  /**
   * 滚动 dir 格 (+1 顺时针=向下). 返回是否成功执行.
   * 快转时合并为半页滚动; 滚到底部继续同向则恢复跟随.
   */
  scrollByInput(dir: number, log: (...a: unknown[]) => void): boolean {
    if (!this.available) return false;
    this.pending += dir;
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        const steps = this.pending;
        this.pending = 0;
        this.flushTimer = null;
        this.apply(steps, log);
      }, 120);
    }
    return true;
  }

  private apply(steps: number, log: (...a: unknown[]) => void): void {
    if (steps === 0) return;
    try {
      const tui = this.tui as any;
      const fast = Math.abs(steps) >= FAST_SCROLL_STEPS;
      const lines = fast
        ? Math.sign(steps) * FAST_SCROLL_LINES
        : Math.sign(steps) * LINES_PER_STEP * Math.min(Math.abs(steps), FAST_SCROLL_STEPS);
      const moved = tui.scrollBy(lines);
      /* 请求滚动但已无余量 (moved=0) 且继续同向 → 视为"到底", 恢复跟随 */
      if (moved === 0 && Math.abs(steps) >= FAST_SCROLL_STEPS) {
        tui.scrollToBottom();
        log("到底部, 恢复跟随输出");
      }
    } catch (e) {
      log("滚动失败 (pi 版本 API 变化?):", e);
    }
  }
}
