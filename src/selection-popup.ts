import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, Text, truncateToWidth, visibleWidth, wrapTextWithAnsi, type OverlayOptions, type TUI } from "@earendil-works/pi-tui";

const clean = (text: string) => text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
type Point = { x: number; y: number };
export type PopupTheme = Pick<Theme, "fg" | "bg" | "bold">;

export class SelectionPopup {
  private result: string | undefined;
  private error = false;
  private offset = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private frame = 0;
  private disposed = false;
  private overlay: OverlayOptions = {};
  private tui: TUI;
  private point: Point;
  private source: string;
  private target: string;
  private theme: PopupTheme;
  private close: () => void;

  constructor(tui: TUI, point: Point, source: string, target: string, theme: PopupTheme, close: () => void) {
    this.tui = tui; this.point = point; this.source = clean(source);
    this.target = target; this.theme = theme; this.close = close;
  }

  private layout() {
    const columns = this.tui.terminal.columns, rows = this.tui.terminal.rows;
    const longest = Math.max(...`${this.source}\n${this.result ?? ""}`.split("\n").map(visibleWidth));
    const width = Math.max(1, Math.min(54, Math.max(34, longest + 4), columns - 2));
    const inner = Math.max(1, width - 4);
    const original = wrapTextWithAnsi(this.source, inner);
    const source = original.slice(0, 2);
    if (original.length > 2) source[1] = truncateToWidth(source[1], Math.max(1, inner - 1), "") + "…";
    const body = this.result === undefined ? [`${frames[this.frame % frames.length]} Translating`] : wrapTextWithAnsi(this.result || "No translation returned", inner);
    const desired = source.length + Math.min(8, body.length) + 3;
    const above = Math.max(0, this.point.y), below = Math.max(0, rows - this.point.y - 1);
    const placement = above >= desired || above >= below ? "above" : "below";
    const height = Math.max(1, Math.min(desired, placement === "above" ? above : below));
    const row = placement === "above" ? Math.max(0, this.point.y - height) : this.point.y + 1;
    const col = Math.max(0, Math.min(columns - width, this.point.x - 3));
    const bodyHeight = Math.max(1, height - source.length - 3);
    Object.assign(this.overlay, { width, maxHeight: height, row, col, margin: 0 });
    return { width, height, row, col, source, body, bodyHeight };
  }

  options(): OverlayOptions { this.layout(); return this.overlay; }

  contains(x: number, y: number) {
    const box = this.layout();
    return x >= box.col && x < box.col + box.width && y >= box.row && y < box.row + box.height;
  }

  start() {
    this.timer = setInterval(() => { this.frame++; if (!this.disposed) this.tui.requestRender(); }, 80);
    this.timer.unref();
  }

  setResult(text: string, error = false) {
    if (this.disposed) return;
    this.result = clean(text);
    this.error = error;
    this.offset = 0;
    this.stopTimer();
    this.layout();
    this.tui.requestRender();
  }

  private stopTimer() { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
  dispose() { this.disposed = true; this.stopTimer(); }
  invalidate() {}

  render(width: number) {
    const box = this.layout();
    const theme = this.theme;
    const bg = (text: string) => theme.bg("customMessageBg", text);
    const blank = bg(" ".repeat(Math.max(1, width)));
    // Borderless card: background, 2-column padding, muted source above the result.
    const line = (text: string, tone: "muted" | "dim" | "text" | "error") =>
      new Text(theme.fg(tone, text), 2, 0, bg).render(Math.max(1, width))[0] ?? blank;
    this.offset = Math.min(this.offset, Math.max(0, box.body.length - box.bodyHeight));
    const tone = this.error ? "error" : this.result === undefined ? "dim" : "text";
    const lines = [blank, ...box.source.map(text => line(text, "muted")), blank];
    lines.push(...box.body.slice(this.offset, this.offset + box.bodyHeight).map(text => line(text, tone)));
    if (box.body.length > box.bodyHeight) {
      const hint = `${this.offset + 1}/${box.body.length}`;
      lines.push(bg(" ".repeat(Math.max(0, width - visibleWidth(hint) - 2)) + theme.fg("dim", hint) + "  "));
    } else lines.push(blank);
    // pi clips the card to the available rows in very small terminals.
    return lines.slice(0, box.height).map(text => truncateToWidth(text, width, ""));
  }

  handleInput(data: string) {
    if (matchesKey(data, "escape") || matchesKey(data, "enter")) this.close();
    else if (matchesKey(data, "up")) this.offset = Math.max(0, this.offset - 1);
    else if (matchesKey(data, "down")) this.offset++;
    this.tui.requestRender();
  }

  mouse(button: number, _x: number, _y: number) {
    if ((button & 64) !== 0) { this.offset = Math.max(0, this.offset + ((button & 1) ? 2 : -2)); this.tui.requestRender(); }
  }
}
