import test from "node:test";
import assert from "node:assert/strict";
import { Lexer, type Tokens } from "marked";
import { bilingual, needsTranslation, protect, safeTranslation, segments } from "../src/core/index.ts";

test("preserves prose containers and skips code, tables, and math", () => {
  const markdown = "# Heading\n\nA paragraph with `code`.\n\n- first\n- second\n  - nested\n\n> quoted\n\n```js\nconst secret = 'unchanged';\n```\n\n    indented code\n\n$$\nx = y\n\n+ z\n$$\n\n| A | B |\n|---|---|\n| C | D |\n";
  assert.deepEqual(segments(markdown).map(s => s.text), ["Heading", "A paragraph with `code`.", "first", "second", "nested", "quoted"]);
  assert.equal(bilingual(markdown, () => undefined), markdown);
  const result = bilingual(markdown, () => "Spanish translation");
  assert.ok(result.includes("```js\nconst secret = 'unchanged';\n```"));
  const list = Lexer.lex(result).find(t => t.type === "list");
  assert.equal(list?.type === "list" && list.items.length, 2);
  assert.ok(result.includes("    Spanish translation"));
});

test("maps multiline lists and repeated paragraphs to their source offsets", () => {
  const input = "- repeated text\n  continues here\n- repeated text\n\nrepeated text";
  assert.deepEqual(segments(input).map(s => s.text), ["repeated text\ncontinues here", "repeated text", "repeated text"]);
  const result = bilingual(input, () => "translated");
  assert.equal(result.match(/translated/g)?.length, 3);
  assert.ok(result.includes("continues here\n\n  translated"));
});

test("streams only complete top-level blocks", () => {
  assert.deepEqual(segments("Finished.\n\nStill writing", true).map(s => s.text), ["Finished."]);
  assert.deepEqual(segments("Finished.\n\n", true).map(s => s.text), ["Finished."]);
  assert.deepEqual(segments("```ts\nnot prose\n", true), []);
  assert.deepEqual(segments("- unstable list", true), []);
});

test("preserves source offsets in CRLF documents", () => {
  const source = "First\r\n\r\nSecond\r\n";
  assert.deepEqual(segments(source).map(s => s.text), ["First", "Second"]);
  assert.equal(bilingual(source, () => undefined), source);
  assert.ok(bilingual(source, () => "translated").includes("Second\n\ntranslated\r\n"));
});

test("protects inline code, math, and links and rejects damaged placeholders", () => {
  const source = "Use `push_back` with $x_i$ and [docs](https://example.com).";
  const prepared = protect(source);
  assert.ok(!prepared.text.includes("push_back"));
  assert.equal(prepared.restore(prepared.text), source);
  assert.throws(() => prepared.restore("missing placeholders"));
  assert.throws(() => prepared.restore(prepared.text + " [ZT_KEEP_0]"));
  assert.equal(needsTranslation("`identifier`", "zh-Hans"), false);
});

test("renders service output as text without terminal control sequences", () => {
  const result = safeTranslation("\x1b[2J```\n# injected\x07");
  assert.ok(!result.includes("\x1b"));
  assert.ok(!result.includes("\x07"));
  assert.ok(result.startsWith("\\`"));
  assert.ok(!Lexer.lex(bilingual("Hello", () => "```\nattack")).some(t => t.type === "code"));
  for (const attack of ["# h", "- item", "1. item", "> quote", "| a | b |", "<div>x</div>", "---"]) {
    const types = Lexer.lex(bilingual("Hello", () => attack)).map(t => t.type);
    assert.deepEqual(types.filter(t => t !== "space"), ["paragraph", "paragraph"], attack);
  }
});

test("keeps inline Markdown in translations", () => {
  const output = bilingual("Use the **run** command with `npm test`, see [docs](https://x.dev).",
    () => "使用 **run** 命令和 `npm test`,参见 [文档](https://x.dev)。");
  const inline = (Lexer.lex(output).at(-1) as any).tokens.map((t: any) => t.type);
  assert.ok(inline.includes("strong") && inline.includes("codespan") && inline.includes("link"), inline.join());
});

test("leading inline markers in Chinese translations still render", () => {
  for (const text of ["**注意** 这是重点", "*强调*文字", "~~删除~~文字", "`code`是代码"]) {
    const inline = Lexer.lex(bilingual("Hello", () => text)).filter(t => t.type === "paragraph")[1] as Tokens.Paragraph;
    assert.ok(inline.tokens.some(t => ["strong", "em", "del", "codespan"].includes(t.type)), text);
  }
});

test("does not escape angle brackets inside translated text", () => {
  assert.equal(safeTranslation("路径 notes/<topic>/ 下"), "路径 notes/<topic>/ 下");
  assert.equal(Lexer.lex(bilingual("Hello", () => "<div>x</div>")).filter(t => t.type === "html").length, 0);
});
