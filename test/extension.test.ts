import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { initTheme } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext, MarkdownTransformer } from "@earendil-works/pi-coding-agent";
import { Editor, Text, TuiAltScreen, getKeybindings, matchesKey, isKittyProtocolActive, setKittyProtocolActive, stripTerminalSequences } from "@earendil-works/pi-tui";
import { SelectionPopup } from "../src/selection-popup.ts";
import { createBridge, installUndoShortcut, shortcuts } from "../src/index.ts";

const hostDist = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
const { AssistantMessageComponent } = await import(pathToFileURL(join(hostDist, "modes/interactive/components/assistant-message.js")).href);
const { theme: popupTheme, getEditorTheme } = await import(pathToFileURL(join(hostDist, "modes/interactive/theme/theme.js")).href);
initTheme("dark", false);
const translation = "This is the translated reply.";

async function until(condition: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for a render");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test("shortcuts translate only the last reply, toggle off, and preserve draft edits", async t => {
  const directory = await mkdtemp(join(tmpdir(), "bridge-pi-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const handlers = new Map<string, (event: any, ctx: ExtensionContext) => any>();
  let transformer!: MarkdownTransformer;
  const keys = new Map<string, (ctx: ExtensionContext) => Promise<void>>();
  const commands: string[] = [];
  const pi = {
    on(name: string, handler: (event: any, ctx: ExtensionContext) => any) { handlers.set(name, handler); },
    registerMarkdownTransformer(fn: MarkdownTransformer) { transformer = fn; },
    registerCommand(name: string) { commands.push(name); },
    registerShortcut(key: string, options: { handler: (ctx: ExtensionContext) => Promise<void> }) { keys.set(key, options.handler); },
  } as unknown as ExtensionAPI;
  let calls = 0, draft = "", redraws = 0;
  const notifications: string[] = [];
  const statuses: string[] = [];

  const entries: any[] = [];
  let terminalInput: ((data: string) => { consume?: boolean } | undefined) | undefined;
  let selectedText = "", clipboardReads = 0, popup = "";
  let popupView: any;
  let copySucceeds = true;
  let copied = 0;
  let component: InstanceType<typeof AssistantMessageComponent> | undefined;
  let older: InstanceType<typeof AssistantMessageComponent> | undefined;
  let editorView: any;
  let editorFactory: any;
  const progressText = () => stripTerminalSequences(editorView?.render(80).join("\n") ?? "");
  const widgetTui = {
    terminal: { columns: 80, rows: 24 },
    setFocus() {},
    get children() { return [older, component].filter(Boolean); },
    inputListeners: new class extends Set<typeof terminalInput> { override add(handler: typeof terminalInput) { terminalInput = handler; return super.add(handler); } }(),
    hasOverlay: () => false,
    hasActiveSelection: () => Boolean(selectedText),
    async copyActiveSelectionToClipboard() { copied++; return copySucceeds; },
    invalidate() { older?.invalidate(); component?.invalidate(); },
    requestRender() { redraws++; },
  };
  const ctx = {
    mode: "tui",
    sessionManager: { getSessionId: () => "test-session", getBranch: () => entries },
    ui: {
      notify: (text: string) => notifications.push(text),
      setStatus(_key: string, value?: string) { statuses.push(value ?? ""); },
      onTerminalInput(handler: typeof terminalInput) { terminalInput = handler; return () => { terminalInput = undefined; }; },
      custom(factory: any) {
        return new Promise<void>(resolve => {
          popupView = factory({ terminal: { rows: 24, columns: 80 }, requestRender() { if (popupView) popup = popupView.render(58).join("\n"); } }, popupTheme, {}, resolve);
          popup = popupView.render(58).join("\n");
        });
      },
      setWidget(_key: string, factory: any) {
        if (factory) factory(widgetTui);
      },
      getEditorComponent() { return editorFactory; },
      setEditorComponent(factory: any) {
        editorView?.dispose();
        editorFactory = factory;
        editorView = factory ? factory(widgetTui, getEditorTheme(), {}) : undefined;
      },
      getEditorText: () => draft,
      setEditorText(text: string) { draft = text; },
    },
  } as unknown as ExtensionContext;
  let inputGate: Promise<void> | undefined;
  let releaseReply!: () => void;
  const replyGate = new Promise<void>(resolve => { releaseReply = resolve; });
  let failInput = false;
  createBridge(pi, { directory, selectionDisplay: "terminal", readClipboard: async () => { clipboardReads++; return selectedText; }, translate: async (texts, options) => {
    calls++;
    if (options.target === "en") { await inputGate; if (failInput) throw new Error("Test translation failure"); }
    else await replyGate;
    return texts.map(() => options.target === "en" ? "Please explain this error." : translation);
  } });
  await handlers.get("session_start")!({ reason: "startup" }, ctx);
  t.after(() => handlers.get("session_shutdown")!({}, ctx));
  const press = (key: string) => keys.get(key)!(ctx);
  assert.deepEqual([...keys.keys()], ["alt+a", "alt+s"]);
  assert.deepEqual(commands, []);
  const original = "Explain this error.";
  const message = { role: "assistant", content: [{ type: "text", text: original }], stopReason: "stop" };
  const snapshot = JSON.stringify(message);
  older = new AssistantMessageComponent(structuredClone(message), false, undefined, undefined, 1, [transformer]);
  component = new AssistantMessageComponent(message, false, undefined, undefined, 1, [transformer]);
  assert.ok(!component.render(80).join("\n").includes(translation));
  await handlers.get("message_end")!({ message }, ctx);
  assert.equal(calls, 0); // Default is off; no history is sent to the translator.
  await press(shortcuts.toggle);
  await handlers.get("message_end")!({ message }, ctx);
  await until(() => progressText().includes("Translating last reply"));
  const firstFrame = progressText();
  await new Promise(resolve => setTimeout(resolve, 90));
  assert.notEqual(progressText(), firstFrame);
  assert.ok(!component.render(80).join("\n").includes(translation));
  releaseReply();
  await until(() => component!.render(80).join("\n").includes(translation));
  assert.ok(redraws > 0);
  assert.ok(!older.render(80).join("\n").includes(translation));
  assert.equal(JSON.stringify(message), snapshot);
  assert.equal(transformer(original, { messageType: "assistant-thinking", isStreaming: false, availableWidth: 80 }), original);
  assert.equal(transformer(original, { messageType: "user", isStreaming: false, availableWidth: 80 }), original);
  await press(shortcuts.toggle);
  await until(() => !component!.render(80).join("\n").includes(translation));
  draft = "Por favor, explica este error.";
  await press(shortcuts.input);
  assert.equal(draft, "Please explain this error.");
  assert.equal(notifications.length, 0);
  let release!: () => void;
  inputGate = new Promise(resolve => { release = resolve; });
  const pending = press(shortcuts.input);
  await until(() => progressText().includes("Translating draft to English"));
  assert.equal(draft, "Please explain this error.");
  draft = "New draft";
  release(); await pending;
  assert.equal(draft, "New draft");
  assert.ok(notifications.some(text => text.includes("Draft changed")));
  await until(() => !progressText().includes("Translating"));
  failInput = true;
  await press(shortcuts.input);
  assert.equal(draft, "New draft");
  await until(() => !progressText().includes("Translating"));
  failInput = false;

  assert.equal(terminalInput!("\x1b[<2;5;5M"), undefined);
  assert.equal(clipboardReads, 0);
  selectedText = "Selected English text";
  assert.equal(terminalInput!("\x1b[<0;5;5M"), undefined);
  assert.equal(terminalInput!("\x1b[<2;5;5m"), undefined);
  if (process.platform === "darwin") {
    const before = draft;
    assert.deepEqual(terminalInput!("\x1b[<2;5;5M"), { consume: true });
    await until(() => popup.includes(translation));
    assert.ok(popup.includes(selectedText));
    assert.equal(copied, 1);
    assert.equal(clipboardReads, 1);
    assert.equal(draft, before);
    popupView.handleInput("\x1b");
    copySucceeds = false;
    terminalInput!("\x1b[<2;5;5M");
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(clipboardReads, 1);
  }

  await press(shortcuts.toggle);
  const next = { role: "assistant", content: [{ type: "text", text: "Another answer." }], stopReason: "stop" };
  older = component;
  component = new AssistantMessageComponent(next, false, undefined, undefined, 1, [transformer]);
  await handlers.get("message_end")!({ message: next }, ctx);
  await until(() => component!.render(80).join("\n").includes(translation));
  assert.ok(!older!.render(80).join("\n").includes(translation));
  await press(shortcuts.toggle);
  await until(() => !component!.render(80).join("\n").includes(translation));
  const saved = JSON.parse(await readFile(join(directory, "settings.json"), "utf8"));
  assert.equal(saved.enabled, false);
  await handlers.get("session_shutdown")!({}, ctx);
  const count = statuses.length;
  assert.equal(editorView, undefined);
  await new Promise(resolve => setTimeout(resolve, 180));
  assert.equal(statuses.length, count);
});

test("requested shortcuts decode legacy and Kitty events without matching plain text", () => {
  const active = isKittyProtocolActive();
  try {
    for (const mode of [false, true]) {
      setKittyProtocolActive(mode);
      assert.ok(matchesKey("\x1b[97;3u", shortcuts.toggle));
      if (!mode) assert.ok(matchesKey("\x1ba", shortcuts.toggle));
      assert.ok(matchesKey("\x1b[115;3u", shortcuts.input));
      if (!mode) assert.ok(matchesKey("\x1bs", shortcuts.input));
      for (const text of ["a", "s", "A", "S", " ", "u", "\x1b"]) {
        for (const key of Object.values(shortcuts)) assert.ok(!matchesKey(text, key));
      }
    }
  } finally { setKittyProtocolActive(active); }
});

test("reports missing Markdown transformer support", () => {
  assert.throws(() => createBridge({} as ExtensionAPI), /registerMarkdownTransformer/);
});

test("Command Z uses the editor undo history and restores runtime bindings", () => {
  const manager = getKeybindings();
  const previous = structuredClone(manager.getUserBindings());
  const restore = installUndoShortcut();
  try {
    const editor = new Editor({ requestRender() {} } as any, { borderColor: (text: string) => text, selectList: {} } as any);
    const original = "Por favor, explica este error.";
    editor.setText(original);
    editor.setText("Please explain this error.");
    editor.handleInput("x");
    editor.handleInput("\x1b[122;9u");
    assert.equal(editor.getText(), "Please explain this error.");
    editor.handleInput("\x1b[122;9u");
    assert.equal(editor.getText(), original);
  } finally { restore(); }
  assert.deepEqual(manager.getUserBindings(), previous);
});

test("real fullscreen selection reaches translation before pi consumes the right click", async t => {
  if (process.platform !== "darwin") { t.skip("macOS clipboard integration"); return; }
  const directory = await mkdtemp(join(tmpdir(), "bridge-mouse-"));
  let input!: (data: string) => void;
  const terminal = new Proxy({
    columns: 80, rows: 24, kittyProtocolActive: false,
    start(handler: (data: string) => void) { input = handler; },
    stop() {}, write() {},
  }, { get: (target, key) => key in target ? (target as any)[key] : () => {} });
  let clipboard = "", clipboardReads = 0, copyCalls = 0, lateMouseEvents = 0;
  const tui = new TuiAltScreen(terminal as any, false, undefined, {
    copyOnSelect: true,
    async copySelection(text: string) { clipboard = text; copyCalls++; return true; },
  });
  tui.addChild(new Text("Selected English text"));
  tui.start();
  tui.renderNow(true);
  const select = () => {
    input("\x1b[<0;2;2M");
    input("\x1b[<32;9;2M");
    input("\x1b[<0;9;2m");
  };
  select();
  assert.equal(tui.hasActiveSelection(), true);
  tui.addInputListener(() => { lateMouseEvents++; return undefined; });
  input("\x1b[<2;9;2M");
  assert.equal(lateMouseEvents, 0); // Reproduces the old extension listener failure.
  const originalListeners = [...(tui as any).inputListeners];
  const handlers = new Map<string, (event: any, ctx: ExtensionContext) => any>();
  let disposeWidget: (() => void) | undefined;
  let translated = "", popup = false;
  let finishTranslation!: () => void;
  const translationGate = new Promise<void>(resolve => { finishTranslation = resolve; });
  const notifications: string[] = [];
  const ctx = {
    mode: "tui",
    sessionManager: { getSessionId: () => "mouse-test", getBranch: () => [] },
    ui: {
      notify(text: string) { notifications.push(text); },
      setStatus() {},
      setWidget(_key: string, factory: any) {
        disposeWidget?.();
        disposeWidget = factory ? factory(tui).dispose : undefined;
      },
      custom(factory: any, options: any) {
        popup = true;
        return new Promise<void>(resolve => {
          const view = factory(tui, popupTheme, {}, () => { tui.hideOverlay(); resolve(); });
          tui.showOverlay(view, typeof options.overlayOptions === "function" ? options.overlayOptions() : options.overlayOptions);
          tui.renderNow(true);
        });
      },
    },
  } as unknown as ExtensionContext;
  const pi = {
    on(name: string, handler: any) { handlers.set(name, handler); },
    registerMarkdownTransformer() {}, registerShortcut() {},
  } as unknown as ExtensionAPI;
  createBridge(pi, {
    directory,
    selectionDisplay: "terminal",
    async readClipboard() { clipboardReads++; return clipboard; },
    async translate(texts) { translated = texts[0]; await translationGate; return [translation]; },
  });
  t.after(async () => {
    await handlers.get("session_shutdown")?.({}, ctx);
    tui.stop();
    await rm(directory, { recursive: true, force: true });
  });
  await handlers.get("session_start")!({}, ctx);
  clipboard = "stale clipboard";
  const copiesBeforeRightClick = copyCalls;
  input("\x1b[<2;9;2M");
  await until(() => popup);
  assert.ok(tui.getScreenLines().some(line => line.includes("Translating")));
  finishTranslation();
  await until(() => tui.getScreenLines().some(line => line.includes(translation)));
  assert.equal(copyCalls, copiesBeforeRightClick + 1);
  assert.equal(clipboardReads, 1);
  assert.equal(translated, "Selected");
  assert.ok(tui.getScreenLines().some(line => line.includes(translation)));
  assert.equal(tui.hasOverlay(), true);
  input("\x1b[<2;9;2M");
  assert.equal(clipboardReads, 1); // Right click in the popup must not translate again.
  input("\x1b[<0;2;2M");
  assert.equal(tui.hasOverlay(), false);
  input("\x1b[<32;9;2M");
  input("\x1b[<0;9;2m");
  assert.equal(tui.hasActiveSelection(), true);
  assert.ok(copyCalls > copiesBeforeRightClick + 1);
  assert.deepEqual(notifications, []);
  await handlers.get("session_shutdown")!({}, ctx);
  assert.deepEqual([...(tui as any).inputListeners], originalListeners);
});

test("selection card stays above the pointer, animates loading, and clamps to screen edges", async () => {
  let redraws = 0;
  const tui = { terminal: { columns: 100, rows: 40 }, requestRender() { redraws++; } } as any;
  const popup = new SelectionPopup(tui, { x: 60, y: 30 }, "Selected English text", "zh-Hans", popupTheme, () => {});
  const options = popup.options();
  assert.ok(Number(options.row) + Number(options.maxHeight) <= 30);
  assert.ok(Number(options.col) + Number(options.width) <= 100);
  const initial = popup.render(Number(options.width)).join("\n");
  assert.ok(initial.includes(popupTheme.getBgAnsi("customMessageBg")));
  assert.ok(!initial.includes("╭") && initial.includes("Translating"));
  popup.start();
  try {
    await new Promise(resolve => setTimeout(resolve, 90));
    assert.ok(redraws > 0);
    assert.notEqual(popup.render(Number(options.width)).join("\n"), initial);
    popup.setResult(translation);
    assert.ok(popup.render(Number(options.width)).join("\n").includes(translation));
    assert.ok(Number(options.maxHeight) <= 7);
    assert.ok(Number(options.row) + Number(options.maxHeight) <= 30);
    popup.setResult("Long translation ".repeat(150));
    assert.ok(Number(options.maxHeight) > 7);
    assert.ok(Number(options.row) + Number(options.maxHeight) <= 30);
    const beforeScroll = popup.render(Number(options.width)).join("\n");
    popup.handleInput("\x1b[B");
    assert.notEqual(popup.render(Number(options.width)).join("\n"), beforeScroll);
  } finally { popup.dispose(); }
  const top = new SelectionPopup(tui, { x: 0, y: 0 }, "Word", "zh-Hans", popupTheme, () => {});
  assert.equal(top.options().row, 1);
  assert.ok(top.render(Number(top.options().width)).join("\n").includes(popupTheme.getBgAnsi("customMessageBg")));
  top.dispose();
});

test("native selection display cancels on dismissal and ignores late translation results", async t => {
  if (process.platform !== "darwin") { t.skip("macOS native panel integration"); return; }
  const directory = await mkdtemp(join(tmpdir(), "bridge-native-selection-"));
  const handlers = new Map<string, (event: any, ctx: ExtensionContext) => any>();
  const listeners = new Set<(data: string) => any>();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let onClose: (() => void) | undefined, receivedSignal: AbortSignal | undefined;
  let shown = 0, results = 0, closed = 0, disposed = false;
  const panel = {
    async show(source: string, target: string, callback: () => void) {
      assert.equal(source, "Selected text");
      assert.equal(target, "zh-Hans");
      shown++;
      onClose = callback;
      return { result() { results++; }, close() { closed++; } };
    },
    dispose() { disposed = true; },
  };
  let widget: any;
  const ctx = {
    mode: "tui",
    sessionManager: { getSessionId: () => "native-test", getBranch: () => [] },
    ui: {
      setStatus() {}, notify() {},
      setWidget(_key: string, factory: any) {
        widget?.dispose();
        widget = factory?.({ inputListeners: listeners, hasActiveSelection: () => true, copyActiveSelectionToClipboard: async () => true, hasOverlay: () => false, invalidate() {}, requestRender() {} });
      },
      custom() { assert.fail("Native selection must not create a terminal overlay"); },
    },
  } as unknown as ExtensionContext;
  createBridge({ on(name: string, handler: any) { handlers.set(name, handler); }, registerMarkdownTransformer() {}, registerShortcut() {} } as unknown as ExtensionAPI, {
    directory, panel, readClipboard: async () => "Selected text",
    async translate(_texts, _options, signal) { receivedSignal = signal; await gate; return [translation]; },
  });
  t.after(async () => { await handlers.get("session_shutdown")?.({}, ctx); await rm(directory, { recursive: true, force: true }); });
  await handlers.get("session_start")!({}, ctx);
  const input = (data: string) => { for (const handler of listeners) if (handler(data)?.consume) break; };
  input("\x1b[<2;9;2M");
  await until(() => receivedSignal !== undefined);
  assert.equal(shown, 1);
  onClose!();
  assert.equal(receivedSignal!.aborted, true);
  release();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(results, 0);
  input("\x1b[<2;9;2M");
  await until(() => results === 1);
  input("\x1b");
  assert.ok(closed >= 1);
  await handlers.get("session_shutdown")!({}, ctx);
  assert.equal(disposed, true);
});
