import test from "node:test";
import assert from "node:assert/strict";
import { createMicrosoftTranslator } from "../src/core/translator.ts";

const page = `<html><script>params_AbusePreventionHelper = [123,"tok",3600000]; var IG:"ABCDEF1234";</script><div data-iid="translator.5023"></div></html>`;

function pageResponse(body = page) {
  const response = new Response(body, { headers: { "set-cookie": "MUID=abc; Path=/", "content-type": "text/html" } });
  Object.defineProperty(response, "url", { value: "https://cn.bing.com/translator" });
  return response;
}

test("reads the Bing session, sends form requests, and reuses auth", async t => {
  const calls: { url: URL; init: RequestInit }[] = [];
  let pages = 0;
  t.mock.method(globalThis, "fetch", async (input: URL | string, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    if (url.pathname === "/translator") { pages++; return pageResponse(); }
    assert.equal(url.origin, "https://cn.bing.com");
    assert.equal(url.pathname, "/ttranslatev3");
    assert.equal(url.searchParams.get("isVertical"), "1");
    assert.equal(url.searchParams.get("IG"), "ABCDEF1234");
    assert.equal(url.searchParams.get("IID"), "translator.5023");
    assert.equal(new Headers(init.headers).get("cookie"), "MUID=abc");
    assert.equal(new Headers(init.headers).get("referer"), "https://cn.bing.com/translator");
    const form = new URLSearchParams(String(init.body));
    assert.equal(form.get("token"), "tok");
    assert.equal(form.get("key"), "123");
    assert.equal(form.get("fromLang"), "auto-detect");
    assert.equal(form.get("to"), "es");
    return new Response(JSON.stringify([{ translations: [{ text: form.get("text") === "Hello" ? "Hola" : "Mundo" }] }]));
  });
  const translate = createMicrosoftTranslator();
  assert.deepEqual(await translate(["Hello", "World"], { source: "auto", target: "es" }, new AbortController().signal), ["Hola", "Mundo"]);
  assert.equal(pages, 1);
  assert.equal(calls.filter(call => call.url.pathname === "/ttranslatev3").length, 2);
});

test("accepts the extra source element Bing adds after normalizing input", async t => {
  t.mock.method(globalThis, "fetch", async (input: URL | string) => {
    if (new URL(String(input)).pathname === "/translator") return pageResponse();
    return new Response(JSON.stringify([
      { translations: [{ text: "缺点：增加约50MB的依赖项", to: "zh-Hans" }], usedLLM: true, detectedLanguage: { language: "en" } },
      { translationSrcText: "Downside: adds ~50MB  of dependencies" },
    ]));
  });
  const translate = createMicrosoftTranslator();
  assert.deepEqual(await translate(["Downside: adds ~50MB+ of dependencies"], { source: "auto", target: "zh-Hans" }, new AbortController().signal), ["缺点：增加约50MB的依赖项"]);
});

test("refreshes a stale session once and rejects bad responses", async t => {
  let pages = 0, posts = 0;
  t.mock.method(globalThis, "fetch", async (input: URL | string) => {
    const url = new URL(String(input));
    if (url.pathname === "/translator") { pages++; return pageResponse(); }
    posts++;
    if (posts === 1) return new Response("");
    return new Response(JSON.stringify([{ translations: [{ text: "Hola" }] }]));
  });
  const translate = createMicrosoftTranslator();
  assert.deepEqual(await translate(["Hello"], { source: "auto", target: "es" }, new AbortController().signal), ["Hola"]);
  assert.equal(pages, 2);
  assert.equal(posts, 2);

  t.mock.method(globalThis, "fetch", async (input: URL | string) => {
    const url = new URL(String(input));
    return url.pathname === "/translator" ? pageResponse("<html>no session</html>") : new Response("", { status: 500 });
  });
  await assert.rejects(() => createMicrosoftTranslator()(["Hello"], { source: "auto", target: "zh-Hans" }, new AbortController().signal), /session/);

  t.mock.method(globalThis, "fetch", async (input: URL | string) => {
    const url = new URL(String(input));
    return url.pathname === "/translator" ? pageResponse() : new Response("", { status: 500 });
  });
  await assert.rejects(() => createMicrosoftTranslator()(["Hello"], { source: "auto", target: "en" }, new AbortController().signal), /HTTP 500/);

  t.mock.method(globalThis, "fetch", async (input: URL | string) => {
    const url = new URL(String(input));
    return url.pathname === "/translator" ? pageResponse() : new Response("[]");
  });
  await assert.rejects(() => createMicrosoftTranslator()(["Hello"], { source: "auto", target: "en" }, new AbortController().signal), /format/);
});
