import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const sources = fileURLToPath(new URL("../macos/", import.meta.url));
const plist = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>dev.pi-bridge.panel</string><key>CFBundleExecutable</key><string>BridgePanel</string><key>CFBundleName</key><string>pi-bridge</string><key>CFBundlePackageType</key><string>APPL</string><key>LSUIElement</key><true/><key>NSHighResolutionCapable</key><true/></dict></plist>`;

// Build the helper once per source revision, outside the package checkout
// (pi runs `git clean -fdx` when it updates git packages).
export async function buildPanel(directory: string): Promise<string> {
  const swift = await readFile(join(sources, "main.swift"));
  const html = await readFile(join(sources, "popup.html"));
  const hash = createHash("sha256").update(swift).update(html).update(plist).digest("hex").slice(0, 12);
  const app = join(directory, "panel", hash, "BridgePanel.app");
  const executable = join(app, "Contents/MacOS/BridgePanel");
  try { await access(executable); return executable; } catch {}
  const staging = join(directory, "panel", `${hash}.${process.pid}.tmp`);
  const contents = join(staging, "BridgePanel.app/Contents");
  await rm(staging, { recursive: true, force: true });
  await mkdir(join(contents, "MacOS"), { recursive: true });
  await mkdir(join(contents, "Resources"), { recursive: true });
  await writeFile(join(contents, "Resources/popup.html"), html);
  await writeFile(join(contents, "Info.plist"), plist);
  try {
    await promisify(execFile)("/usr/bin/swiftc", ["-O", "-module-cache-path", join(staging, "module-cache"), "-framework", "AppKit", "-framework", "WebKit",
      join(sources, "main.swift"), "-o", join(contents, "MacOS/BridgePanel")], { timeout: 180_000 });
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    const detail = (error as { stderr?: string }).stderr?.trim().split("\n").slice(-3).join(" ") || (error as Error).message;
    throw new Error(`Could not build the selection panel; install Xcode Command Line Tools (xcode-select --install). ${detail}`);
  }
  await rm(join(staging, "module-cache"), { recursive: true, force: true });
  await mkdir(join(directory, "panel", hash), { recursive: true });
  try { await rename(join(staging, "BridgePanel.app"), app); }
  catch { await access(executable); } // another pi process finished first
  await rm(staging, { recursive: true, force: true });
  return executable;
}

export interface PanelSession { result(text: string, error?: boolean): void; close(): void }
export interface PanelPresenter {
  show(source: string, target: string, onClose: () => void): Promise<PanelSession>;
  dispose(): void;
}

export class NativePanel implements PanelPresenter {
  private child: ChildProcessWithoutNullStreams | undefined;
  private ready: Promise<void> | undefined;
  private active: { id: string; closed: () => void; shown?: () => void; reject?: (error: Error) => void } | undefined;
  private executable: () => Promise<string>;
  private args: string[];

  constructor(executable: string | (() => Promise<string>), args: string[] = []) {
    this.executable = typeof executable === "string" ? async () => executable : executable;
    this.args = args;
  }

  private start(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = this.executable().then(executable => new Promise<void>((resolve, reject) => {
      const child = this.child = spawn(executable, this.args, { stdio: "pipe" });
      let ready = false, diagnostics = "";
      const timeout = setTimeout(() => { reject(new Error("The selection panel did not start")); child.kill(); }, 12000);
      child.stderr.on("data", chunk => { diagnostics = (diagnostics + String(chunk)).slice(-1500); });
      const lines = createInterface({ input: child.stdout });
      lines.on("line", line => {
        let event: { type?: string; id?: string };
        try { event = JSON.parse(line); } catch { return; }
        if (event.type === "ready") { ready = true; clearTimeout(timeout); resolve(); }
        else if (event.id === this.active?.id) {
          if (event.type === "shown") this.active?.shown?.();
          if (event.type === "closed") this.closed();
        }
      });
      const failed = (error: Error) => {
        clearTimeout(timeout);
        if (!ready) reject(error);
        this.active?.reject?.(error);
        this.closed();
        if (this.child === child) { this.child = undefined; this.ready = undefined; }
        lines.close();
      };
      child.on("error", error => failed(new Error(`Could not launch the selection panel: ${error.message}`)));
      child.on("exit", code => failed(new Error(`Native panel exited (${code ?? "signal"})${diagnostics ? `: ${diagnostics}` : ""}`)));
      child.stdin.on("error", () => {});
    }));
    const ready = this.ready;
    ready.catch(() => { if (this.ready === ready) this.ready = undefined; });
    return ready;
  }

  private send(value: object) { this.child?.stdin.write(JSON.stringify(value) + "\n"); }
  private closed() { const active = this.active; this.active = undefined; active?.reject?.(new Error("The native panel was dismissed")); active?.closed(); }

  async show(source: string, target: string, onClose: () => void): Promise<PanelSession> {
    await this.start();
    if (this.active) { this.send({ type: "close", id: this.active.id }); this.closed(); }
    const id = randomUUID();
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { reject(new Error("The native panel did not appear")); if (this.active?.id === id) { this.send({ type: "close", id }); this.closed(); } }, 5000);
      this.active = { id, closed: onClose, shown: () => { clearTimeout(timeout); resolve(); }, reject: error => { clearTimeout(timeout); reject(error); } };
      this.send({ type: "show", id, source, target });
    });
    return {
      result: (text, error = false) => { if (this.active?.id === id) this.send({ type: "result", id, text, error }); },
      close: () => { if (this.active?.id === id) { this.send({ type: "close", id }); this.closed(); } },
    };
  }

  dispose() { this.closed(); this.send({ type: "quit" }); this.child?.stdin.end(); }
}
