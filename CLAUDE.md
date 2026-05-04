# CLAUDE.md — My GitHub (GitHub on Even G2)

Working notes for Claude Code sessions on this plugin.

## Shape

Single Vite + TypeScript Even Hub plugin. Five source files in `src/`:

| File | Role |
|---|---|
| `main.ts` | Entry point. View stack, navigation, glasses rendering, foreground/background lifecycle. ~1000 lines. |
| `auth.ts` | Token persistence (host `setLocalStorage`), Device Flow start/poll, refresh, validation. |
| `github.ts` | REST calls (`/search/issues`, `/notifications`, `/repos/.../comments`), list-item formatting, status-glyph map. |
| `settings.ts` | Phone-side Settings card. Mutually exclusive OAuth / PAT state machine. |
| `paginate.ts` | Thin wrapper around `@evenrealities/pretext` for comment-detail body pagination. |

No test suite. `tsc --noEmit` (run by `npm run build`) is the only automated check. Always run it after edits to `.ts` files.

## Auth state machine (settings.ts)

Three states — **mutually exclusive**, enforced in the UI per user's explicit ask:

```
'none'   → both Connect-with-GitHub and PAT cards visible
'oauth'  → only OAuth-connected card (identity + Disconnect)
'pat'    → only PAT-connected card (identity + editable token + Update + Disconnect)
```

Single source of visibility truth: `applyState(refs, state)`. To switch modes, the user must Disconnect first — there's no "overwrite" path. `hydrate` validates the saved token on mount; if the API returns 401 (revoked / scope-stripped), it auto-clears storage and falls back to `'none'`. In-flight Device Flow polling is auto-cancelled by `applyState` when state changes mid-flow.

OAuth and PAT tokens use the **same three storage keys** (`gh.token`, `gh.refreshToken`, `gh.expiresAt`). PATs leave the latter two empty — that's how `isOAuthSession()` distinguishes them. `saveToken('')` clears all three. Don't introduce a separate "PAT vs OAuth mode" flag; the presence of `gh.refreshToken` IS the flag.

## Cloudflare Worker is load-bearing

`cloudflare-worker/worker.js` is the only way OAuth Device Flow works from a WebView. GitHub's `/login/*` endpoints return zero CORS headers — verified by curling `OPTIONS https://github.com/login/device/code -H "Origin: https://example.com"`, no `access-control-allow-origin` comes back. The Worker forwards exactly two paths with CORS headers added.

If the Worker URL changes, **three places** need updating in lockstep:

1. `app.json` → `permissions[0].whitelist`
2. `src/auth.ts` → `PROXY_BASE` constant
3. `cloudflare-worker/wrangler.toml` → `name` (deploy-time identity)

## View stack (main.ts)

```
no-token  →  Settings nag screen
loading   →  spinner-equivalent on first paint
error     →  bridge / network failure
home      →  three-row menu: My PRs / Reviews / Notifications
pr-list   →  authored OR review-requested (mode flag)
notif-list →  unread notifications, glyph-prefixed
notif-detail → opens the PR/Issue body
comment-list → flat list of issue + review + line comments
comment-detail → paginated body via pretext
```

`CameFrom = 'authored' | 'review' | 'notif'` tracks back-navigation across `comment-list` so double-tap returns to the right list. Don't add a generic history stack — three sources is small enough to enumerate.

`boot()` re-fires on `FOREGROUND_ENTER_EVENT` for home/pr-list/notif-list views (data refresh on resume). Don't re-fire it for detail views — the cached data is fine and re-fetching causes flicker. There's a suspected stacking bug here ("freezes after about a minute") that hasn't been root-caused; if you're touching this code, instrument the boot path with timestamps before refactoring.

## Things that bit us — do not redo

### Image alpha is silently merged as solid white

The G2 firmware's gray4 conversion ignores PNG alpha. Transparent regions render as **bright white pixels**. The `scripts/build-logo.mjs` pipeline is non-obvious because of this:

```js
sharp(SRC)
  .resize(50, 50, { fit: 'fill' })            // NOT 'contain' — see below
  .flatten({ background: { r: 255, g: 255, b: 255 } })
  .negate({ alpha: false })
  .removeAlpha()
  .png()
```

`fit: 'contain'` adds fully-transparent padding rows that `flatten` silently skips (sharp bug / quirk), producing a single bright-white line at the bottom of the image on the glasses. `fit: 'fill'` avoids the padding entirely.

If you change the source asset (`assets/github-invertocat-black.png`), re-run `npm run build-logo` and verify on **real glasses**, not just the simulator — the simulator alpha-composites correctly and won't reveal the bug.

### List items are byte-capped, not char-capped

`ListContainerProperty` items have a 60-byte UTF-8 budget (`LIST_ITEM_MAX_BYTES` in `github.ts`). The official docs say "64 chars" — that's wrong, the firmware counts bytes. Multibyte glyphs eat the budget fast:

| Glyph | Bytes |
|---|---|
| `·` | 2 |
| `…` | 3 |
| `←` | 3 |
| Most CJK | 3 |
| Emoji | 4 |

A 64-char string with two `·` and one `…` is 68 bytes → `rebuildPageContainer` returns `false` silently and the page never updates. Always go through `clipItem()` before building list items; never concat user content directly into `itemName`.

### Status / reason glyphs were chosen for firmware-font reliability

Tested live on real glasses — these are the ones that actually render:

```ts
// github.ts
const STATUS_LABELS: Record<PRStatus, string> = {
  open: '●', draft: '○', merged: '★', closed: '×',
}
const REASON_ICONS: Record<string, string> = {
  author: 'AU', mention: 'MN',
}
```

`◐ ✓ ✗ ☆` were tried first and rendered as blanks. If you want to add new glyphs, test on real hardware before shipping. ASCII letter-pairs (`AU`, `MN`) are the safe fallback for indicators where Unicode isn't reliable.

### TDZ on module-level `let` referenced through top-level `void asyncFn()`

`main.ts` calls `void boot()` at module top level. The function body executes synchronously up to its first `await`, and any module-scope `let` that synchronous portion touches must be declared **above** the `void` call. Currently `let rendering: Promise<unknown>` is declared at line 128, before `void boot()` lower in the file — keep it that way. Moving it below caused a TDZ error that left the placeholder on screen forever.

If you reorder declarations, watch for `Cannot access '<var>' before initialization` in the simulator console.

### Always log bridge call results

`rebuildPageContainer`, `textContainerUpgrade`, and `updateImageRawData` return failure as `false` (or a status string) — **no exception, no rejection**. The standard wrapper logs both payload and result; preserve it. Without it, the byte-cap bug above is invisible.

### Click events with eventType=0 arrive as undefined

Protobuf zero-value omission: `OsEventTypeList.CLICK_EVENT` is `0`, the SDK normalizes `0 → undefined`. main.ts uses a defensive coalesce — search for `eventTypeOf(`. List clicks on item index 0 *also* arrive with `currentSelectItemIndex` stripped; coalesce both:

```ts
const eventType = env?.eventType ?? OsEventTypeList.CLICK_EVENT
const idx = event.listEvent.currentSelectItemIndex ?? 0
```

If you see "single-tap doesn't work" or "first list item is unresponsive", this is why.

### Double-tap exit is a root-level check

Double-tap from `sysEvent` OR `textEvent` envelopes calls `bridge.shutDownPageContainer(1)` before any other branch. Non-negotiable UX — users must always be able to exit. Don't put it inside a view-state switch.

## Frame container

`SHOW_FRAME = true` in main.ts adds a full-canvas border container (`FRAME_ID = 99`) at the start of every page's `textObject` array. It's a `TextContainerProperty` with `content: ' '`, `borderWidth: 1`, `borderRadius: 6`, sized to the full 576×288. Counts toward the 8-text-container cap, so don't blow past 7 actual containers per page.

`isEventCapture` lives on the *content* container, not the frame. The frame is purely decorative.

## Dev loop

Use the simulator for iteration; only re-test on glasses for rendering quirks (alpha, font glyphs).

```bash
npm run dev                                                          # leave running
npx @evenrealities/evenhub-simulator http://localhost:5173 \
  --automation-port 9898                                             # leave running
```

Then poll the headless API for fast checks:

- `GET http://localhost:9898/api/console?since_id=N`
- `GET http://localhost:9898/api/screenshot/glasses` (RGBA PNG; check `pixel.alpha > 0` for "lit", not RGB)
- `POST http://localhost:9898/api/input { "action": "click" | "double_click" | "up" | "down" }`

Vite HMR doesn't reliably reload the simulator's WebView. After a code change, kill the binary and restart:

```bash
pkill -f evenhub-simulator        # kills the actual binary, not just the npm wrapper
lsof -i :9898                     # confirm the port is free
```

`kill <wrapper-pid>` orphans the simulator binary at `node_modules/@evenrealities/sim-<platform>/bin/evenhub-simulator` and the next start panics with `AddrInUse`.

## Don't do

- Don't add a third "auth mode" alongside OAuth/PAT. The user's explicit constraint is mutual exclusion.
- Don't store the token in `window.localStorage` or IndexedDB — the Flutter WebView wipes them on app close. Use `bridge.setLocalStorage` / `getLocalStorage`.
- Don't ship `client_secret` in the bundle. The OAuth app is registered as a public client; Device Flow doesn't need one.
- Don't add background-state SDK calls (`setBackgroundState` / `onBackgroundRestore`) — SDK 0.0.10 doesn't export them. They're documented in skills but don't exist in the published version yet.
- Don't refactor the view stack into a router library. It's small enough that the discriminated union pays for itself.
