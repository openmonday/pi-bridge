import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TranslationEngine, type Translate } from "../src/core/index.ts";

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "bridge-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return join(dir, "cache.json");
}

test("deduplicates requests, restores code, persists cache, and isolates languages", async t => {
  const path = await fixture(t);
  let calls = 0, changed = 0;
  const errors: Error[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const translate: Translate = async texts => { calls++; await gate; return texts.map(s => "translated " + s); };
  const engine = new TranslationEngine({ source: "auto", target: "zh-Hans" }, path, () => changed++, e => errors.push(e), translate);
  engine.enqueue("Use `code`."); engine.enqueue("Use `code`.");
  release(); await engine.idle();
  assert.equal(calls, 1);
  assert.equal(changed, 1);
  assert.ok(engine.render("Use `code`.").includes("translated"));
  assert.equal(errors.length, 0);
  assert.ok(!(await readFile(path, "utf8")).includes('"Use `code`."'));
  const loaded = new TranslationEngine({ source: "auto", target: "zh-Hans" }, path, () => {}, e => errors.push(e), translate);
  await loaded.load(); loaded.enqueue("Use `code`."); await loaded.idle();
  assert.equal(calls, 1);
  assert.equal(loaded.render("Use `code`."), engine.render("Use `code`."));
  const other = new TranslationEngine({ source: "auto", target: "ja" }, path, () => {}, () => {}, translate);
  await other.load();
  assert.equal(other.render("Use `code`."), "Use `code`.");
});

test("drops late results after stopping and resumes with new text", async t => {
  const path = await fixture(t);
  let release!: (value: string[]) => void;
  const engine = new TranslationEngine({ source: "auto", target: "zh-Hans" }, path, () => {}, () => {}, async () => new Promise(resolve => { release = resolve; }));
  engine.enqueue("Hello");
  const stopped = engine.stop();
  release(["Hola"]); await stopped;
  assert.equal(engine.render("Hello"), "Hello");
  engine.enqueue("World"); release(["Mundo"]); await engine.idle();
  assert.ok(engine.render("World").includes("Mundo"));
});

test("reports errors without changing the source or retrying indefinitely", async t => {
  const path = await fixture(t);
  const errors: Error[] = [];
  let calls = 0;
  const engine = new TranslationEngine({ source: "auto", target: "zh-Hans" }, path, () => {}, e => errors.push(e), async () => { calls++; throw new Error("HTTP 429"); });
  engine.enqueue("Hello"); await engine.idle();
  engine.enqueue("Hello"); await engine.idle();
  assert.equal(calls, 1); assert.equal(errors.length, 1);
  assert.equal(engine.render("Hello"), "Hello");
});
