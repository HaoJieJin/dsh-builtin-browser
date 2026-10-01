# DSH Built-in Browser

> An AI-controlled browser for the **DeepSeek Harness (DSH)** mobile agent platform.
> It runs inside DSH's virtual display (background, never occupies the user's main screen) and is fully controlled by AI over the Chrome DevTools Protocol (CDP).
> Implemented: 2026-10-01.

**🌐 [English](README.md) | [简体中文](README.zh-CN.md)**

## Architecture

```
AI assistant
  └─ bash calls browser.sh (self-healing bridge)
       └─ browser.js (Node + ws, CDP protocol)
            └─ cdp-bridge.js (adb protocol bridge: tcp:9222 ↔ localabstract:chrome_devtools_remote)
                 └─ Chrome (runs on DSH virtual display, does not occupy the main screen)
```

- Browser engine: **Chrome** on the device (`com.android.chrome`)
- Background running: DSH virtual display (`android_vscreen_create` + `android_vscreen_launch`)
- Control channel: **CDP** (Chrome DevTools Protocol) — DOM-level precise control

## Quick Start

1. Create a virtual display and launch Chrome (AI actions):
   - `android_vscreen_create` (portrait)
   - `android_vscreen_launch com.android.chrome`
2. Start the bridge (AI action):
   - `sh browser-control/start-bridge.sh`
3. Verify:
   - `curl http://127.0.0.1:9222/json/version` should return Chrome version info

## Command Reference

Entry point: `sh browser-control/browser.sh <command> [args] [--tab <id>]`

| Command | Description | Example |
|---|---|---|
| `list` | List all tabs | `sh browser.sh list` |
| `open <url>` | Open URL in a new tab | `sh browser.sh open 'https://example.com'` |
| `navigate <url> [--tab id]` | Navigate the specified/current tab | `sh browser.sh navigate 'https://...' --tab 14` |
| `click <selector> [--tab id]` | Click an element with a real mouse event | `sh browser.sh click '#su' --tab 14` |
| `type <selector> <text> [--tab id]` | Focus an input and type text | `sh browser.sh type '#index-kw' '关键词' --tab 14` |
| `screenshot [path] [--tab id]` | Save a screenshot as PNG | `sh browser.sh screenshot /sdcard/xxx.png --tab 14` |
| `text [--tab id]` | Read page title and visible text | `sh browser.sh text --tab 14` |
| `eval <js> [--tab id]` | Execute arbitrary JS | `sh browser.sh eval 'return document.title;'` |
| `back / forward / reload [--tab id]` | Go back / forward / reload | `sh browser.sh back --tab 14` |
| `new_tab <url>` | Open a new tab | `sh browser.sh new_tab 'https://...'` |
| `close_tab <id>` | Close a tab | `sh browser.sh close_tab 14` |

All output is JSON (`{"ok":true,...}` or `{"ok":false,"error":"..."}`).

## Self-Healing

`browser.sh` checks bridge health (`/json/version`) before every call and automatically restarts `cdp-bridge.js` if unhealthy.
If Chrome is force-stopped or reclaimed by the system, re-run `android_vscreen_launch com.android.chrome` and then `start-bridge.sh`.

## Key Files

```
browser-control/
├── cdp-bridge.js     # adb protocol bridge (tcp:9222 ↔ Chrome abstract socket) 【core】
├── browser.js      # CDP control layer (direct ws connection, no third-party CDP lib)
├── browser.sh     # control entry (with self-healing)
├── start-bridge.sh  # bridge startup script
├── adb-forward.js    # experimental: direct adbd host:forward (superseded by cdp-bridge, kept for reference)
└── package.json    # deps: chrome-remote-interface
```

Note: `browser.js` uses the `chrome-remote-interface` npm package. Run `npm install` inside `browser-control/` first (or use the bundled copy from DSH).

## Verified Features (2026-10-01)

- ✅ Open web pages (example.com / baidu.com)
- ✅ Type text into inputs (Baidu search box)
- ✅ Submit forms / click (Baidu search)
- ✅ Forward / back (Baidu results ↔ homepage)
- ✅ Screenshots (CDP screenshot saved as PNG, rendering OK)
- ✅ Read page text / DOM
- ✅ Multiple tabs (list / new_tab / close_tab)
- ✅ Background running (virtual display, does not occupy the main screen)

## Notes

- Chrome's devtools server is sensitive to abnormal connections: **avoid concurrent/frequent connections**, keep 1-2 s between commands.
- If Chrome hangs (`/json` unresponsive): `am force-stop com.android.chrome` → `android_vscreen_launch com.android.chrome` → `start-bridge.sh`.
- Chrome restores the user's previous browsing session (tabs); do not close the user's existing tabs.

## License

MIT © 2026 HaoJieJin