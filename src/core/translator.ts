export interface TranslationOptions { source: string; target: string }
export type Translate = (texts: string[], options: TranslationOptions, signal: AbortSignal) => Promise<string[]>;

// The public Bing Translator page used by the JetBrains translation plugin.
// It returns the same Microsoft neural/LLM translation used by the web UI,
// which is noticeably better than the per-segment edge.microsoft.com endpoint.
const PAGE = "https://www.bing.com/translator";
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const AUTH_MARGIN = 60_000;
const AUTH_TIMEOUT = 15_000;
const REQUEST_TIMEOUT = 25_000;
const CONCURRENCY = 4;
const MAX_REQUEST = 4_000;

interface Session {
  origin: string;
  cookie: string;
  ig: string;
  iid: string;
  key: string;
  token: string;
  expires: number;
}

class StaleSession extends Error {}

function parseSession(html: string, page: string, headers: Headers): Session {
  // params_AbusePreventionHelper = [key, token, ttl]; the first data-iid is
  // the translator page context expected by ttranslatev3.
  const abuse = /params_AbusePreventionHelper\s*=\s*\[\s*(\d+)\s*,\s*"([^"]+)"\s*,\s*(\d+)\s*]/.exec(html);
  const ig = /IG\s*:\s*"([A-Fa-f0-9]+)"/.exec(html);
  const iid = /data-iid\s*=\s*"([^"]+)"/.exec(html);
  if (!abuse || !ig || !iid) throw new Error("Could not read the Microsoft Translator session");
  const cookie = headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
  return {
    origin: new URL(page).origin,
    cookie,
    ig: ig[1],
    iid: iid[1],
    key: abuse[1],
    token: abuse[2],
    expires: Date.now() + Math.max(60_000, Number(abuse[3]) - AUTH_MARGIN),
  };
}

async function loadSession(): Promise<Session> {
  const response = await fetch(PAGE, {
    headers: { "User-Agent": USER_AGENT },
    redirect: "follow",
    signal: AbortSignal.timeout(AUTH_TIMEOUT),
  });
  if (!response.ok) throw new Error(`Microsoft Translator page returned HTTP ${response.status}`);
  return parseSession(await response.text(), response.url || PAGE, response.headers);
}

async function request(text: string, options: TranslationOptions, signal: AbortSignal, session: Session) {
  const url = new URL("/ttranslatev3", session.origin);
  url.searchParams.set("isVertical", "1");
  url.searchParams.set("IG", session.ig);
  url.searchParams.set("IID", session.iid);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": USER_AGENT,
      Referer: new URL("/translator", session.origin).href,
      Cookie: session.cookie,
    },
    body: new URLSearchParams({
      token: session.token,
      key: session.key,
      text,
      fromLang: options.source === "auto" ? "auto-detect" : options.source,
      to: options.target,
    }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT)]),
  });
  if (response.status === 401 || response.status === 403) throw new StaleSession(`Microsoft Translator returned HTTP ${response.status}`);
  if (!response.ok) throw new Error(`Microsoft Translator returned HTTP ${response.status}`);
  const raw = await response.text();
  if (!raw.trim()) throw new StaleSession("Microsoft Translator returned an empty response");
  let data: unknown;
  try { data = JSON.parse(raw); } catch { throw new Error("Invalid Microsoft Translator response format"); }
  // Bing appends { translationSrcText } when it normalizes the input (for
  // example "50MB+" -> "50MB "), so only the first element is the result.
  if (!Array.isArray(data) || data.length === 0) throw new Error("Invalid Microsoft Translator response format");
  const translated = data[0]?.translations?.[0]?.text;
  if (typeof translated !== "string" || !translated.trim()) throw new StaleSession("Microsoft Translator returned empty text");
  return translated;
}

// Keep placeholders intact and prefer a sentence boundary when a draft is
// longer than one request. Engine segments and selections are already <= 4000.
function split(text: string, limit = MAX_REQUEST): string[] {
  if (text.length <= limit) return [text];
  const parts: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    const window = remaining.slice(0, limit + 1);
    let end = Math.max(
      window.lastIndexOf("\n\n"),
      window.lastIndexOf(". "),
      window.lastIndexOf("\u3002"),
      window.lastIndexOf(" "),
    );
    if (end < limit / 2) end = limit;
    const open = remaining.lastIndexOf("[ZT_KEEP_", end);
    if (open >= 0 && remaining.indexOf("]", open) >= end) end = open;
    if (end <= 0) end = limit;
    parts.push(remaining.slice(0, end));
    remaining = remaining.slice(end);
  }
  if (remaining) parts.push(remaining);
  return parts;
}

export function createMicrosoftTranslator(): Translate {
  let session: Session | undefined;
  let loading: Promise<Session> | undefined;

  function authenticate(force = false): Promise<Session> {
    if (force) session = undefined;
    if (session && Date.now() < session.expires) return Promise.resolve(session);
    if (!loading) {
      loading = loadSession()
        .then(value => { session = value; return value; })
        .finally(() => { loading = undefined; });
    }
    return loading;
  }

  async function translateText(text: string, options: TranslationOptions, signal: AbortSignal) {
    if (!text) return "";
    for (let attempt = 0; ; attempt++) {
      const current = await authenticate(attempt > 0);
      try {
        return await request(text, options, signal, current);
      } catch (error) {
        if (attempt === 0 && error instanceof StaleSession) continue;
        throw error;
      }
    }
  }

  async function translateChunks(text: string, options: TranslationOptions, signal: AbortSignal) {
    const output: string[] = [];
    for (const part of split(text)) {
      signal.throwIfAborted();
      output.push(await translateText(part, options, signal));
    }
    return output.join(" ");
  }

  return async (texts, options, signal) => {
    signal.throwIfAborted();
    if (!texts.length) return [];
    const results = new Array<string>(texts.length);
    let next = 0;
    const worker = async () => {
      while (true) {
        const index = next++;
        if (index >= texts.length) return;
        results[index] = await translateChunks(texts[index], options, signal);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, texts.length) }, worker));
    return results;
  };
}

export const microsoft = createMicrosoftTranslator();
