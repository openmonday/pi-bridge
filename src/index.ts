import { getKeybindings, type TUI } from "@earendil-works/pi-tui";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TranslationEngine, microsoft, protect, type Translate } from "./core/index.ts";
import { NativePanel, buildPanel, type PanelPresenter } from "./native-panel.ts";
import { SelectionPopup } from "./selection-popup.ts";
import { TranslationEditor, type BridgeEditorFactory } from "./editor.ts";
import { latestMessageScope } from "./latest-message.ts";
import { installSelectionInput } from "./selection-input.ts";

interface Settings { enabled: boolean; source: string; target: string; streaming: boolean; users: boolean }
const defaults: Settings = { enabled: false, source: "auto", target: "zh-Hans", streaming: true, users: false };
const languages = new Set(["zh-Hans", "zh-Hant", "en", "ja", "ko", "fr", "de", "es", "ru", "pt", "ar"]);
export const shortcuts = { toggle: "alt+a", input: "alt+s" } as const;

export function installUndoShortcut() {
  const manager = getKeybindings();
  const previous = manager.getUserBindings()["tui.editor.undo"];
  const keys = manager.getKeys("tui.editor.undo");
  if (keys.includes("super+z")) return () => {};
  const installed = [...keys, "super+z" as const];
  manager.setUserBindings({ ...manager.getUserBindings(), "tui.editor.undo": installed });
  return () => {
    const current = manager.getUserBindings();
    if (JSON.stringify(current["tui.editor.undo"]) !== JSON.stringify(installed)) return;
    const restored = { ...current };
    if (previous === undefined) delete restored["tui.editor.undo"];
    else restored["tui.editor.undo"] = previous;
    manager.setUserBindings(restored);
  };
}

export function createBridge(pi: ExtensionAPI, options: { directory?: string; translate?: Translate; readClipboard?: () => Promise<string>; selectionDisplay?: "native" | "terminal"; panel?: PanelPresenter } = {}) {
  // Outside the package checkout: pi runs `git clean -fdx` when updating git packages.
  const directory = options.directory ?? join(getAgentDir(), "pi-bridge");
  const translate = options.translate ?? microsoft;
  // macOS gets a native WebKit card; other platforms use the terminal card.
  const native = process.platform === "darwin" && options.selectionDisplay !== "terminal" ? options.panel ?? new NativePanel(() => buildPanel(directory)) : undefined;
  let settings = { ...defaults };
  let context: ExtensionContext | undefined;
  let engine: TranslationEngine | undefined;
  let scope: ReturnType<typeof latestMessageScope> | undefined;
  let latest: { role: string; content?: unknown } | undefined;
  let redraw: (() => void) | undefined;
  let redrawTimer: ReturnType<typeof setTimeout> | undefined;
  let lastError = "";
  let inputAbort: AbortController | undefined;
  let editor: TranslationEditor | undefined;
  let editorFactory: BridgeEditorFactory | undefined;
  let restoreUndo: (() => void) | undefined;
  let unsubscribeInput: (() => void) | undefined;
  let popup: SelectionPopup | undefined;
  let closeSelection: (() => void) | undefined;
  let selectionAbort: AbortController | undefined;
  let selectionTui: (TUI & { hasActiveSelection?(): boolean; copyActiveSelectionToClipboard?(): Promise<boolean> }) | undefined;
  const readClipboard = options.readClipboard ?? (async () => {
    const result = await pi.exec("/usr/bin/pbpaste", [], { timeout: 2000 });
    if (result.code !== 0) throw new Error("Could not read selected text from clipboard");
    return result.stdout;
  });

  const refresh = () => {
    if (redrawTimer) return;
    redrawTimer = setTimeout(() => {
      redrawTimer = undefined;
      updateProgress();
      redraw?.();
    }, 80);
  };
  function status() {
    if (!context || context.mode !== "tui") return;
    updateProgress();
    // Only show a compact marker while translation is on; key hints live in the shortcut descriptions.
    const theme = context.ui.theme;
    const fg = (color: string, text: string) => theme?.fg ? theme.fg(color as never, text) : text;
    context.ui.setStatus("bridge", settings.enabled ? fg("accent", "⇄") + fg("dim", ` ${settings.target}`) : undefined);
  }
  function progressMessage() {
    return [
      settings.enabled && engine?.isBusy ? "Translating last reply" : "",
      inputAbort && !inputAbort.signal.aborted ? "Translating draft to English" : "",
    ].filter(Boolean).join(" · ") || undefined;
  }
  function updateProgress() {
    if (editor && context?.ui.getEditorComponent() !== editorFactory) {
      editor.dispose();
      editor = undefined;
    }
    editor?.setTranslation(progressMessage());
  }
  function installEditor(ctx: ExtensionContext) {
    if (typeof ctx.ui.getEditorComponent !== "function" || typeof ctx.ui.setEditorComponent !== "function") return;
    if (ctx.ui.getEditorComponent()) return;
    editorFactory = (tui, theme, keybindings) => {
      const view = new TranslationEditor(tui, theme, keybindings);
      editor = view;
      view.setTranslation(progressMessage());
      return view;
    };
    try { ctx.ui.setEditorComponent(editorFactory); }
    catch (error) {
      editorFactory = undefined;
      editor = undefined;
      ctx.ui.notify(`bridge editor: ${error instanceof Error ? error.message : String(error)}`, "warning");
    }
  }
  function restoreEditor() {
    if (editorFactory && typeof context?.ui.getEditorComponent === "function" && context.ui.getEditorComponent() === editorFactory) context.ui.setEditorComponent(undefined);
    editor?.dispose();
    editor = undefined;
    editorFactory = undefined;
  }
  function report(error: Error) {
    // The engine clears its in-flight state after this callback; refresh then
    // so a failed translation cannot leave the progress border on screen.
    setTimeout(() => status(), 0);
    if (lastError === error.message) return;
    lastError = error.message;
    context?.ui.notify(`bridge: ${error.message}. Toggle Alt+A off and on to retry.`, "warning");
  }
  async function saveSettings() {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, "settings.json");
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
    await rename(temporary, path);
  }
  function queueMessage(message: { role: string; content?: unknown }, streaming = false) {
    if (!settings.enabled || !engine) return;
    if (message.role !== "assistant") return;
    if (typeof message.content === "string") engine.enqueue(message.content, streaming);
    else if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part?.type === "text" && typeof part.text === "string") engine.enqueue(part.text.trim(), streaming);
      }
    }
    status();
  }
  function history() {
    const entries = context?.sessionManager.getBranch() ?? [];
    latest = undefined;
    for (const entry of entries) {
      if (entry.type === "message" && entry.message.role === "assistant") latest = entry.message;
    }
    if (latest) queueMessage(latest);
  }
  async function newEngine() {
    await engine?.stop();
    lastError = "";
    // Separate sessions avoid unrelated pi processes overwriting each other's cache.
    const id = context!.sessionManager.getSessionId().replace(/[^a-zA-Z0-9_-]/g, "_");
    engine = new TranslationEngine(settings, join(directory, "cache", `${id}.json`), refresh, report, translate);
    await engine.load();
  }

  if (typeof pi.registerMarkdownTransformer !== "function") throw new Error("bridge requires pi 1.3.0 or newer with registerMarkdownTransformer support");
  pi.registerMarkdownTransformer((markdown, metadata) => {
    if (!settings.enabled || !engine || metadata.messageType === "assistant-thinking") return markdown;
    if (metadata.messageType !== "assistant" || !scope?.includesCurrent()) return markdown;
    return engine.render(markdown, metadata.isStreaming);
  });

  pi.on("session_start", async (_event, ctx) => {
    inputAbort?.abort();
    inputAbort = undefined;
    restoreEditor();
    closeSelection?.();
    selectionAbort?.abort();
    unsubscribeInput?.();
    selectionTui = undefined;
    await engine?.stop();
    engine = undefined;
    context = ctx;
    restoreUndo?.();
    restoreUndo = undefined;
    if (ctx.mode !== "tui") return;
    installEditor(ctx);
    restoreUndo = installUndoShortcut();
    settings = { ...defaults };
    try {
      const saved = JSON.parse(await readFile(join(directory, "settings.json"), "utf8"));
      for (const key of ["streaming"] as const) if (typeof saved[key] === "boolean") settings[key] = saved[key];
      if (languages.has(saved.target)) settings.target = saved.target;
      if (saved.source === "auto" || languages.has(saved.source)) settings.source = saved.source;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") report(new Error("Could not read settings; using defaults"));
    }
    scope?.dispose();
    ctx.ui.setWidget("bridge-refresh", tui => {
      scope = latestMessageScope(tui);
      unsubscribeInput?.();
      selectionTui = tui;
      let removeInput: (() => void) | undefined;
      try {
        removeInput = installSelectionInput(tui, data => {
          const event = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(data);
          if (!event || process.platform !== "darwin") {
            if (data === "\x1b") closeSelection?.();
            return;
          }
          const button = Number(event[1]), x = Number(event[2]) - 1, y = Number(event[3]) - 1;
          const press = event[4] === "M" && (button & 32) === 0 && (button & 64) === 0;
          if (popup) {
            if (popup.contains(x, y)) { if (event[4] === "M") popup.mouse(button, x, y); return { consume: true }; }
            if (press) closeSelection?.();
          }
          if (press && (button & 3) === 0) { closeSelection?.(); selectionAbort?.abort(); }
          if (button !== 2 || !press || tui.hasOverlay() || !selectionTui?.hasActiveSelection?.()) return;
          void translateSelection(ctx, { x, y });
          return { consume: true };
        });
        unsubscribeInput = removeInput;
      } catch (error) {
        ctx.ui.notify(`bridge selection: ${error instanceof Error ? error.message : String(error)}`, "warning");
      }
      // A footer update alone does not invalidate Markdown's internal render cache.
      redraw = () => { scope?.update(); tui.invalidate(); tui.requestRender(); };
      return { render: () => [], invalidate() {}, dispose() { scope?.dispose(); removeInput?.(); redraw = undefined; selectionTui = undefined; } };
    });
    await newEngine();
    status();
    if (settings.enabled) history();
    refresh();
  });
  const receive = (message: { role: string; content?: unknown }, streaming = false) => {
    if (message.role !== "assistant") return;
    latest = message;
    if (!streaming || settings.streaming) queueMessage(message, streaming);
    refresh();
  };
  pi.on("message_update", event => receive(event.message, true));
  pi.on("message_end", event => receive(event.message));
  pi.on("session_tree", () => { history(); refresh(); });
  pi.on("session_compact", () => { history(); refresh(); });
  pi.on("session_shutdown", async () => {
    restoreEditor();
    scope?.dispose();
    scope = undefined;
    native?.dispose();
    restoreUndo?.();
    restoreUndo = undefined;
    unsubscribeInput?.();
    unsubscribeInput = undefined;
    closeSelection?.();
    selectionAbort?.abort();
    selectionTui = undefined;
    inputAbort?.abort();
    inputAbort = undefined;
    if (redrawTimer) clearTimeout(redrawTimer);
    redrawTimer = undefined;
    await engine?.stop();
    engine = undefined;
    context?.ui.setWidget("bridge-refresh", undefined);
    context?.ui.setStatus("bridge", undefined);
    context = undefined;
    redraw = undefined;
  });

  function interactive(ctx: ExtensionContext) {
    if (ctx.mode !== "tui" || !engine) return false;
    context = ctx;
    return true;
  }

  async function persist() {
    try { await saveSettings(); } catch { context?.ui.notify("Could not save settings; current changes remain active", "warning"); }
    status();
    if (settings.enabled && latest) queueMessage(latest);
    refresh();
  }

  // Serialize settings/engine changes when keys are pressed repeatedly.
  let changing = false;
  async function change(action: () => Promise<void>) {
    if (changing) return;
    changing = true;
    try { await action(); } finally { changing = false; }
  }

  async function toggle() {
    if (!settings.enabled && !latest) history();
    settings.enabled = !settings.enabled;
    if (!settings.enabled) await engine!.stop();
    await persist();
  }

  pi.registerShortcut(shortcuts.toggle, {
    description: "bridge: Toggle translation of the last reply",
    handler: async ctx => { if (interactive(ctx)) await change(toggle); },
  });

  async function translateSelection(ctx: ExtensionContext, point: { x: number; y: number }) {
    if (!interactive(ctx)) return;
    closeSelection?.();
    selectionAbort?.abort();
    const controller = selectionAbort = new AbortController();
    const currentEngine = engine;
    const currentTui = selectionTui;
    const target = settings.target;
    const current = () => !controller.signal.aborted && engine === currentEngine && context === ctx;
    try {
      if (!await currentTui?.copyActiveSelectionToClipboard?.() || !current()) return;
      const source = (await readClipboard()).trim();
      if (!current() || !source) return;
      if (source.length > 4000) { ctx.ui.notify("Select up to 4000 characters for translation", "warning"); return; }
      const protectedText = protect(source);
      if (native) {
        let session: Awaited<ReturnType<PanelPresenter["show"]>> | undefined;
        const close = () => { controller.abort(); session?.close(); if (closeSelection === close) closeSelection = undefined; };
        closeSelection = close;
        session = await native.show(source, target, close);
        if (!current()) { session.close(); return; }
        try {
          const result = await translate([protectedText.text], { source: "auto", target }, controller.signal);
          if (current()) session.result(protectedText.restore(result[0]));
        } catch (error) { if (current()) session.result(error instanceof Error ? error.message : String(error), true); }
        return;
      }
      await ctx.ui.custom<void>((tui, theme, _keys, done) => {
        let closed = false;
        const close = () => {
          if (closed) return;
          closed = true;
          controller.abort();
          view.dispose();
          if (popup === view) { popup = undefined; closeSelection = undefined; }
          done();
        };
        const view = new SelectionPopup(tui, point, source, target, theme, close);
        popup = view;
        closeSelection = close;
        view.start();
        void translate([protectedText.text], { source: "auto", target }, controller.signal).then(result => {
          if (current()) view.setResult(protectedText.restore(result[0]));
        }).catch(error => { if (current()) view.setResult(error instanceof Error ? error.message : String(error), true); });
        return view;
      }, { overlay: true, overlayOptions: () => popup!.options() });
    } catch (error) {
      if (current()) ctx.ui.notify(`bridge selection: ${error instanceof Error ? error.message : String(error)}`, "warning");
    }
  }

  async function translateDraft(ctx: ExtensionContext) {
    if (!interactive(ctx)) return;
    const draft = ctx.ui.getEditorText();
    if (!draft.trim()) { ctx.ui.notify("Write a draft, then press Alt+S", "info"); return; }
    const currentEngine = engine;
    inputAbort?.abort();
    const controller = inputAbort = new AbortController();
    status();
    try {
      const protectedText = protect(draft);
      const result = await translate([protectedText.text], { source: "auto", target: "en" }, controller.signal);
      if (controller.signal.aborted || engine !== currentEngine) return;
      if (ctx.ui.getEditorText() !== draft) { ctx.ui.notify("Draft changed; kept your edits. Press Alt+S to translate again", "warning"); return; }
      ctx.ui.setEditorText(protectedText.restore(result[0]));
    } catch (error) { if (!controller.signal.aborted) report(error instanceof Error ? error : new Error(String(error))); }
    finally {
      if (inputAbort === controller) { inputAbort = undefined; status(); }
    }
  }

  pi.registerShortcut(shortcuts.input, {
    description: "bridge: Translate draft to English without sending",
    handler: translateDraft,
  });
}

export default function bridge(pi: ExtensionAPI) { createBridge(pi); }
