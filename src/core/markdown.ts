import { Lexer, type Tokens } from "marked";


export interface Segment {
  text: string;
  end: number;
  prefix: string;
}

interface View { text: string; offsets: number[] }

function slice(view: View, start: number, end = view.text.length): View {
  return { text: view.text.slice(start, end), offsets: view.offsets.slice(start, end) };
}

// Strip container markers while retaining a map back to the untouched source.
function stripLines(view: View, strip: (line: string, first: boolean) => number): View {
  const offsets: number[] = [];
  let text = "", start = 0;
  for (const line of view.text.split(/(?<=\n)/)) {
    const count = strip(line, start === 0);
    text += line.slice(count);
    offsets.push(...view.offsets.slice(start + count, start + line.length));
    start += line.length;
  }
  return { text, offsets };
}

export function segments(markdown: string, streaming = false): Segment[] {
  const result: Segment[] = [];
  const math = [...markdown.matchAll(/\$\$[\s\S]*?(?:\$\$|$)|\\\[[\s\S]*?(?:\\\]|$)/g)]
    .map(m => [m.index!, m.index! + m[0].length]);

  function walk(view: View, partial = false) {
    const tokens = Lexer.lex(view.text);
    let cursor = 0;
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      // A parser normalization we cannot map safely must never corrupt Markdown.
      if (!view.text.startsWith(token.raw, cursor)) return;
      const start = cursor;
      cursor += token.raw.length;
      if (partial && i === tokens.length - 1 && token.type !== "space") break;
      const sub = slice(view, start, cursor);
      if (token.type === "list") {
        let itemCursor = 0;
        for (const item of (token as Tokens.List).items) {
          const itemStart = sub.text.indexOf(item.raw, itemCursor);
          if (itemStart < 0) break;
          itemCursor = itemStart + item.raw.length;
          const itemView = slice(sub, itemStart, itemCursor);
          const marker = /^( {0,3}(?:[-+*]|\d+[.)])\s+)/.exec(item.raw);
          if (!marker) continue;
          const indent = marker[0].length;
          walk(stripLines(itemView, (line, first) => first
            ? indent + (/^\[[ xX]\]\s+/.exec(line.slice(indent))?.[0].length ?? 0)
            : Math.min(/^ */.exec(line)![0].length, indent)));
        }
      } else if (token.type === "blockquote") {
        walk(stripLines(sub, line => /^( {0,3}> ?)/.exec(line)?.[0].length ?? 0));
      } else if (token.type === "paragraph" || token.type === "heading" || token.type === "text") {
        const text = (token as Tokens.Paragraph).text;
        if (!text?.trim()) continue;
        const end = sub.offsets[token.raw.trimEnd().length - 1] + 1;
        const begin = sub.offsets[0];
        if (math.some(([a, b]) => begin < b && end > a)) continue;
        const lineStart = markdown.lastIndexOf("\n", begin - 1) + 1;
        const before = markdown.slice(lineStart, begin);
        // Keep quote containers; replace list markers and task boxes with indentation.
        const prefix = before.replace(/(?:[-+*]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/g, m => " ".repeat(m.length));
        if (!/^[ >\t]*$/.test(prefix)) continue;
        result.push({ text, end, prefix });
      }
      // Code, HTML, tables, link definitions and thematic breaks stay untouched.
    }
  }
  const view: View = { text: "", offsets: [] };
  for (let i = 0; i < markdown.length; i++) {
    if (markdown[i] === "\r" && markdown[i + 1] === "\n") continue;
    view.text += markdown[i] === "\r" ? "\n" : markdown[i];
    view.offsets.push(i);
  }
  walk(view, streaming);
  return result;
}

export function protect(text: string) {
  const kept: string[] = [];
  // Protect inline code, math, URLs, link destinations, and HTML tags.
  const value = text.replace(/(`+)[\s\S]*?\1|\$[^$\n]+\$|\\\([\s\S]*?\\\)|!?\[[^\]\n]*\]\([^\n]*?\)|https?:\/\/[^\s<>]+|<[^>\n]+>/g,
    match => { kept.push(match); return `[ZT_KEEP_${kept.length - 1}]`; });
  return {
    text: value,
    restore(translated: string): string {
      for (let i = 0; i < kept.length; i++) {
        const marker = `[ZT_KEEP_${i}]`;
        if (translated.split(marker).length !== 2) throw new Error("Translation did not preserve code or link placeholders");
      }
      return translated.replace(/\[ZT_KEEP_(\d+)\]/g, (_, i) => kept[Number(i)] ?? "");
    },
  };
}

export function needsTranslation(text: string, target: string): boolean {
  const plain = protect(text).text.replace(/\[ZT_KEEP_\d+\]/g, "");
  if (!/\p{L}/u.test(plain)) return false;
  if (target === "zh-Hans" && /\p{Script=Han}/u.test(plain) && !/[A-Za-z]{3}/.test(plain)) return false;
  return true;
}

// Service output is untrusted: strip terminal control sequences and keep it to
// one inline paragraph. Inline Markdown (emphasis, code, links) still renders;
// a leading block marker and raw HTML are escaped so it cannot become a
// heading, list, quote, fence, table, or HTML block.
export function safeTranslation(text: string): string {
  return text.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|$))?/g, "")
    .replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, " ")
    .trim()
    .replace(/</g, "\\<")
    .replace(/^(\d+)([.)])/, "$1\\$2")
    .replace(/^([#>*+\-=_|~`])/, "\\$1");
}

export function bilingual(markdown: string, lookup: (text: string) => string | undefined, streaming = false): string {
  let output = markdown;
  for (const segment of segments(markdown, streaming).reverse()) {
    const translated = lookup(segment.text);
    if (!translated || translated.trim() === segment.text.trim()) continue;
    const addition = `\n\n${segment.prefix}${safeTranslation(translated)}`;
    output = output.slice(0, segment.end) + addition + output.slice(segment.end);
  }
  return output;
}
