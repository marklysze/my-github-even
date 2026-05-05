# Privacy Policy — My GitHub

_Last updated: 2026-05-05_

My GitHub is a read-only viewer for your GitHub pull requests, review requests, and notifications, designed for Even Realities G2 smart glasses. This policy describes what data the app handles and where it goes.

## Summary

- The app is **read-only**. It never writes to GitHub or modifies any account, repository, or notification state.
- The only data stored is your GitHub authentication token, kept on your device.
- No data is sent to any server other than GitHub itself and a thin OAuth CORS proxy operated by the developer (described below).
- No analytics, no telemetry, no third-party tracking.

## Data the app handles

**GitHub authentication token** — Required to call the GitHub API on your behalf. You provide it in one of two ways:

1. **OAuth Device Flow** (recommended) — you authorize the app on `github.com`. GitHub issues an access token (and a refresh token) which the app stores on your device.
2. **Personal Access Token (PAT)** — you paste a classic or fine-grained PAT into Settings; the app stores it on your device.

In both cases, the token is stored via the Even Realities host's `setLocalStorage` API. It never leaves your device except in `Authorization` headers sent to GitHub.

**GitHub data fetched at runtime** — When you open the app it fetches:

- Your authored open pull requests (`/search/issues?q=is:pr+author:@me+state:open`)
- Pull requests where you have been requested as a reviewer (`/search/issues?q=is:pr+review-requested:@me+state:open`)
- Your unread notifications (`/notifications`)
- Per-PR comments and review threads when you open a PR (`/repos/{owner}/{repo}/issues/{n}/comments`, `/repos/{owner}/{repo}/pulls/{n}/comments`, `/repos/{owner}/{repo}/pulls/{n}/reviews`)
- PR status (open / draft / merged / closed) for notifications, when you view the notification list

This data is held in memory only for as long as the app is running. Nothing is persisted beyond the token.

## Where data goes

Network requests are sent to exactly two destinations:

| Domain | Purpose |
|---|---|
| `https://api.github.com` | GitHub REST API — all read-only data fetches above. |
| `https://my-prs-github-proxy.my-github-even.workers.dev` | A Cloudflare Worker operated by the developer that exists solely to add CORS headers to GitHub's `/login/device/code` and `/login/oauth/access_token` endpoints during OAuth Device Flow sign-in. It forwards request bodies to `github.com` unchanged. It does not log, store, or process request contents. Source: [`cloudflare-worker/worker.js`](./cloudflare-worker/worker.js). |

Both domains are declared in the app's `permissions[].whitelist` in `app.json`.

## What the app does not do

- Does **not** post comments, replies, or reactions
- Does **not** approve, request changes, dismiss reviews, merge, close, or reopen pull requests
- Does **not** mark notifications as read
- Does **not** modify any repository, issue, user, or organization setting
- Does **not** collect analytics or telemetry of any kind
- Does **not** share, sell, or transmit your data to any third party
- Does **not** access the device microphone, camera, location, IMU, or photo album

## Token scope and revocation

If you sign in with OAuth Device Flow, the app requests the `repo` and `notifications` scopes — the minimum needed to read PRs, reviews, and notifications across both public and private repositories you have access to.

You can revoke the app's access at any time:

- **OAuth:** GitHub Settings → Applications → Authorized OAuth Apps → "My GitHub (Even G2)" → Revoke
- **PAT:** GitHub Settings → Developer settings → Personal access tokens → Delete the token

Disconnecting from inside the app's Settings card also clears the token from device storage.

## Data retention

The app stores only the authentication token on your device. Removing the app, disconnecting from Settings, or revoking the token on GitHub clears it. No data is retained on any server operated by the developer.

## Contact

For questions about this policy, open an issue on the project's GitHub repository: https://github.com/marklysze/my-github-even
