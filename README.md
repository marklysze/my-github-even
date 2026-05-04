# My GitHub — GitHub on Even G2

A GitHub PR / Notifications viewer for Even Realities G2 smart glasses. Authored and review-requested pull requests, unread notifications with PR-status glyphs, and per-PR comment threads — all on the 576×288 greyscale display, controlled with single-tap (next) / double-tap (exit/back) / slide for scrolling.

The phone-side companion screen carries Settings: connect via GitHub OAuth Device Flow, or paste a Personal Access Token.

## What it does

**My GitHub is read-only.** It views your GitHub data on the glasses; it never writes anything back to GitHub.

Browse:

- **My PRs** — pull requests you've authored (open + draft), with comment counts and live status (open / draft / merged / closed)
- **Review requests** — pull requests where you've been asked to review
- **Notifications** — your unread notification inbox, prefixed with PR-status glyphs and a short reason indicator (`AU` author, `MN` mention, …)
- **Comment threads** — drill into any PR to read the full conversation: issue comments, review summaries, and inline line comments, in chronological order
- **Comment / body detail** — paginated text view of a single comment or a PR/issue description

It does **not**:

- Post comments, replies, or reactions
- Approve, request changes, dismiss reviews, merge, close, or reopen PRs
- Mark notifications as read
- Modify any repository, issue, or user setting

The OAuth token (or your PAT) is the only thing the app stores, and it stays on-device in the host's secure storage. No telemetry, no external services other than GitHub itself and the CORS proxy described below.

## Screenshots

| | |
|---|---|
| ![Home menu](screenshots/home.png) | ![Notifications](screenshots/notifications.png) |
| Home menu | Notifications with status glyphs |
| ![My PRs](screenshots/my-prs.png) | ![Review requests](screenshots/review-requests.png) |
| Authored PRs | Review-requested PRs |
| ![Comment list](screenshots/comment-list.png) | |
| Comment thread for a PR | |

## Quick start

```bash
npm install
npm run dev                                     # Vite dev server on :5173, host-bound
npm run simulate                                # in another shell — launches the desktop simulator
npx evenhub qr --url http://<your-ip>:5173      # for testing on real glasses
npm run pack                                    # build .ehpk for the dev portal
```

`npm run build` runs the logo pipeline (`scripts/build-logo.mjs`), then `tsc --noEmit`, then `vite build`. There is no test suite or linter wired up — `tsc` is the only automated check.

## Auth

Two mutually exclusive modes, picked from the Settings card on the phone:

- **OAuth Device Flow** — recommended. Browser-based, no token paste, auto-refreshes every 8h. Tokens persist in the host's `setLocalStorage` (browser `localStorage` is unreliable inside the Flutter WebView). The plugin runs against a public OAuth app (`Ov23liHSq5aGURZy5HFR`), so no client secret ships in the bundle.
- **Personal access token** — paste a `repo` + `notifications`-scoped classic PAT (or a fine-grained PAT with Pull requests: Read + Notifications: Read). No refresh, no expiry tracking — it stays valid until you rotate it.

You cannot use both at once. To switch from one to the other, **Disconnect** first.

### Why the Cloudflare Worker

GitHub's `/login/device/code` and `/login/oauth/access_token` endpoints return zero CORS headers, so a browser-side Device Flow request is blocked at preflight. `cloudflare-worker/worker.js` is a ~30-line CORS shim that forwards exactly those two paths and adds `Access-Control-Allow-Origin: *`. Deployed at `https://my-prs-github-proxy.my-github-even.workers.dev`. No secrets, no logging, no storage; the OAuth app is registered as a public client so Device Flow works without a `client_secret`.

To redeploy after edits:

```bash
cd cloudflare-worker
wrangler deploy
```

If you fork this app, you'll need your own GitHub OAuth app (`Settings → Developer settings → OAuth Apps`, "Enable Device Flow" checked), put its `CLIENT_ID` into `src/auth.ts`, and either reuse the existing Worker URL or stand up your own. Either way, the Worker URL must appear in `app.json`'s `permissions[].whitelist`.

## File layout

```
src/
  main.ts          view stack + glasses rendering (entry point)
  auth.ts          token storage, validation, Device Flow, refresh
  github.ts        REST calls + list-item formatting
  settings.ts      phone-side Settings card (mounts into companion)
  paginate.ts      pretext wrapper for comment-detail bodies
scripts/
  build-logo.mjs   sharp pipeline: invertocat → 50×50 RGB no-alpha (firmware ignores PNG alpha)
cloudflare-worker/
  worker.js        CORS shim for github.com/login/*
  wrangler.toml
public/
  github-invertocat.png   built artifact, top-right header logo
assets/
  github-invertocat-black.png   source for the build pipeline
app.json           Even Hub manifest
```

## Hardware features used

- Display only — text and image containers (576×288, 4-bit greyscale, 16 shades of green)
- Touchpad gestures — single-tap, double-tap, scroll-up, scroll-down, swipe
- `setLocalStorage` / `getLocalStorage` for token persistence
- No mic, no IMU

## Display layout

Every screen has a 1px border (`SHOW_FRAME` in `main.ts`) and a 50×50 GitHub Invertocat in the top-right corner on the home / PR-list / notif-list views. Titles sit at `TITLE_X = 12` (12px from the left frame). List bodies use the SDK's native list container, capped at 20 items × 60 UTF-8 bytes per item (firmware enforces bytes, not characters).

## Permissions

`app.json` declares one `network` permission with two whitelist entries:

- `https://api.github.com` — REST API
- `https://my-prs-github-proxy.my-github-even.workers.dev` — OAuth Device Flow CORS shim

`evenhub pack` rejects an empty whitelist, so don't ship a `network` entry without entries.

## Known limits / not yet built

- Issue-status enrichment (PR-status glyphs work; Issues just show the reason indicator)
- Notification mark-as-read
- Background refresh while the plugin is suspended
- Multi-account
