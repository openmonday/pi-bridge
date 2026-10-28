import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { bilingual, needsTranslation, protect, segments } from "./markdown.ts";
import { microsoft, type Translate, type TranslationOptions } from "./translator.ts";

export class TranslationEngine {
  private cache = new Map<string, string>();
  private pending = new Map<string, string>();
  private inFlight = new Set<string>();
  private controller = new AbortController();
  private running?: Promise<void>;
  private failures = new Set<string>();
  private generation = 0;
  private revision = 0;
  private savedRevision = 0;
  private saving?: Promise<void>;
  readonly options: TranslationOptions;
  private cachePath: string;
  private changed: () => void;
  private failed: (error: Error) => void;
  private translate: Translate;

  constructor(
    options: TranslationOptions,
    cachePath: string,
    changed: () => void,
    failed: (error: Error) => void,
    translate: Translate = microsoft,
  ) {
    this.options = { ...options };
    this.cachePath = cachePath;
    this.changed = changed;
    this.failed = failed;
    this.translate = translate;
  }

  private key(text: string) {
    return createHash("sha256").update(JSON.stringify(["microsoft-bing-v1", this.options.source, this.options.target, text])).digest("hex");
  }

  async load() {
    try {
      const data = JSON.parse(await readFile(this.cachePath, "utf8"));
      if (data.version === 1 && Array.isArray(data.entries)) {
        for (const entry of data.entries.slice(-3000)) {
          if (Array.isArray(entry) && /^[a-f0-9]{64}$/.test(entry[0]) && typeof entry[1] === "string") this.cache.set(entry[0], entry[1]);
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.failed(new Error("Could not read translation cache; translations will be fetched again"));
    }
  }

  enqueue(markdown: string, streaming = false) {
    for (const { text } of segments(markdown, streaming)) {
      const key = this.key(text);
      if (text.length <= 4000 && needsTranslation(text, this.options.target) && !this.cache.has(key) && !this.failures.has(key) && !this.inFlight.has(key)) this.pending.set(key, text);
    }
    this.start();
  }

  private start() {
    if (!this.running && this.pending.size && !this.controller.signal.aborted) {
      this.running = this.drain().finally(() => { this.running = undefined; this.start(); });
    }
  }

  render(markdown: string, streaming = false) {
    return bilingual(markdown, text => this.cache.get(this.key(text)), streaming);
  }

  get isBusy() { return this.pending.size > 0 || this.inFlight.size > 0; }

  private async drain() {
    const generation = this.generation;
    while (this.pending.size && !this.controller.signal.aborted && generation === this.generation) {
      const batch: [string, string][] = [];
      let size = 0;
      for (const entry of this.pending) {
        if (batch.length >= 16 || size + entry[1].length > 8000) break;
        batch.push(entry); size += entry[1].length;
      }
      for (const [key] of batch) { this.pending.delete(key); this.inFlight.add(key); }
      const protectedTexts = batch.map(([, text]) => protect(text));
      try {
        const translations = await this.translate(protectedTexts.map(t => t.text), this.options, this.controller.signal);
        if (this.controller.signal.aborted || generation !== this.generation) return;
        if (translations.length !== batch.length) throw new Error("Translation count does not match request count");
        const restored = translations.map((text, i) => protectedTexts[i].restore(text));
        restored.forEach((text, i) => this.cache.set(batch[i][0], text));
        while (this.cache.size > 3000) this.cache.delete(this.cache.keys().next().value!);
        this.revision++;
        this.changed();
      } catch (error) {
        if (this.controller.signal.aborted || generation !== this.generation) return;
        for (const [key] of batch) this.failures.add(key);
        this.failed(error instanceof Error ? error : new Error(String(error)));
        // Stop this queue on service failure instead of hammering it with history.
        this.pending.clear();
        break;
      } finally {
        for (const [key] of batch) this.inFlight.delete(key);
      }
    }
    await this.save();
  }

  async idle() { while (this.running) await this.running; }

  async save() {
    if (this.saving) { await this.saving; if (this.savedRevision !== this.revision) await this.save(); return; }
    if (this.savedRevision === this.revision) return;
    const revision = this.revision;
    const body = JSON.stringify({ version: 1, entries: [...this.cache] });
    this.saving = (async () => {
      try {
        await mkdir(dirname(this.cachePath), { recursive: true, mode: 0o700 });
        const temporary = `${this.cachePath}.${process.pid}.tmp`;
        await writeFile(temporary, body, { mode: 0o600 });
        await rename(temporary, this.cachePath);
        this.savedRevision = revision;
      } catch { this.failed(new Error("Could not save cache; translations remain available in memory")); }
    })().finally(() => { this.saving = undefined; });
    await this.saving;
  }

  async stop() {
    this.generation++;
    this.controller.abort();
    this.pending.clear();
    await this.running;
    this.controller = new AbortController();
    this.failures.clear();
    await this.save();
  }
}
