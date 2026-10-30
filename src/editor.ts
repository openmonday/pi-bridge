import { Loader, getKeybindings, matchesKey, truncateToWidth, visibleWidth, type EditorTheme, type TUI } from "@earendil-works/pi-tui";
import { CustomEditor, type ExtensionUIContext, type KeybindingsManager } from "@earendil-works/pi-coding-agent";

export type BridgeEditorFactory = NonNullable<Parameters<ExtensionUIContext["setEditorComponent"]>[0]>;

// Mirrors pi's embedded Working indicator: a Loader rendered inside the
// editor's top border instead of a separate widget row.
class TranslationIndicator extends Loader {
  constructor(tui: TUI, color: (text: string) => string) {
    super(tui, color, color, "", undefined);
    this.stop();
  }

  setStatus(message?: string) {
    this.setMessage(message ?? "");
    if (message) this.start();
    else this.stop();
  }

  renderInBorder(width: number) {
    const line = super.render(width + 2)[1] ?? "";
    return truncateToWidth(line.startsWith(" ") ? line.slice(1).trimEnd() : line.trimEnd(), width, "");
  }

  renderSpinnerInBorder(width: number) {
    return truncateToWidth(this.getRenderedIndicator(), width, "");
  }

  dispose() {
    this.stop();
  }
}

export class TranslationEditor extends CustomEditor {
  private readonly indicator: TranslationIndicator;
  private translation: string | undefined;
  /** Called on Enter for a non-empty draft. Return true to consume the key instead of submitting. */
  interceptSubmit?: (draft: string) => boolean;
  /** Called on Escape. Return true to consume the key, e.g. to cancel an in-flight auto-send. */
  interceptEscape?: () => boolean;

  constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) {
    super(tui, theme, keybindings, { embedWorkingStatus: true });
    this.indicator = new TranslationIndicator(tui, text => this.borderColor(text));
  }

  handleInput(data: string): void {
    if (this.interceptEscape && matchesKey(data, "escape") && !this.isShowingAutocomplete() && this.interceptEscape()) return;
    if (this.interceptSubmit && this.claimsSubmit(data) && this.interceptSubmit(this.getExpandedText())) return;
    super.handleInput(data);
  }

  // Mirrors Editor's submit guards: submits disabled, autocomplete open, the
  // submit key itself, the backslash-newline escape, and an empty draft.
  private claimsSubmit(data: string): boolean {
    if (this.disableSubmit || this.isShowingAutocomplete()) return false;
    const kb = getKeybindings();
    if (this.insertsNewLine(data, kb)) return false;
    if (!kb.matches(data, "tui.input.submit")) return false;
    if (this.backslashNewline(data, kb)) return false;
    return this.getExpandedText().trim().length > 0;
  }

  // Editor checks newline keys before submit, so Shift+Enter (and the
  // terminal-specific newline sequences) must never be claimed as a submit.
  private insertsNewLine(data: string, kb: ReturnType<typeof getKeybindings>): boolean {
    return kb.matches(data, "tui.input.newLine") ||
      (data.charCodeAt(0) === 10 && data.length > 1) ||
      data === "\x1b\r" ||
      data === "\x1b[13;2~" ||
      (data.length > 1 && data.includes("\x1b") && data.includes("\r")) ||
      data === "\n";
  }

  // Same workaround as Editor: with Shift+Enter bound to newline, a trailing
  // backslash before Enter inserts a newline instead of submitting.
  private backslashNewline(data: string, kb: ReturnType<typeof getKeybindings>): boolean {
    if (!matchesKey(data, "enter")) return false;
    const keys = kb.getKeys("tui.input.submit");
    if (!keys.includes("shift+enter") && !keys.includes("shift+return")) return false;
    const { line, col } = this.getCursor();
    return col > 0 && (this.getLines()[line] ?? "")[col - 1] === "\\";
  }

  setTranslation(message?: string) {
    if (message === this.translation) return;
    this.translation = message;
    this.indicator.setStatus(message);
  }

  // Same border layout as CustomEditor.renderTopBorder, so translation status
  // occupies the editor border rather than adding another line above it.
  protected renderTopBorder(width: number, hiddenLineCount: number): string {
    if (!this.translation) return super.renderTopBorder(width, hiddenLineCount);
    let status = this.indicator.renderInBorder(Math.max(1, width - 5));
    let statusWidth = visibleWidth(status);
    if (statusWidth === 0) return super.renderTopBorder(width, hiddenLineCount);
    const overflowLabel = hiddenLineCount > 0 ? ` ↑ ${hiddenLineCount} more ` : undefined;
    const overflowLabelWidth = overflowLabel ? visibleWidth(overflowLabel) : 0;
    const overflowStart = Math.floor((width - overflowLabelWidth) / 2);
    const canFitOverflow = () => overflowLabel !== undefined && overflowLabelWidth + 2 <= width && overflowStart - (3 + statusWidth + 1) >= 1;
    if (overflowLabel && !canFitOverflow()) {
      status = this.indicator.renderSpinnerInBorder(width);
      statusWidth = visibleWidth(status);
    }
    if (canFitOverflow()) {
      const leftBlockWidth = 3 + statusWidth + 1;
      return (this.borderColor("── ") +
        status +
        this.borderColor(` ${"─".repeat(overflowStart - leftBlockWidth)}${overflowLabel}${"─".repeat(width - overflowStart - overflowLabelWidth)}`));
    }
    if (width >= statusWidth + 5) {
      return this.borderColor("── ") + status + this.borderColor(` ${"─".repeat(width - statusWidth - 4)}`);
    }
    status = this.indicator.renderSpinnerInBorder(width);
    statusWidth = visibleWidth(status);
    const prefixWidth = Math.min(3, Math.max(0, width - statusWidth));
    return (this.borderColor("─".repeat(prefixWidth)) +
      status +
      this.borderColor("─".repeat(Math.max(0, width - prefixWidth - statusWidth))));
  }

  dispose() {
    this.indicator.dispose();
  }
}
