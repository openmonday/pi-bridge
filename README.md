# pi-bridge

Display-only bilingual translation for the [pi](https://github.com/earendil-works/pi) coding agent.

pi-bridge keeps the original reply and appends a translated paragraph below each Markdown block. Translations exist only in the rendered transcript. Source messages, session files, and the agent context are never modified.

## Install

Add the package to `~/.pi/agent/settings.json`:

```json
{
  "packages": ["git:github.com/openmonday/pi-bridge.git"]
}
```

or run `pi install git:github.com/openmonday/pi-bridge.git`. Requires pi 1.3.0 or newer and Node.js 22.18 or newer.

## Shortcuts

| Shortcut | Action |
| --- | --- |
| `Alt+A` | Show or hide the translation of the last assistant reply |
| `Alt+S` | Translate the current draft to English in place, without sending |
| `Cmd+Z` | Undo, including a draft translation; pi's own undo bindings remain |
| Select + right-click | Translate the selection in a floating card (macOS only, see below) |

On macOS, Alt is the Option key, so the terminal must send Option as Meta:

- Ghostty: `macos-option-as-alt = left`
- Zed: `"terminal": { "option_as_meta": true }`
- VS Code: `"terminal.integrated.macOptionIsMeta": true`
- iTerm2: Profiles → Keys → Left Option key → Esc+

Run `/hotkeys` in pi to confirm the shortcuts are registered.

## Selection translation (macOS only)

Select text in pi's fullscreen TUI (`"tuiMode": "fullscreen"`) and right-click. A native floating card (AppKit `NSPanel` with a `WKWebView`) shows the source, the translation, and a copy button. It follows the system light/dark appearance. Escape, clicking outside, or switching apps closes it.

Platform limits:

- **macOS only.** pi has no API for HTML overlays, so the card is a small native helper. On Linux and Windows, right-click does nothing.
- **Needs Xcode Command Line Tools** (`xcode-select --install`). The helper is compiled with `swiftc` on the first right-click, which takes about 30 seconds once. It is cached in `~/.pi/agent/pi-bridge/panel/` and rebuilt only when its source changes.
- The selection is read through the clipboard (`pbpaste`) after pi copies it, so a right-click translation replaces the clipboard contents.
- Requires pi's fullscreen selection and a terminal that forwards right-click. It does not work over SSH or in terminals that keep right-click for their own menu.
- No Accessibility or Screen Recording permission is needed.

## Behavior

- Translation starts disabled. When enabled, only the last assistant reply is translated. User messages, thinking blocks, and tool output are not.
- While a translation runs, the editor's top border shows a spinner. The footer shows `⇄ <target>` while translation is on.
- Streaming translation waits for complete top-level blocks. Blocks over 4000 characters are skipped.
- Code blocks, tables, raw HTML, and display math are not translated. Inline code, math, links, and HTML tags are protected with placeholders.
- If a translation fails, the original stays and a warning is shown. Toggle `Alt+A` off and on to retry.
- Interactive TUI only. RPC, JSON, and print modes are untouched.

## Data and privacy

Settings and the translation cache live in `~/.pi/agent/pi-bridge/`:

- `settings.json`: `target` (default `zh-Hans`), `source` (default `auto`), `streaming`
- `cache/<session-id>.json`: up to 3000 entries per session

Text being translated is sent to Microsoft through the Bing web translator. It needs no API key, but has no stable contract.

## Development

```sh
npm install
npm run dev        # pi -e with this checkout, settings untouched
npm run typecheck
npm test
```

Tests inject a fake translation service and do not touch the network.

```text
src/
├── index.ts          # extension entry: shortcuts, events, Markdown transformer
├── editor.ts         # editor with the translation spinner in its border
├── latest-message.ts # limits translation to the last assistant reply
├── selection-*.ts    # right-click handling and terminal fallback card
├── native-panel.ts   # builds and talks to the macOS helper
└── core/             # Markdown segmentation, placeholders, translator, cache
macos/                # Swift helper and popup.html for the selection card
```
