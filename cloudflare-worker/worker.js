// Tiny CORS proxy for GitHub OAuth Device Flow.
//
// GitHub's /login/device/code and /login/oauth/access_token endpoints
// don't return Access-Control-Allow-Origin, which blocks browser-based
// clients. This Worker forwards exactly those two endpoints with CORS
// headers added; nothing else.
//
// No secrets, no storage, no logging. Both endpoints take the public
// client_id; the OAuth app is registered as a "public" client so no
// client_secret is required for Device Flow.

const ALLOWED_PATHS = new Set(['/login/device/code', '/login/oauth/access_token'])

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept',
  'Access-Control-Max-Age': '86400',
}

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS })
    }

    const url = new URL(request.url)
    if (!ALLOWED_PATHS.has(url.pathname)) {
      return jsonResponse({ error: 'not_found', path: url.pathname }, 404)
    }
    if (request.method !== 'POST') {
      return jsonResponse({ error: 'method_not_allowed' }, 405)
    }

    const upstream = await fetch(`https://github.com${url.pathname}`, {
      method: 'POST',
      headers: {
        'Content-Type': request.headers.get('Content-Type') || 'application/json',
        Accept: request.headers.get('Accept') || 'application/json',
        'User-Agent': 'my-prs-evenhub-cors-proxy',
      },
      body: request.body,
    })

    const headers = new Headers()
    const contentType = upstream.headers.get('Content-Type')
    if (contentType) headers.set('Content-Type', contentType)
    for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v)

    return new Response(upstream.body, { status: upstream.status, headers })
  },
}

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  })
}
