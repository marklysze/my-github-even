import { authHeaders, refreshOAuthToken } from './auth'

export interface PullRequest {
  number: number
  title: string
  createdAt: string
  draft: boolean
  // From the search API's `comments` field — only counts conversation
  // (issue) comments, NOT review/line comments. The PR list label is
  // therefore an undercount when reviewers have left review/line comments;
  // the comment-list view shows the accurate breakdown.
  commentCount: number
  // Owner+repo extracted from `repository_url` in the search response.
  // Needed because the PR list is cross-repo — comment fetches and any
  // future "open on GitHub" link need to know which repo each PR belongs to.
  owner: string
  repo: string
}

export type ThreadKind = 'issue' | 'review' | 'line'

export interface ThreadItem {
  id: number
  author: string
  createdAt: string
  body: string
  kind: ThreadKind
  // 0 = top-level, 1 = nested under a review (line comment under its review)
  indent: 0 | 1
  // review-specific
  state?: string
  // line-specific
  path?: string
  line?: number
}

// `reason` mirrors GitHub's notification reason vocabulary
// (https://docs.github.com/en/rest/activity/notifications). We don't
// enumerate all values — anything we don't special-case falls through.
export type NotificationSubjectKind = 'PullRequest' | 'Issue' | 'Discussion' | 'Other'

// Live PR state — fetched via a follow-up call once the notification list
// is back. `merged` and `closed` are mutually exclusive in GitHub's model:
// a merged PR has state=closed AND merged=true; we report it as 'merged'.
export type PRStatus = 'open' | 'draft' | 'merged' | 'closed'

export interface Notification {
  id: string
  reason: string
  unread: boolean
  updatedAt: string
  title: string
  kind: NotificationSubjectKind
  repoFullName: string
  // For pull-request and issue subjects, parsed from subject.url.
  // null when the URL doesn't match the expected pattern (e.g. discussions).
  prNumber: number | null
  // Populated by enrichNotificationsWithPRStatus for PR-typed notifications;
  // undefined for Issue/Discussion/Other or until enrichment completes.
  prStatus?: PRStatus
}

async function getJson<T>(url: string): Promise<T> {
  let res = await fetch(url, { headers: authHeaders() })
  // 401 with an OAuth session usually means the access token hit its 8h
  // expiry. Try a refresh + retry exactly once before surfacing the error;
  // for PAT sessions refreshOAuthToken returns false and we drop straight
  // through to the throw.
  if (res.status === 401 && (await refreshOAuthToken())) {
    res = await fetch(url, { headers: authHeaders() })
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => res.statusText)
    if (res.status === 401) {
      throw new Error('Unauthorized (401). Check token in settings.')
    }
    throw new Error(`GitHub ${res.status}: ${detail.slice(0, 120)}`)
  }
  return res.json() as Promise<T>
}

// Search API returns repository_url in the form
// "https://api.github.com/repos/{owner}/{repo}". Parse out owner/repo.
function parseRepoUrl(url: string | undefined): { owner: string; repo: string } {
  if (!url) return { owner: '?', repo: '?' }
  const m = url.match(/\/repos\/([^/]+)\/([^/]+)$/)
  return m ? { owner: m[1], repo: m[2] } : { owner: '?', repo: '?' }
}

function mapSearchItemToPR(item: Record<string, any>): PullRequest {
  const { owner, repo } = parseRepoUrl(item.repository_url as string | undefined)
  return {
    number: item.number as number,
    title: (item.title as string).trim(),
    createdAt: item.created_at as string,
    draft:
      (item.draft as boolean | undefined) ??
      ((item.pull_request as { draft?: boolean } | undefined)?.draft ?? false),
    commentCount: (item.comments as number | undefined) ?? 0,
    owner,
    repo,
  }
}

async function searchIssues(query: string): Promise<PullRequest[]> {
  const url =
    'https://api.github.com/search/issues' +
    `?q=${encodeURIComponent(query)}&per_page=100&sort=updated&order=desc`
  const data = await getJson<{ items: Array<Record<string, any>> }>(url)
  return data.items.map(mapSearchItemToPR)
}

export async function fetchAuthoredOpenPRs(): Promise<PullRequest[]> {
  return searchIssues('is:pr is:open author:@me archived:false')
}

export async function fetchReviewRequestedPRs(): Promise<PullRequest[]> {
  return searchIssues('is:pr is:open review-requested:@me archived:false')
}

// Subject URLs we recognize:
//   PR:     /repos/{o}/{r}/pulls/{n}
//   Issue:  /repos/{o}/{r}/issues/{n}
// Anything else (discussions, releases, etc.) leaves prNumber null.
function classifySubject(
  type: string | undefined,
  subjectUrl: string | undefined,
): { kind: NotificationSubjectKind; prNumber: number | null } {
  const kind: NotificationSubjectKind =
    type === 'PullRequest'
      ? 'PullRequest'
      : type === 'Issue'
        ? 'Issue'
        : type === 'Discussion'
          ? 'Discussion'
          : 'Other'
  if (kind === 'PullRequest' && subjectUrl) {
    const m = subjectUrl.match(/\/pulls\/(\d+)$/)
    if (m) return { kind, prNumber: Number(m[1]) }
  }
  return { kind, prNumber: null }
}

export async function fetchUnreadNotifications(): Promise<Notification[]> {
  const url = 'https://api.github.com/notifications?all=false&per_page=50'
  const raw = await getJson<Array<Record<string, any>>>(url)
  return raw.map(n => {
    const subject = (n.subject ?? {}) as { title?: string; type?: string; url?: string }
    const repo = (n.repository ?? {}) as { full_name?: string }
    const { kind, prNumber } = classifySubject(subject.type, subject.url)
    return {
      id: String(n.id ?? ''),
      reason: String(n.reason ?? 'subscribed'),
      unread: n.unread !== false,
      updatedAt: String(n.updated_at ?? ''),
      title: (subject.title ?? '(untitled)').trim(),
      kind,
      repoFullName: repo.full_name ?? '?/?',
      prNumber,
    }
  })
}

// Decorate PR-typed notifications with current PR state. Issued, closed,
// merged, draft can all change after the notification was sent — and the
// /notifications response carries no state, only the subject URL — so we
// fan out one /pulls/{n} fetch per PR notification in parallel.
//
// Failures are swallowed per-item: a notification whose PR fetch 404s
// (deleted, no permission, etc.) just renders without a status tag.
export async function enrichNotificationsWithPRStatus(
  notifs: Notification[],
): Promise<Notification[]> {
  const out = notifs.slice()
  const indexes: number[] = []
  out.forEach((n, i) => {
    if (n.kind === 'PullRequest' && n.prNumber) indexes.push(i)
  })
  if (indexes.length === 0) return out

  await Promise.all(
    indexes.map(async i => {
      const n = out[i]
      const [owner, repo] = n.repoFullName.split('/')
      if (!owner || !repo || !n.prNumber) return
      const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${n.prNumber}`
      try {
        const pr = await getJson<{ state?: string; merged?: boolean; draft?: boolean }>(url)
        out[i] = { ...n, prStatus: derivePRStatus(pr) }
      } catch (err) {
        // Leave prStatus undefined — list still renders with reason fallback.
        console.warn(`[my-github] PR status fetch failed for ${owner}/${repo}#${n.prNumber}:`, err)
      }
    }),
  )
  return out
}

function derivePRStatus(pr: {
  state?: string
  merged?: boolean
  draft?: boolean
}): PRStatus {
  if (pr.merged) return 'merged'
  if (pr.state === 'closed') return 'closed'
  if (pr.draft) return 'draft'
  return 'open'
}

// Fetches all three GitHub PR comment streams (conversation, line, reviews)
// in parallel and threads them into display order: each surviving review
// becomes a top-level item with its line comments nested directly beneath.
export async function fetchAllComments(
  owner: string,
  repo: string,
  prNumber: number,
): Promise<ThreadItem[]> {
  const base = `https://api.github.com/repos/${owner}/${repo}`
  const [issueRaw, lineRaw, reviewRaw] = await Promise.all([
    getJson<Array<Record<string, any>>>(`${base}/issues/${prNumber}/comments?per_page=100`),
    getJson<Array<Record<string, any>>>(`${base}/pulls/${prNumber}/comments?per_page=100`),
    getJson<Array<Record<string, any>>>(`${base}/pulls/${prNumber}/reviews?per_page=100`),
  ])

  // Drop empty review wrappers — when you leave a single line comment via
  // "Add a single comment" GitHub still creates a state=COMMENTED review with
  // a null body to wrap it. That review has no information of its own; only
  // its child line comment matters.
  const keptReviews: ThreadItem[] = reviewRaw
    .filter(r => ((r.body as string | null) ?? '').trim() !== '' || r.state !== 'COMMENTED')
    .map(r => ({
      id: r.id as number,
      author: (r.user as { login?: string } | undefined)?.login ?? 'unknown',
      createdAt: (r.submitted_at as string | undefined) ?? (r.created_at as string),
      body: ((r.body as string | null) ?? '').trim(),
      kind: 'review',
      indent: 0,
      state: r.state as string | undefined,
    }))

  const keptReviewIds = new Set(keptReviews.map(r => r.id))

  const lineItems: Array<ThreadItem & { parentReviewId: number | null }> = lineRaw.map(c => ({
    id: c.id as number,
    author: (c.user as { login?: string } | undefined)?.login ?? 'unknown',
    createdAt: c.created_at as string,
    body: ((c.body as string | undefined) ?? '').trim(),
    kind: 'line',
    indent: 0,
    path: c.path as string | undefined,
    line: (c.line as number | undefined) ?? (c.original_line as number | undefined),
    parentReviewId: (c.pull_request_review_id as number | null | undefined) ?? null,
  }))

  // Build display blocks. A block is rendered as a contiguous run; blocks
  // are then sorted chronologically by their first item's timestamp.
  const blocks: ThreadItem[][] = []

  for (const issue of issueRaw) {
    blocks.push([
      {
        id: issue.id as number,
        author: (issue.user as { login?: string } | undefined)?.login ?? 'unknown',
        createdAt: issue.created_at as string,
        body: ((issue.body as string | undefined) ?? '').trim(),
        kind: 'issue',
        indent: 0,
      },
    ])
  }

  for (const review of keptReviews) {
    const children = lineItems
      .filter(c => c.parentReviewId === review.id)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map<ThreadItem>(({ parentReviewId: _p, ...rest }) => ({ ...rest, indent: 1 }))
    blocks.push([review, ...children])
  }

  // Orphan line comments — no parent review, or their wrapper review was discarded.
  for (const line of lineItems) {
    if (line.parentReviewId === null || !keptReviewIds.has(line.parentReviewId)) {
      const { parentReviewId: _p, ...rest } = line
      blocks.push([{ ...rest, indent: 0 }])
    }
  }

  blocks.sort((a, b) => a[0].createdAt.localeCompare(b[0].createdAt))
  return blocks.flat()
}

export function relativeTime(iso: string, now: number = Date.now()): string {
  if (!iso) return ''
  const diffSec = Math.max(1, Math.floor((now - new Date(iso).getTime()) / 1000))
  if (diffSec < 60) return `${diffSec}s ago`
  const min = Math.floor(diffSec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  if (day < 30) return `${day}d ago`
  const mo = Math.floor(day / 30)
  if (mo < 12) return `${mo}mo ago`
  return `${Math.floor(day / 365)}y ago`
}

export function formatPRListItem(pr: PullRequest, includeRepo = true): string {
  const tag = pr.draft ? ' draft' : ''
  const cc = pr.commentCount > 0 ? ` (${pr.commentCount})` : ''
  const repoPrefix = includeRepo ? `${pr.repo} · ` : ''
  return clipItem(`${repoPrefix}#${pr.number}${cc}${tag} ${pr.title}`)
}

const REASON_LABELS: Record<string, string> = {
  assign: 'assigned',
  author: 'author',
  comment: 'comment',
  ci_activity: 'CI',
  invitation: 'invite',
  manual: 'subscribed',
  member_feature_requested: 'feature',
  mention: 'mention',
  push: 'push',
  review_requested: 'review',
  security_alert: 'security',
  state_change: 'state',
  subscribed: 'subscribed',
  team_mention: 'team',
}

// Two-character compact indicators for the most common reasons. Anything
// not in this map falls back to REASON_LABELS' word form. Kept ASCII-only
// (uppercase letters always render in the firmware font).
const REASON_ICONS: Record<string, string> = {
  author: 'AU',
  mention: 'MN',
}

// Single-glyph status icons replace word labels. Picked specifically for
// firmware-font reliability: ● and ○ are Geometric Shapes (universal),
// ★ is Misc Symbols (very common), × is Latin-1 Supplement (everywhere).
// Earlier picks (◐ ✓ ✗) silently dropped on G2 — the firmware's LVGL font
// doesn't ship those code points, so they rendered as nothing.
const STATUS_LABELS: Record<PRStatus, string> = {
  open: '●',
  draft: '○',
  merged: '★',
  closed: '×',
}

export function formatNotificationListItem(n: Notification, now: number = Date.now()): string {
  const reasonText = REASON_ICONS[n.reason] ?? REASON_LABELS[n.reason] ?? n.reason
  const time = relativeTime(n.updatedAt, now)
  const repo = n.repoFullName.split('/').slice(-1)[0] || n.repoFullName
  // PR rows show the live status glyph (● ○ ★ ×); non-PR rows fall back
  // to the reason indicator (compact 2-char form for common reasons via
  // REASON_ICONS, full word otherwise).
  const tag = n.prStatus ? STATUS_LABELS[n.prStatus] : reasonText
  return clipItem(`${repo} · ${tag} · ${time} · ${n.title}`)
}

function basename(p: string): string {
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return idx >= 0 ? p.slice(idx + 1) : p
}

function reviewStateTag(state: string | undefined): string {
  switch (state) {
    case 'APPROVED':
      return 'APPROVED'
    case 'CHANGES_REQUESTED':
      return 'CHANGES'
    case 'DISMISSED':
      return 'DISMISSED'
    default:
      return 'REVIEW'
  }
}

export function formatThreadListItem(item: ThreadItem, now: number = Date.now()): string {
  const flat = item.body.replace(/\s+/g, ' ')
  const time = relativeTime(item.createdAt, now)
  const prefix = item.indent === 1 ? '  ' : ''

  if (item.kind === 'issue') {
    return clipItem(`${prefix}${item.author} · ${time} · ${flat}`)
  }
  if (item.kind === 'review') {
    const tag = reviewStateTag(item.state)
    return clipItem(`${prefix}${item.author} · ${time} · ${tag}: ${flat || '(no message)'}`)
  }
  // line
  const file = basename(item.path ?? '?')
  if (item.indent === 1) {
    return clipItem(`${prefix}${file}:${item.line} · ${flat}`)
  }
  return clipItem(`${prefix}${item.author} · ${time} · ${file}:${item.line} · ${flat}`)
}

export function formatThreadDetail(item: ThreadItem, now: number = Date.now()): string {
  const time = relativeTime(item.createdAt, now)
  let header = `${item.author} · ${time}`
  if (item.kind === 'review') {
    header += `\nReview: ${reviewStateTag(item.state)}`
  } else if (item.kind === 'line') {
    header += `\nOn ${item.path}:${item.line}`
  }
  const body = item.body || '(no body)'
  return `${header}\n\n${body}`
}

// G2 list items are hard-capped by firmware. Docs say "64 characters" but
// the real limit appears to be measured in UTF-8 bytes — multibyte glyphs
// (·, …, ←, CJK, emoji) eat into the budget. Stay safely under 64 bytes.
export const LIST_ITEM_MAX_BYTES = 60

const utf8 = new TextEncoder()
function utf8Bytes(s: string): number {
  return utf8.encode(s).length
}

export function clipItem(s: string): string {
  if (utf8Bytes(s) <= LIST_ITEM_MAX_BYTES) return s
  let trimmed = s
  while (utf8Bytes(trimmed + '…') > LIST_ITEM_MAX_BYTES && trimmed.length > 0) {
    trimmed = trimmed.slice(0, -1)
  }
  return trimmed + '…'
}
