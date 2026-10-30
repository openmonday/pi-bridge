import assert from "node:assert/strict";
import test from "node:test";
import { KeybindingsManager, TUI_KEYBINDINGS, setKeybindings } from "@earendil-works/pi-tui";
import { TranslationEditor } from "../src/editor.ts";

const kb = new KeybindingsManager(TUI_KEYBINDINGS);
setKeybindings(kb);

function create() {
  const tui = { requestRender() {}, terminal: { columns: 80, rows: 24 } } as any;
  const theme = { borderColor: (s: string) => s, selectList: {} } as any;
  const editor = new TranslationEditor(tui, theme, kb as any);
  const intercepted: string[] = [];
  editor.interceptSubmit = draft => { intercepted.push(draft); return true; };
  return { editor, intercepted };
}

test("Shift+Enter inserts a newline instead of triggering auto-send", () => {
  for (const key of ["\n", "\x1b[13;2u", "\x1b[27;2;13~", "\x1b\r", "\x1b[13;2~"]) {
    const { editor, intercepted } = create();
    editor.setText("hello");
    editor.handleInput(key);
    assert.deepEqual(intercepted, [], JSON.stringify(key));
    assert.equal(editor.getText(), "hello\n", JSON.stringify(key));
  }
});

test("Enter still triggers auto-send", () => {
  const { editor, intercepted } = create();
  editor.setText("hello");
  editor.handleInput("\r");
  assert.deepEqual(intercepted, ["hello"]);
});
