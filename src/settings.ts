import {
  loadToken,
  getToken,
  hasToken,
  isOAuthSession,
  saveToken,
  validateToken,
  startDeviceFlow,
  pollDeviceFlow,
  type DeviceCode,
  type ValidatedIdentity,
} from './auth'

// Custom event dispatched on `window` whenever the token is saved (or
// cleared). main.ts listens for this so it can re-boot — verify the new
// token, refetch lists, redraw the glasses.
export const TOKEN_CHANGED_EVENT = 'myprs:tokenchanged'

export interface MountSettingsOptions {
  // Optional callback invoked after a successful save, in addition to the
  // window-level event. Useful when the host wants direct coupling.
  onTokenChanged?: () => void
}

// Three mutually exclusive states the panel can be in. OAuth and PAT are
// kept strictly separate per the UX rule: you must Disconnect one before
// you can use the other. `identity` is the validated `/user` payload.
type AuthState =
  | { kind: 'none' }
  | { kind: 'oauth'; identity: ValidatedIdentity | null }
  | { kind: 'pat'; identity: ValidatedIdentity | null }

interface Refs {
  statusPill: HTMLElement
  // 'none' state — visible together
  oauthActions: HTMLDivElement
  patActions: HTMLDivElement
  // 'oauth' state — only this is visible
  oauthConnected: HTMLDivElement
  // 'pat' state — only this is visible
  patConnected: HTMLDivElement

  // OAuth actions
  connectBtn: HTMLButtonElement
  deviceFlowPanel: HTMLDivElement
  deviceFlowCode: HTMLDivElement
  deviceFlowOpenBtn: HTMLAnchorElement
  deviceFlowCopyBtn: HTMLButtonElement
  deviceFlowCancelBtn: HTMLButtonElement
  deviceFlowMessage: HTMLDivElement

  // OAuth connected
  oauthConnectedIdentity: HTMLDivElement
  oauthDisconnectBtn: HTMLButtonElement

  // PAT actions
  patInput: HTMLInputElement
  patToggleBtn: HTMLButtonElement
  patSaveBtn: HTMLButtonElement
  patTestBtn: HTMLButtonElement

  // PAT connected
  patConnectedIdentity: HTMLDivElement
  patConnectedInput: HTMLInputElement
  patConnectedToggleBtn: HTMLButtonElement
  patUpdateBtn: HTMLButtonElement
  patDisconnectBtn: HTMLButtonElement
}

interface DeviceFlowSession {
  code: DeviceCode
  pollTimer: number
  expiryTimer: number
  intervalSec: number
}

let activeSession: DeviceFlowSession | null = null

export function mountSettings(host: HTMLElement, opts: MountSettingsOptions = {}): void {
  host.innerHTML = render()
  const refs = collectRefs(host)
  wire(refs, opts)
  void hydrate(refs, opts)
}

function render(): string {
  return `
    <div style="background:#2E2E2E;border:1px solid #3E3E3E;border-radius:12px;padding:20px;color:#E5E5E5;font-family:-apple-system,BlinkMacSystemFont,system-ui,sans-serif;">
      <header style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
        <h2 style="font-size:16px;font-weight:600;margin:0;">Settings</h2>
        <span id="myprs-status" style="font-size:12px;color:#919191;"></span>
      </header>

      <!-- ─── 'oauth' state — connected via OAuth ─── -->
      <div id="myprs-oauth-connected" style="display:none;background:#1A1A1A;border:1px solid #3E3E3E;border-radius:8px;padding:14px;">
        <h3 style="font-size:14px;font-weight:600;margin:0 0 6px;">Connected via GitHub OAuth</h3>
        <div id="myprs-oauth-identity" style="font-size:13px;color:#7EE787;margin-bottom:6px;">@…</div>
        <p style="margin:0 0 14px;color:#919191;font-size:12px;line-height:1.5;">
          Access token auto-refreshes every 8h. Refresh token is valid for ~6 months.
        </p>
        <button id="myprs-oauth-disconnect" type="button" style="${btnStyle('danger')}">Disconnect</button>
      </div>

      <!-- ─── 'pat' state — connected via PAT ─── -->
      <div id="myprs-pat-connected" style="display:none;background:#1A1A1A;border:1px solid #3E3E3E;border-radius:8px;padding:14px;">
        <h3 style="font-size:14px;font-weight:600;margin:0 0 6px;">Connected via personal access token</h3>
        <div id="myprs-pat-identity" style="font-size:13px;color:#7EE787;margin-bottom:12px;">@…</div>
        <label for="myprs-pat-connected-input" style="display:block;font-size:13px;color:#B0B0B0;margin-bottom:6px;">Token</label>
        <div style="display:flex;gap:8px;margin-bottom:12px;">
          <input
            id="myprs-pat-connected-input"
            type="password"
            autocomplete="off"
            spellcheck="false"
            autocapitalize="off"
            style="flex:1;min-width:0;height:36px;padding:0 12px;border:1px solid #4A4A4A;border-radius:8px;background:#0F0F0F;color:#E5E5E5;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:13px;outline:none;"
          />
          <button id="myprs-pat-connected-toggle" type="button" style="${btnStyle('ghost')}">Show</button>
        </div>
        <p style="margin:0 0 12px;color:#919191;font-size:12px;line-height:1.5;">
          Edit and Update if you've rotated the token. Disconnect removes it entirely.
        </p>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button id="myprs-pat-update" type="button" style="${btnStyle('primary')}">Update</button>
          <button id="myprs-pat-disconnect" type="button" style="${btnStyle('danger')}">Disconnect</button>
        </div>
      </div>

      <!-- ─── 'none' state — both options shown ─── -->

      <!-- OAuth pick-me -->
      <div id="myprs-oauth-actions" style="display:none;background:#1A1A1A;border:1px solid #3E3E3E;border-radius:8px;padding:14px;margin-bottom:14px;">
        <h3 style="font-size:14px;font-weight:600;margin:0 0 4px;">Connect with GitHub</h3>
        <p style="margin:0 0 12px;color:#919191;font-size:12px;line-height:1.5;">
          Browser-based OAuth via GitHub Device Flow. Token auto-refreshes; no manual paste.
        </p>
        <button id="myprs-connect" type="button" style="${btnStyle('primary')}">Connect</button>

        <div id="myprs-deviceflow" style="display:none;margin-top:14px;background:#0F0F0F;border:1px solid #3E3E3E;border-radius:8px;padding:14px;">
          <p style="margin:0 0 8px;font-size:13px;color:#B0B0B0;">
            1. Open <strong>github.com/login/device</strong> on any device
          </p>
          <a id="myprs-deviceflow-open" href="https://github.com/login/device" target="_blank" rel="noopener" style="${btnStyle('ghost')}display:inline-block;margin-bottom:14px;text-decoration:none;text-align:center;line-height:36px;box-sizing:border-box;">Open in browser</a>
          <p style="margin:0 0 6px;font-size:13px;color:#B0B0B0;">
            2. Enter this code:
          </p>
          <div id="myprs-deviceflow-code" style="font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:32px;font-weight:600;letter-spacing:0.1em;background:#1A1A1A;border:1px solid #4A4A4A;border-radius:8px;padding:14px;text-align:center;color:#FEF991;margin-bottom:8px;">----</div>
          <div style="display:flex;gap:8px;margin-bottom:12px;">
            <button id="myprs-deviceflow-copy" type="button" style="${btnStyle('ghost')}">Copy code</button>
            <button id="myprs-deviceflow-cancel" type="button" style="${btnStyle('danger')}flex:1">Cancel</button>
          </div>
          <div id="myprs-deviceflow-message" style="font-size:12px;color:#919191;text-align:center;">Waiting for authorization…</div>
        </div>
      </div>

      <!-- PAT pick-me -->
      <div id="myprs-pat-actions" style="display:none;background:#1A1A1A;border:1px solid #3E3E3E;border-radius:8px;padding:14px;">
        <h3 style="font-size:14px;font-weight:600;margin:0 0 4px;">Or use a personal access token</h3>
        <p style="margin:0 0 12px;color:#919191;font-size:12px;line-height:1.5;">
          Paste a token below. No browser round-trip; no auto-refresh.
        </p>
          <label for="myprs-token-input" style="display:block;font-size:13px;color:#B0B0B0;margin-bottom:6px;">GitHub personal access token</label>
          <div style="display:flex;gap:8px;margin-bottom:12px;">
            <input
              id="myprs-token-input"
              type="password"
              autocomplete="off"
              spellcheck="false"
              autocapitalize="off"
              placeholder="ghp_… or github_pat_…"
              style="flex:1;min-width:0;height:36px;padding:0 12px;border:1px solid #4A4A4A;border-radius:8px;background:#0F0F0F;color:#E5E5E5;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:13px;outline:none;"
            />
            <button id="myprs-token-toggle" type="button" style="${btnStyle('ghost')}">Show</button>
          </div>
          <div style="display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap;">
            <button id="myprs-token-save" type="button" style="${btnStyle('primary')}">Save</button>
            <button id="myprs-token-test" type="button" style="${btnStyle('ghost')}">Test</button>
          </div>
          <details style="background:#0F0F0F;border:1px solid #3E3E3E;border-radius:8px;padding:12px 14px;font-size:13px;color:#C0C0C0;">
            <summary style="cursor:pointer;font-weight:600;color:#E5E5E5;list-style:none;">
              Which token should I use? <span style="font-weight:400;color:#919191;">(classic vs fine-grained)</span>
            </summary>
            <div style="margin-top:12px;line-height:1.55;">
              <p style="margin:0 0 12px;">Both work. <strong>Classic</strong> is the path of least resistance — recommended unless your org enforces fine-grained tokens.</p>
              <h4 style="font-size:13px;font-weight:600;color:#FEF991;margin:0 0 4px;">Classic PAT</h4>
              <ol style="margin:0 0 12px;padding-left:18px;">
                <li>Open <a href="https://github.com/settings/tokens" target="_blank" rel="noopener" style="color:#9CD3FF;">github.com/settings/tokens</a></li>
                <li>Click <em>Generate new token (classic)</em></li>
                <li>Tick scopes: <code style="background:#1A1A1A;padding:0 4px;border-radius:3px;">repo</code> + <code style="background:#1A1A1A;padding:0 4px;border-radius:3px;">notifications</code></li>
                <li>Set an expiry, generate, copy, paste above</li>
              </ol>
              <h4 style="font-size:13px;font-weight:600;color:#FEF991;margin:0 0 4px;">Fine-grained PAT</h4>
              <ol style="margin:0;padding-left:18px;">
                <li>Open <a href="https://github.com/settings/personal-access-tokens" target="_blank" rel="noopener" style="color:#9CD3FF;">github.com/settings/personal-access-tokens</a></li>
                <li>Repository access: All or selected</li>
                <li>Permissions: <code style="background:#1A1A1A;padding:0 4px;border-radius:3px;">Pull requests: Read</code> + <code style="background:#1A1A1A;padding:0 4px;border-radius:3px;">Notifications: Read</code></li>
              </ol>
            </div>
          </details>
      </div>
    </div>
  `
}

function btnStyle(variant: 'primary' | 'ghost' | 'danger'): string {
  const base =
    'height:36px;padding:0 14px;border-radius:8px;font-size:13px;font-weight:500;cursor:pointer;font-family:inherit;'
  if (variant === 'primary') {
    return `${base}border:none;background:#FEF991;color:#1A1A1A;`
  }
  if (variant === 'danger') {
    return `${base}border:1px solid #5A2A2A;background:transparent;color:#FF8A8A;`
  }
  return `${base}border:1px solid #4A4A4A;background:transparent;color:#E5E5E5;`
}

function collectRefs(host: HTMLElement): Refs {
  return {
    statusPill: host.querySelector<HTMLElement>('#myprs-status')!,
    oauthActions: host.querySelector<HTMLDivElement>('#myprs-oauth-actions')!,
    patActions: host.querySelector<HTMLDivElement>('#myprs-pat-actions')!,
    oauthConnected: host.querySelector<HTMLDivElement>('#myprs-oauth-connected')!,
    patConnected: host.querySelector<HTMLDivElement>('#myprs-pat-connected')!,

    connectBtn: host.querySelector<HTMLButtonElement>('#myprs-connect')!,
    deviceFlowPanel: host.querySelector<HTMLDivElement>('#myprs-deviceflow')!,
    deviceFlowCode: host.querySelector<HTMLDivElement>('#myprs-deviceflow-code')!,
    deviceFlowOpenBtn: host.querySelector<HTMLAnchorElement>('#myprs-deviceflow-open')!,
    deviceFlowCopyBtn: host.querySelector<HTMLButtonElement>('#myprs-deviceflow-copy')!,
    deviceFlowCancelBtn: host.querySelector<HTMLButtonElement>('#myprs-deviceflow-cancel')!,
    deviceFlowMessage: host.querySelector<HTMLDivElement>('#myprs-deviceflow-message')!,

    oauthConnectedIdentity: host.querySelector<HTMLDivElement>('#myprs-oauth-identity')!,
    oauthDisconnectBtn: host.querySelector<HTMLButtonElement>('#myprs-oauth-disconnect')!,

    patInput: host.querySelector<HTMLInputElement>('#myprs-token-input')!,
    patToggleBtn: host.querySelector<HTMLButtonElement>('#myprs-token-toggle')!,
    patSaveBtn: host.querySelector<HTMLButtonElement>('#myprs-token-save')!,
    patTestBtn: host.querySelector<HTMLButtonElement>('#myprs-token-test')!,

    patConnectedIdentity: host.querySelector<HTMLDivElement>('#myprs-pat-identity')!,
    patConnectedInput: host.querySelector<HTMLInputElement>('#myprs-pat-connected-input')!,
    patConnectedToggleBtn: host.querySelector<HTMLButtonElement>('#myprs-pat-connected-toggle')!,
    patUpdateBtn: host.querySelector<HTMLButtonElement>('#myprs-pat-update')!,
    patDisconnectBtn: host.querySelector<HTMLButtonElement>('#myprs-pat-disconnect')!,
  }
}

async function hydrate(refs: Refs, opts: MountSettingsOptions): Promise<void> {
  await loadToken()
  if (!hasToken()) {
    applyState(refs, { kind: 'none' })
    return
  }
  const baseKind: 'oauth' | 'pat' = isOAuthSession() ? 'oauth' : 'pat'
  setStatus(refs, 'Validating saved token…', 'busy')
  const result = await validateToken(getToken())
  if (!result.ok) {
    // Saved token is bad (revoked, scopes wrong, network down). Wipe it
    // and revert to 'none' so the user gets a clean re-auth path.
    setStatus(refs, `Saved token rejected: ${result.error}`, 'error')
    await saveToken('')
    applyState(refs, { kind: 'none' })
    notifyTokenChanged(opts)
    return
  }
  applyState(refs, { kind: baseKind, identity: result })
}

function applyState(refs: Refs, state: AuthState): void {
  // Cancel any in-flight Device Flow when the panel state changes — covers
  // disconnect-while-polling and other edge cases.
  if (state.kind !== 'none' && activeSession) {
    stopSessionTimers(activeSession)
    activeSession = null
    refs.deviceFlowPanel.style.display = 'none'
    refs.connectBtn.disabled = false
    refs.connectBtn.textContent = 'Connect'
  }

  refs.oauthActions.style.display = state.kind === 'none' ? '' : 'none'
  refs.patActions.style.display = state.kind === 'none' ? '' : 'none'
  refs.oauthConnected.style.display = state.kind === 'oauth' ? '' : 'none'
  refs.patConnected.style.display = state.kind === 'pat' ? '' : 'none'

  switch (state.kind) {
    case 'none':
      setStatus(refs, 'Not connected', 'idle')
      // Reset the PAT input — leftover ghost values otherwise persist.
      refs.patInput.value = ''
      return
    case 'oauth': {
      const id = state.identity
      const login = id?.login ? `@${id.login}` : '@unknown'
      const name = id?.name ? ` (${id.name})` : ''
      refs.oauthConnectedIdentity.textContent = `${login}${name}`
      setStatus(refs, login, 'ok')
      return
    }
    case 'pat': {
      const id = state.identity
      const login = id?.login ? `@${id.login}` : '@unknown'
      const name = id?.name ? ` (${id.name})` : ''
      refs.patConnectedIdentity.textContent = `${login}${name}`
      refs.patConnectedInput.value = getToken()
      // Reset the show-toggle every time we land here.
      refs.patConnectedInput.type = 'password'
      refs.patConnectedToggleBtn.textContent = 'Show'
      setStatus(refs, login, 'ok')
      return
    }
  }
}

function wire(refs: Refs, opts: MountSettingsOptions) {
  // ── OAuth actions (none state) ──
  refs.connectBtn.addEventListener('click', () => {
    void runDeviceFlow(refs, opts)
  })
  refs.deviceFlowCancelBtn.addEventListener('click', () => {
    cancelDeviceFlow(refs, 'Cancelled.')
  })
  refs.deviceFlowCopyBtn.addEventListener('click', async () => {
    if (!activeSession) return
    try {
      await navigator.clipboard.writeText(activeSession.code.userCode)
      refs.deviceFlowCopyBtn.textContent = 'Copied'
      setTimeout(() => (refs.deviceFlowCopyBtn.textContent = 'Copy code'), 1500)
    } catch {
      // clipboard may be unavailable in WebView; the code is on screen anyway.
    }
  })

  // ── OAuth disconnect (oauth state) ──
  refs.oauthDisconnectBtn.addEventListener('click', async () => {
    refs.oauthDisconnectBtn.disabled = true
    await saveToken('')
    refs.oauthDisconnectBtn.disabled = false
    applyState(refs, { kind: 'none' })
    notifyTokenChanged(opts)
  })

  // ── PAT actions (none state) ──
  refs.patToggleBtn.addEventListener('click', () => {
    const masked = refs.patInput.type === 'password'
    refs.patInput.type = masked ? 'text' : 'password'
    refs.patToggleBtn.textContent = masked ? 'Hide' : 'Show'
  })

  refs.patSaveBtn.addEventListener('click', async () => {
    const value = refs.patInput.value.trim()
    if (!value) {
      setStatus(refs, 'Token is empty', 'error')
      return
    }
    setStatus(refs, 'Saving…', 'busy')
    refs.patSaveBtn.disabled = true
    refs.patTestBtn.disabled = true
    const ok = await saveToken(value)
    if (!ok) {
      refs.patSaveBtn.disabled = false
      refs.patTestBtn.disabled = false
      setStatus(refs, 'setLocalStorage rejected the value', 'error')
      return
    }
    setStatus(refs, 'Saved · validating…', 'busy')
    const result = await validateToken(value)
    refs.patSaveBtn.disabled = false
    refs.patTestBtn.disabled = false
    if (result.ok) {
      applyState(refs, { kind: 'pat', identity: result })
      notifyTokenChanged(opts)
    } else {
      // Save succeeded but validation failed — leave the token in storage
      // (user can still use it; main.ts will surface API errors) but
      // explain. Don't auto-disconnect.
      applyState(refs, { kind: 'pat', identity: null })
      setStatus(refs, result.error, 'error')
      notifyTokenChanged(opts)
    }
  })

  refs.patTestBtn.addEventListener('click', async () => {
    const value = refs.patInput.value.trim()
    if (!value) {
      setStatus(refs, 'Token is empty', 'error')
      return
    }
    refs.patTestBtn.disabled = true
    setStatus(refs, 'Testing…', 'busy')
    const result = await validateToken(value)
    refs.patTestBtn.disabled = false
    if (result.ok) {
      const name = result.name ? ` (${result.name})` : ''
      setStatus(refs, `OK · @${result.login}${name}`, 'ok')
    } else {
      setStatus(refs, result.error, 'error')
    }
  })

  // ── PAT connected (pat state) ──
  refs.patConnectedToggleBtn.addEventListener('click', () => {
    const masked = refs.patConnectedInput.type === 'password'
    refs.patConnectedInput.type = masked ? 'text' : 'password'
    refs.patConnectedToggleBtn.textContent = masked ? 'Hide' : 'Show'
  })

  refs.patUpdateBtn.addEventListener('click', async () => {
    const value = refs.patConnectedInput.value.trim()
    if (!value) {
      setStatus(refs, 'Token is empty', 'error')
      return
    }
    if (value === getToken()) {
      setStatus(refs, 'No change.', 'idle')
      return
    }
    refs.patUpdateBtn.disabled = true
    setStatus(refs, 'Updating…', 'busy')
    const ok = await saveToken(value)
    if (!ok) {
      refs.patUpdateBtn.disabled = false
      setStatus(refs, 'setLocalStorage rejected the value', 'error')
      return
    }
    setStatus(refs, 'Updated · validating…', 'busy')
    const result = await validateToken(value)
    refs.patUpdateBtn.disabled = false
    if (result.ok) {
      applyState(refs, { kind: 'pat', identity: result })
      notifyTokenChanged(opts)
    } else {
      setStatus(refs, result.error, 'error')
    }
  })

  refs.patDisconnectBtn.addEventListener('click', async () => {
    refs.patDisconnectBtn.disabled = true
    await saveToken('')
    refs.patDisconnectBtn.disabled = false
    applyState(refs, { kind: 'none' })
    notifyTokenChanged(opts)
  })
}

async function runDeviceFlow(refs: Refs, opts: MountSettingsOptions): Promise<void> {
  if (activeSession) return
  refs.connectBtn.disabled = true
  refs.connectBtn.textContent = 'Requesting code…'
  setStatus(refs, 'Starting Device Flow…', 'busy')

  let code: DeviceCode
  try {
    code = await startDeviceFlow()
  } catch (err) {
    refs.connectBtn.disabled = false
    refs.connectBtn.textContent = 'Connect'
    setStatus(refs, err instanceof Error ? err.message : String(err), 'error')
    return
  }

  refs.deviceFlowCode.textContent = code.userCode
  refs.deviceFlowOpenBtn.href = code.verificationUri
  refs.deviceFlowMessage.textContent = `Waiting for authorization (expires in ${Math.round(code.expiresInSec / 60)} min)…`
  refs.deviceFlowPanel.style.display = ''
  refs.connectBtn.disabled = true
  refs.connectBtn.textContent = 'Authorize on GitHub →'
  setStatus(refs, `Code: ${code.userCode}`, 'busy')

  const session: DeviceFlowSession = {
    code,
    intervalSec: code.intervalSec,
    pollTimer: 0,
    expiryTimer: 0,
  }
  activeSession = session

  session.expiryTimer = window.setTimeout(() => {
    cancelDeviceFlow(refs, 'Code expired. Try again.', 'error')
  }, code.expiresInSec * 1000)

  schedulePoll(refs, opts, session)
}

function schedulePoll(refs: Refs, opts: MountSettingsOptions, session: DeviceFlowSession): void {
  session.pollTimer = window.setTimeout(() => {
    void doPoll(refs, opts, session)
  }, session.intervalSec * 1000)
}

async function doPoll(refs: Refs, opts: MountSettingsOptions, session: DeviceFlowSession): Promise<void> {
  if (activeSession !== session) return
  let result: Awaited<ReturnType<typeof pollDeviceFlow>>
  try {
    result = await pollDeviceFlow(session.code.deviceCode)
  } catch (err) {
    refs.deviceFlowMessage.textContent =
      'Network error — retrying. ' + (err instanceof Error ? err.message : String(err))
    schedulePoll(refs, opts, session)
    return
  }
  if (activeSession !== session) return

  switch (result.status) {
    case 'pending':
      schedulePoll(refs, opts, session)
      return
    case 'slow_down':
      session.intervalSec = result.suggestedIntervalSec
      refs.deviceFlowMessage.textContent = `Slowing poll rate (every ${session.intervalSec}s)…`
      schedulePoll(refs, opts, session)
      return
    case 'denied':
    case 'expired':
    case 'error':
      cancelDeviceFlow(refs, result.error, 'error')
      return
    case 'success': {
      stopSessionTimers(session)
      activeSession = null
      refs.deviceFlowPanel.style.display = 'none'
      refs.connectBtn.disabled = false
      refs.connectBtn.textContent = 'Connect'
      // The token is already persisted by pollDeviceFlow; surface identity.
      const validated = await validateToken(getToken())
      const id = validated.ok ? validated : null
      applyState(refs, { kind: 'oauth', identity: id })
      notifyTokenChanged(opts)
      return
    }
  }
}

function cancelDeviceFlow(
  refs: Refs,
  message: string,
  kind: 'idle' | 'ok' | 'error' | 'busy' = 'idle',
): void {
  if (activeSession) {
    stopSessionTimers(activeSession)
    activeSession = null
  }
  refs.deviceFlowPanel.style.display = 'none'
  refs.connectBtn.disabled = false
  refs.connectBtn.textContent = 'Connect'
  setStatus(refs, message, kind)
}

function stopSessionTimers(session: DeviceFlowSession): void {
  if (session.pollTimer) clearTimeout(session.pollTimer)
  if (session.expiryTimer) clearTimeout(session.expiryTimer)
}

function setStatus(refs: Refs, message: string, kind: 'idle' | 'ok' | 'error' | 'busy') {
  refs.statusPill.textContent = message
  refs.statusPill.style.color =
    kind === 'ok' ? '#7EE787' : kind === 'error' ? '#FF8A8A' : kind === 'busy' ? '#FEF991' : '#919191'
}

function notifyTokenChanged(opts: MountSettingsOptions) {
  opts.onTokenChanged?.()
  window.dispatchEvent(new CustomEvent(TOKEN_CHANGED_EVENT))
}
