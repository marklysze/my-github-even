import type { EvenAppBridge } from '@evenrealities/even_hub_sdk'

// Persistence is via bridge.setLocalStorage / getLocalStorage. Browser
// localStorage is unreliable inside the Flutter WebView host — see the
// device-features skill for the full rationale.
const TOKEN_KEY = 'gh.token'
const REFRESH_TOKEN_KEY = 'gh.refreshToken'
const EXPIRES_AT_KEY = 'gh.expiresAt'
// Explicit auth-mode marker. Don't infer mode from refresh-token presence:
// a GitHub OAuth app without "Token expiration" enabled returns no refresh
// token, which makes a real OAuth session look like a manual PAT.
const AUTH_MODE_KEY = 'gh.authMode'

type AuthMode = 'oauth' | 'pat' | ''

// Public OAuth client_id for the "My GitHub (Even G2)" GitHub OAuth app.
// Public means it's safe to ship in client code; Device Flow doesn't use
// a client secret. See https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow
const CLIENT_ID = 'Ov23liHSq5aGURZy5HFR'
const SCOPES = 'repo notifications'

// GitHub's /login/* endpoints don't return CORS headers, so browser-side
// fetches are blocked. Route through our tiny CF Worker proxy that adds
// CORS headers and forwards otherwise unchanged. Source: cloudflare-worker/.
const PROXY_BASE = 'https://my-prs-github-proxy.my-github-even.workers.dev'
const DEVICE_CODE_URL = `${PROXY_BASE}/login/device/code`
const TOKEN_URL = `${PROXY_BASE}/login/oauth/access_token`

// Refresh proactively when access token has less than this much time left.
// GitHub access tokens are 8h-lived, so 5 minutes is comfortable margin.
const REFRESH_LEEWAY_MS = 5 * 60 * 1000

export interface ValidatedIdentity {
  ok: true
  login: string
  name: string | null
}

export interface ValidationFailure {
  ok: false
  error: string
}

export type ValidationResult = ValidatedIdentity | ValidationFailure

export interface DeviceCode {
  deviceCode: string
  userCode: string
  verificationUri: string
  expiresInSec: number
  intervalSec: number
}

export type PollResult =
  | { status: 'pending' }
  | { status: 'slow_down'; suggestedIntervalSec: number }
  | { status: 'denied'; error: string }
  | { status: 'expired'; error: string }
  | { status: 'success' }
  | { status: 'error'; error: string }

let _bridge: EvenAppBridge | null = null
let _token = ''
let _refreshToken = ''
let _expiresAt = 0  // ms epoch; 0 = no expiry tracked (PAT)
let _authMode: AuthMode = ''

export function setAuthBridge(bridge: EvenAppBridge): void {
  _bridge = bridge
}

// getLocalStorage returns '' for missing keys (not null), so the empty
// string is the canonical "no token set" value throughout the app.
export async function loadToken(): Promise<string> {
  if (!_bridge) return ''
  const [tokenRaw, refreshRaw, expiresRaw, modeRaw] = await Promise.all([
    _bridge.getLocalStorage(TOKEN_KEY),
    _bridge.getLocalStorage(REFRESH_TOKEN_KEY),
    _bridge.getLocalStorage(EXPIRES_AT_KEY),
    _bridge.getLocalStorage(AUTH_MODE_KEY),
  ])
  _token = (tokenRaw ?? '').trim()
  _refreshToken = (refreshRaw ?? '').trim()
  const parsed = Date.parse((expiresRaw ?? '').trim())
  _expiresAt = Number.isFinite(parsed) ? parsed : 0
  const mode = (modeRaw ?? '').trim()
  // Migration: sessions saved before AUTH_MODE_KEY existed have no marker.
  // Fall back to the old heuristic (refresh-token presence) so existing
  // OAuth users with refresh tokens stay classified as 'oauth'. Users on
  // OAuth apps without token-expiration get downgraded to 'pat' until they
  // disconnect/reconnect, which then writes the explicit marker.
  if (mode === 'oauth' || mode === 'pat') {
    _authMode = mode
  } else if (_token.length === 0) {
    _authMode = ''
  } else {
    _authMode = _refreshToken.length > 0 ? 'oauth' : 'pat'
  }
  return _token
}

export function getToken(): string {
  return _token
}

export function hasToken(): boolean {
  return _token.length > 0
}

// Settings UI uses this to render the 'oauth' vs 'pat' connected-state
// card. Reads the explicit marker; do not infer from refresh-token presence
// (OAuth apps without "Token expiration" return no refresh token).
export function isOAuthSession(): boolean {
  return _authMode === 'oauth'
}

export async function saveToken(token: string): Promise<boolean> {
  if (!_bridge) return false
  const trimmed = token.trim()
  const nextMode: AuthMode = trimmed ? 'pat' : ''
  // Saving a manual PAT clears any leftover OAuth refresh data — they're
  // mutually exclusive auth modes. Disconnect (empty token) clears the mode.
  const [a, b, c, d] = await Promise.all([
    _bridge.setLocalStorage(TOKEN_KEY, trimmed),
    _bridge.setLocalStorage(REFRESH_TOKEN_KEY, ''),
    _bridge.setLocalStorage(EXPIRES_AT_KEY, ''),
    _bridge.setLocalStorage(AUTH_MODE_KEY, nextMode),
  ])
  if (a && b && c && d) {
    _token = trimmed
    _refreshToken = ''
    _expiresAt = 0
    _authMode = nextMode
    return true
  }
  return false
}

export async function clearToken(): Promise<boolean> {
  return saveToken('')
}

export function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  }
  if (_token) headers.Authorization = `Bearer ${_token}`
  return headers
}

export async function validateToken(token: string): Promise<ValidationResult> {
  const trimmed = token.trim()
  if (!trimmed) return { ok: false, error: 'Token is empty.' }
  try {
    const res = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${trimmed}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => res.statusText)
      const snippet = detail.slice(0, 120)
      if (res.status === 401) return { ok: false, error: 'Token rejected (401). Check scopes / expiry.' }
      if (res.status === 403) return { ok: false, error: `Forbidden (403). ${snippet}` }
      return { ok: false, error: `GitHub ${res.status}: ${snippet}` }
    }
    const body = (await res.json()) as { login?: string; name?: string | null }
    if (!body.login) return { ok: false, error: 'GitHub did not return a login.' }
    return { ok: true, login: body.login, name: body.name ?? null }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

// ─────────────────────────── Device Flow ───────────────────────────

export async function startDeviceFlow(): Promise<DeviceCode> {
  const res = await fetch(DEVICE_CODE_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ client_id: CLIENT_ID, scope: SCOPES }),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => res.statusText)
    throw new Error(`Device code request failed: ${res.status} ${detail.slice(0, 120)}`)
  }
  const body = (await res.json()) as {
    device_code?: string
    user_code?: string
    verification_uri?: string
    expires_in?: number
    interval?: number
  }
  if (!body.device_code || !body.user_code || !body.verification_uri) {
    throw new Error('Malformed device-code response from GitHub.')
  }
  return {
    deviceCode: body.device_code,
    userCode: body.user_code,
    verificationUri: body.verification_uri,
    expiresInSec: body.expires_in ?? 900,
    intervalSec: body.interval ?? 5,
  }
}

// Single-shot poll — settings.ts is responsible for the timer loop, so it
// can also handle slow_down by extending the next interval and surface a
// status line to the user between polls.
export async function pollDeviceFlow(deviceCode: string): Promise<PollResult> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      device_code: deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    }),
  })
  // GitHub returns HTTP 200 with an `error` field for the OAuth pending /
  // slow_down / expired / denied states. Only treat non-2xx as transport
  // failure.
  const body = (await res.json().catch(() => ({}))) as {
    access_token?: string
    refresh_token?: string
    expires_in?: number
    refresh_token_expires_in?: number
    error?: string
    error_description?: string
    interval?: number
  }
  if (!res.ok && !body.error) {
    return { status: 'error', error: `Token poll failed: ${res.status}` }
  }
  if (body.access_token) {
    await persistOAuthTokens(body.access_token, body.refresh_token ?? '', body.expires_in ?? 0)
    return { status: 'success' }
  }
  switch (body.error) {
    case 'authorization_pending':
      return { status: 'pending' }
    case 'slow_down':
      return { status: 'slow_down', suggestedIntervalSec: body.interval ?? 5 }
    case 'expired_token':
      return { status: 'expired', error: body.error_description ?? 'Authorization request expired.' }
    case 'access_denied':
      return { status: 'denied', error: body.error_description ?? 'Authorization denied.' }
    default:
      return {
        status: 'error',
        error: body.error_description ?? body.error ?? 'Unknown error.',
      }
  }
}

async function persistOAuthTokens(
  accessToken: string,
  refreshToken: string,
  expiresInSec: number,
): Promise<void> {
  if (!_bridge) return
  const expiresAtMs = expiresInSec > 0 ? Date.now() + expiresInSec * 1000 : 0
  const expiresAtIso = expiresAtMs ? new Date(expiresAtMs).toISOString() : ''
  await Promise.all([
    _bridge.setLocalStorage(TOKEN_KEY, accessToken),
    _bridge.setLocalStorage(REFRESH_TOKEN_KEY, refreshToken),
    _bridge.setLocalStorage(EXPIRES_AT_KEY, expiresAtIso),
    _bridge.setLocalStorage(AUTH_MODE_KEY, 'oauth'),
  ])
  _token = accessToken
  _refreshToken = refreshToken
  _expiresAt = expiresAtMs
  _authMode = 'oauth'
}

// Refresh proactively if the access token is near or past expiry. Returns
// false if there's no refresh token available (e.g. we're using a PAT).
export async function ensureFreshToken(): Promise<boolean> {
  if (!_token) return false
  // PATs have no expiry tracked — assume valid until proven otherwise (401).
  if (!_refreshToken || _expiresAt === 0) return true
  if (Date.now() < _expiresAt - REFRESH_LEEWAY_MS) return true
  return refreshOAuthToken()
}

// Refresh unconditionally. Used by github.ts after a 401 to retry once
// before giving up.
export async function refreshOAuthToken(): Promise<boolean> {
  if (!_refreshToken) return false
  try {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        grant_type: 'refresh_token',
        refresh_token: _refreshToken,
      }),
    })
    const body = (await res.json().catch(() => ({}))) as {
      access_token?: string
      refresh_token?: string
      expires_in?: number
      error?: string
    }
    if (!body.access_token) {
      console.warn('[my-github] refresh failed:', body.error ?? `status ${res.status}`)
      return false
    }
    await persistOAuthTokens(
      body.access_token,
      body.refresh_token ?? _refreshToken,
      body.expires_in ?? 0,
    )
    return true
  } catch (err) {
    console.warn('[my-github] refresh threw:', err)
    return false
  }
}
