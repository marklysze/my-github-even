import {
  waitForEvenAppBridge,
  TextContainerProperty,
  ListContainerProperty,
  ListItemContainerProperty,
  ImageContainerProperty,
  ImageRawDataUpdate,
  CreateStartUpPageContainer,
  RebuildPageContainer,
  TextContainerUpgrade,
  OsEventTypeList,
} from '@evenrealities/even_hub_sdk'
import { paginate } from './paginate'
import {
  fetchAuthoredOpenPRs,
  fetchReviewRequestedPRs,
  fetchUnreadNotifications,
  enrichNotificationsWithPRStatus,
  fetchAllComments,
  formatPRListItem,
  formatNotificationListItem,
  formatThreadListItem,
  formatThreadDetail,
  PullRequest,
  Notification,
  ThreadItem,
} from './github'
import {
  setAuthBridge,
  loadToken,
  hasToken,
  validateToken,
  type ValidatedIdentity,
} from './auth'
import { mountSettings, TOKEN_CHANGED_EVENT } from './settings'

const SCREEN_W = 576
const SCREEN_H = 288

// Firmware caps a list at 20 items. We reserve slot 0 for "← Back" in
// non-root list views, so sublists show at most 19 actual entries.
const LIST_MAX_ITEMS = 20

const LOGO_W = 50
const LOGO_H = 50
const LOGO_X = SCREEN_W - LOGO_W - 4
const LOGO_Y = 4
const HEADER_H = LOGO_Y + LOGO_H + 4
const TITLE_X = 12
// Title width on header pages: leaves TITLE_X clearance on the left and a
// 4px gap before the logo on the right.
const TITLE_W = LOGO_X - TITLE_X - 4
// Title width on logo-less pages (comment-list): symmetric TITLE_X margins.
const TITLE_W_FULL = SCREEN_W - TITLE_X * 2
const TITLE_Y = 16
const TITLE_H = 30
const LIST_Y = HEADER_H
const LIST_H = SCREEN_H - HEADER_H

const DETAIL_BODY_W = 576
const DETAIL_BODY_H = 240
const DETAIL_BODY_PAD = 4
const DETAIL_INNER_W = DETAIL_BODY_W - 2 * DETAIL_BODY_PAD
const DETAIL_INNER_H = DETAIL_BODY_H - 2 * DETAIL_BODY_PAD
const DETAIL_PAGER_Y = 250
const DETAIL_PAGER_H = 30

const LOGO_URL = `${import.meta.env.BASE_URL}github-invertocat.png`

// App-wide frame around the canvas. Stillness uses the same pattern: a
// content-less text container with `borderWidth + borderColor + borderRadius`
// set, drawn first so other containers layer on top. Set SHOW_FRAME=false
// to disable in one line.
const SHOW_FRAME = true
const FRAME_ID = 99
const FRAME_WIDTH = 1
const FRAME_COLOR = 5
const FRAME_RADIUS = 6

function frameContainer(): TextContainerProperty {
  return new TextContainerProperty({
    xPosition: 0,
    yPosition: 0,
    width: SCREEN_W,
    height: SCREEN_H,
    borderWidth: FRAME_WIDTH,
    borderColor: FRAME_COLOR,
    borderRadius: FRAME_RADIUS,
    paddingLength: 0,
    containerID: FRAME_ID,
    containerName: 'frame',
    content: '',
    isEventCapture: 0,
  })
}

// Comment-list views remember which list they came from so double-tap can
// pop back to the right place (authored / review / notification).
type CameFrom = 'authored' | 'review' | 'notif'

type View =
  | { kind: 'no-token' }
  | { kind: 'loading'; text: string }
  | { kind: 'error'; text: string }
  | { kind: 'home' }
  | { kind: 'pr-list'; mode: 'authored' | 'review'; prs: PullRequest[] }
  | { kind: 'notif-list'; notifs: Notification[] }
  | { kind: 'notif-detail'; notif: Notification }
  | {
      kind: 'comment-list'
      pr: PullRequest
      comments: ThreadItem[]
      cameFrom: CameFrom
    }
  | {
      kind: 'comment-detail'
      pr: PullRequest
      comments: ThreadItem[]
      comment: ThreadItem
      pages: string[]
      page: number
      cameFrom: CameFrom
    }

// Declared up-front because the first rebuild runs synchronously (via
// `void boot()` below) and reaches rebuild() before the rest of the module
// has finished evaluating — TDZ would throw otherwise.
let rendering: Promise<unknown> = Promise.resolve()

let view: View = { kind: 'loading', text: 'Starting…' }

let cachedAuthored: PullRequest[] = []
let cachedReviews: PullRequest[] = []
let cachedNotifs: Notification[] = []
let cachedIdentity: ValidatedIdentity | null = null

const bridge = await waitForEvenAppBridge()
setAuthBridge(bridge)

// Initial placeholder so createStartUpPageContainer succeeds; everything
// after uses rebuildPageContainer to swap views.
{
  const placeholder = new TextContainerProperty({
    xPosition: 0,
    yPosition: 0,
    width: SCREEN_W,
    height: SCREEN_H,
    paddingLength: 4,
    borderWidth: 0,
    borderColor: 5,
    containerID: 1,
    containerName: 'placeholder',
    content: 'Starting…',
    isEventCapture: 1,
  })
  const created = await bridge.createStartUpPageContainer(
    new CreateStartUpPageContainer({ containerTotalNum: 1, textObject: [placeholder] }),
  )
  if (created !== 0) console.error('createStartUpPageContainer failed:', created)
}

mountCompanion()
mountSettings(document.getElementById('settings-panel')!, {
  onTokenChanged: () => {
    void boot()
  },
})

window.addEventListener(TOKEN_CHANGED_EVENT, () => {
  void boot()
})

void boot()

console.log('[my-github] ready')

// ─────────────────────────── boot / nav ───────────────────────────

async function boot() {
  await loadToken()
  if (!hasToken()) {
    view = { kind: 'no-token' }
    cachedIdentity = null
    await renderNoToken()
    return
  }

  // Validate token + cache identity. Treat 401 as "no token" so we steer
  // the user back to settings instead of crashing on every fetch.
  if (!cachedIdentity) {
    view = { kind: 'loading', text: 'Verifying token…' }
    await renderLoading()
    const result = await validateToken((await loadToken()) || '')
    if (!result.ok) {
      view = { kind: 'error', text: `Token check failed.\n\n${result.error}` }
      await renderError()
      return
    }
    cachedIdentity = result
  }

  await refreshAll()
  await showHome()
}

async function refreshAll() {
  view = { kind: 'loading', text: `Loading data for @${cachedIdentity?.login ?? '...'}` }
  await renderLoading()
  try {
    const [authored, reviews, notifs] = await Promise.all([
      fetchAuthoredOpenPRs(),
      fetchReviewRequestedPRs(),
      fetchUnreadNotifications(),
    ])
    cachedAuthored = authored
    cachedReviews = reviews
    cachedNotifs = notifs
  } catch (err) {
    view = { kind: 'error', text: `Fetch failed.\n\n${errMsg(err)}` }
    await renderError()
    throw err
  }
  // Don't block home/list rendering on PR-status enrichment — it adds
  // one round-trip per PR notification. Fire it in the background and
  // re-render notif-list in place if the user is looking at it when the
  // enriched data arrives.
  void enrichNotifsInBackground()
}

async function enrichNotifsInBackground() {
  const baseline = cachedNotifs
  let enriched: Notification[]
  try {
    enriched = await enrichNotificationsWithPRStatus(baseline)
  } catch (err) {
    console.warn('[my-github] notification enrichment failed:', err)
    return
  }
  // Skip if a fresh refresh swapped the cache while we were fetching.
  if (cachedNotifs !== baseline) return
  cachedNotifs = enriched
  if (view.kind === 'notif-list') {
    view = { kind: 'notif-list', notifs: enriched }
    await renderNotifList()
  }
}

async function showHome() {
  view = { kind: 'home' }
  await renderHome()
}

async function showPRList(mode: 'authored' | 'review') {
  const prs = mode === 'authored' ? cachedAuthored : cachedReviews
  view = { kind: 'pr-list', mode, prs }
  await renderPRList()
}

async function showNotifList() {
  view = { kind: 'notif-list', notifs: cachedNotifs }
  await renderNotifList()
}

async function showNotifDetail(notif: Notification) {
  view = { kind: 'notif-detail', notif }
  await renderNotifDetail()
}

async function loadAndShowComments(pr: PullRequest, cameFrom: CameFrom) {
  view = { kind: 'loading', text: `Loading #${pr.number} comments…` }
  await renderLoading()
  let comments: ThreadItem[]
  try {
    comments = await fetchAllComments(pr.owner, pr.repo, pr.number)
  } catch (err) {
    view = { kind: 'error', text: `Fetch failed.\n\n${errMsg(err)}` }
    await renderError()
    return
  }
  view = { kind: 'comment-list', pr, comments, cameFrom }
  await renderCommentList()
}

async function showCommentList(pr: PullRequest, comments: ThreadItem[], cameFrom: CameFrom) {
  view = { kind: 'comment-list', pr, comments, cameFrom }
  await renderCommentList()
}

async function showCommentDetail(
  pr: PullRequest,
  comments: ThreadItem[],
  comment: ThreadItem,
  cameFrom: CameFrom,
) {
  const pages = paginate(formatThreadDetail(comment), {
    width: DETAIL_INNER_W,
    height: DETAIL_INNER_H,
  })
  view = { kind: 'comment-detail', pr, comments, comment, pages, page: 0, cameFrom }
  await renderCommentDetail()
}

function goToDetailPage(idx: number) {
  if (view.kind !== 'comment-detail') return
  if (idx < 0 || idx >= view.pages.length || idx === view.page) return
  view = { ...view, page: idx }
  void upgradeDetailPage()
}

// Navigate from a notification to its underlying PR if we can resolve
// owner/repo/number from the notification subject. Otherwise show the
// read-only notification detail.
async function openNotification(notif: Notification) {
  if (notif.kind === 'PullRequest' && notif.prNumber) {
    const [owner, repo] = notif.repoFullName.split('/')
    if (owner && repo) {
      const pseudoPR: PullRequest = {
        number: notif.prNumber,
        title: notif.title,
        createdAt: notif.updatedAt,
        draft: false,
        commentCount: 0,
        owner,
        repo,
      }
      await loadAndShowComments(pseudoPR, 'notif')
      return
    }
  }
  await showNotifDetail(notif)
}

// ─────────────────────────── rendering ───────────────────────────

async function rebuild(payload: {
  textObject?: TextContainerProperty[]
  listObject?: ListContainerProperty[]
  imageObject?: ImageContainerProperty[]
}) {
  // Frame goes first so other text/list/image containers layer on top of
  // it; the border is just an outline, so content overlapping the inside
  // of the frame still draws normally.
  const text = SHOW_FRAME
    ? [frameContainer(), ...(payload.textObject ?? [])]
    : (payload.textObject ?? [])
  const list = payload.listObject ?? []
  const image = payload.imageObject ?? []
  const summary = {
    textCount: text.length,
    listCount: list.length,
    imageCount: image.length,
    listItems: list[0]?.itemContainer?.itemName,
    textNames: text.map(t => t.containerName),
    imageNames: image.map(i => i.containerName),
  }
  console.log('[my-github] rebuild →', JSON.stringify(summary))
  rendering = rendering.then(async () => {
    const ok = await bridge.rebuildPageContainer(
      new RebuildPageContainer({
        containerTotalNum: text.length + list.length + image.length,
        textObject: text,
        listObject: list,
        imageObject: image,
      }),
    )
    console.log('[my-github] rebuild result:', ok)
    if (!ok) console.error('[my-github] rebuildPageContainer failed for', JSON.stringify(summary))
  })
  await rendering
  mirrorCompanion()
}

let cachedLogoBytes: Uint8Array | null = null

async function loadLogoBytes(): Promise<Uint8Array> {
  if (cachedLogoBytes) return cachedLogoBytes
  const res = await fetch(LOGO_URL)
  if (!res.ok) throw new Error(`logo fetch ${res.status}`)
  cachedLogoBytes = new Uint8Array(await res.arrayBuffer())
  return cachedLogoBytes
}

async function pushLogoImage(containerID: number, containerName: string) {
  let bytes: Uint8Array
  try {
    bytes = await loadLogoBytes()
  } catch (err) {
    console.error('[my-github] logo load failed:', err)
    return
  }
  rendering = rendering.then(async () => {
    const result = await bridge.updateImageRawData(
      new ImageRawDataUpdate({ containerID, containerName, imageData: bytes }),
    )
    console.log('[my-github] logo updateImageRawData:', result)
    if (result !== 'success') {
      console.error('[my-github] logo render failed:', result)
    }
  })
  await rendering
}

async function renderNoToken() {
  await rebuild({
    textObject: [
      new TextContainerProperty({
        xPosition: 0,
        yPosition: 0,
        width: SCREEN_W,
        height: SCREEN_H,
        paddingLength: 8,
        borderWidth: 0,
        borderColor: 5,
        containerID: 1,
        containerName: 'no-token',
        content:
          'My GitHub requires access to read from your GitHub account.\n\n' +
          'Open the Even Hub app settings on your phone and connect to GitHub or paste a Personal Access Token.\n\n' +
          'This page will auto-refresh when access is authorized.',
        isEventCapture: 1,
      }),
    ],
  })
}

async function renderLoading() {
  if (view.kind !== 'loading') return
  await rebuild({
    textObject: [
      new TextContainerProperty({
        xPosition: 0,
        yPosition: 0,
        width: SCREEN_W,
        height: SCREEN_H,
        paddingLength: 4,
        borderWidth: 0,
        borderColor: 5,
        containerID: 1,
        containerName: 'loading',
        content: view.text,
        isEventCapture: 1,
      }),
    ],
  })
}

async function renderError() {
  if (view.kind !== 'error') return
  await rebuild({
    textObject: [
      new TextContainerProperty({
        xPosition: 0,
        yPosition: 0,
        width: SCREEN_W,
        height: SCREEN_H,
        paddingLength: 4,
        borderWidth: 0,
        borderColor: 5,
        containerID: 1,
        containerName: 'error',
        content: `${view.text}\n\nDouble-tap to exit.`,
        isEventCapture: 1,
      }),
    ],
  })
}

async function renderHome() {
  if (view.kind !== 'home') return

  const items = [
    `Notifications (${cachedNotifs.length})`,
    `My PRs (${cachedAuthored.length})`,
    `Review requests (${cachedReviews.length})`,
  ]

  const LOGO_CONTAINER_ID = 3
  const LOGO_CONTAINER_NAME = 'logo'
  const titleText = cachedIdentity ? `GitHub · @${cachedIdentity.login}` : 'GitHub'

  await rebuild({
    textObject: [
      new TextContainerProperty({
        xPosition: TITLE_X,
        yPosition: TITLE_Y,
        width: TITLE_W,
        height: TITLE_H,
        paddingLength: 0,
        borderWidth: 0,
        borderColor: 5,
        containerID: 2,
        containerName: 'title',
        content: titleText,
        isEventCapture: 0,
      }),
    ],
    imageObject: [
      new ImageContainerProperty({
        xPosition: LOGO_X,
        yPosition: LOGO_Y,
        width: LOGO_W,
        height: LOGO_H,
        containerID: LOGO_CONTAINER_ID,
        containerName: LOGO_CONTAINER_NAME,
      }),
    ],
    listObject: [
      new ListContainerProperty({
        xPosition: 0,
        yPosition: LIST_Y,
        width: SCREEN_W,
        height: LIST_H,
        paddingLength: 4,
        borderWidth: 0,
        borderColor: 5,
        containerID: 1,
        containerName: 'home-list',
        isEventCapture: 1,
        itemContainer: new ListItemContainerProperty({
          itemCount: items.length,
          itemWidth: 0,
          isItemSelectBorderEn: 1,
          itemName: items,
        }),
      }),
    ],
  })

  await pushLogoImage(LOGO_CONTAINER_ID, LOGO_CONTAINER_NAME)
}

async function renderPRList() {
  if (view.kind !== 'pr-list') return
  const visiblePRs = view.prs.slice(0, LIST_MAX_ITEMS)
  const items =
    visiblePRs.length === 0
      ? ['(none)']
      : visiblePRs.map(pr => formatPRListItem(pr, true))

  const heading = view.mode === 'authored' ? 'My PRs' : 'Review requests'
  const LOGO_CONTAINER_ID = 3
  const LOGO_CONTAINER_NAME = 'logo'

  await rebuild({
    textObject: [
      new TextContainerProperty({
        xPosition: TITLE_X,
        yPosition: TITLE_Y,
        width: TITLE_W,
        height: TITLE_H,
        paddingLength: 0,
        borderWidth: 0,
        borderColor: 5,
        containerID: 2,
        containerName: 'title',
        content: heading,
        isEventCapture: 0,
      }),
    ],
    imageObject: [
      new ImageContainerProperty({
        xPosition: LOGO_X,
        yPosition: LOGO_Y,
        width: LOGO_W,
        height: LOGO_H,
        containerID: LOGO_CONTAINER_ID,
        containerName: LOGO_CONTAINER_NAME,
      }),
    ],
    listObject: [
      new ListContainerProperty({
        xPosition: 0,
        yPosition: LIST_Y,
        width: SCREEN_W,
        height: LIST_H,
        paddingLength: 4,
        borderWidth: 0,
        borderColor: 5,
        containerID: 1,
        containerName: 'pr-list',
        isEventCapture: 1,
        itemContainer: new ListItemContainerProperty({
          itemCount: items.length,
          itemWidth: 0,
          isItemSelectBorderEn: 1,
          itemName: items,
        }),
      }),
    ],
  })

  await pushLogoImage(LOGO_CONTAINER_ID, LOGO_CONTAINER_NAME)
}

async function renderNotifList() {
  if (view.kind !== 'notif-list') return
  const visible = view.notifs.slice(0, LIST_MAX_ITEMS)
  const items =
    visible.length === 0 ? ['(no unread notifications)'] : visible.map(n => formatNotificationListItem(n))

  const LOGO_CONTAINER_ID = 3
  const LOGO_CONTAINER_NAME = 'logo'

  await rebuild({
    textObject: [
      new TextContainerProperty({
        xPosition: TITLE_X,
        yPosition: TITLE_Y,
        width: TITLE_W,
        height: TITLE_H,
        paddingLength: 0,
        borderWidth: 0,
        borderColor: 5,
        containerID: 2,
        containerName: 'title',
        content: 'Notifications',
        isEventCapture: 0,
      }),
    ],
    imageObject: [
      new ImageContainerProperty({
        xPosition: LOGO_X,
        yPosition: LOGO_Y,
        width: LOGO_W,
        height: LOGO_H,
        containerID: LOGO_CONTAINER_ID,
        containerName: LOGO_CONTAINER_NAME,
      }),
    ],
    listObject: [
      new ListContainerProperty({
        xPosition: 0,
        yPosition: LIST_Y,
        width: SCREEN_W,
        height: LIST_H,
        paddingLength: 4,
        borderWidth: 0,
        borderColor: 5,
        containerID: 1,
        containerName: 'notif-list',
        isEventCapture: 1,
        itemContainer: new ListItemContainerProperty({
          itemCount: items.length,
          itemWidth: 0,
          isItemSelectBorderEn: 1,
          itemName: items,
        }),
      }),
    ],
  })

  await pushLogoImage(LOGO_CONTAINER_ID, LOGO_CONTAINER_NAME)
}

async function renderNotifDetail() {
  if (view.kind !== 'notif-detail') return
  const n = view.notif
  const body =
    `${n.repoFullName}\n` +
    `${n.kind} · ${n.reason}\n\n` +
    `${n.title}\n\n` +
    `(open on github.com to view)\nDouble-tap to go back.`
  await rebuild({
    textObject: [
      new TextContainerProperty({
        xPosition: 0,
        yPosition: 0,
        width: SCREEN_W,
        height: SCREEN_H,
        paddingLength: 8,
        borderWidth: 0,
        borderColor: 5,
        containerID: 1,
        containerName: 'notif-detail',
        content: body,
        isEventCapture: 1,
      }),
    ],
  })
}

async function renderCommentList() {
  if (view.kind !== 'comment-list') return
  const visibleComments = view.comments.slice(0, LIST_MAX_ITEMS - 1)
  const items = ['← Back', ...visibleComments.map(c => formatThreadListItem(c))]
  if (view.comments.length === 0) items.push('(no comments)')

  // Header strip identifies which PR this list of comments belongs to.
  // Same dimensions as home/pr-list/notif-list so navigation feels consistent.
  const headerText = `${view.pr.repo} #${view.pr.number} ${view.pr.title}`

  await rebuild({
    textObject: [
      new TextContainerProperty({
        xPosition: TITLE_X,
        yPosition: TITLE_Y,
        width: TITLE_W_FULL,
        height: TITLE_H,
        paddingLength: 0,
        borderWidth: 0,
        borderColor: 5,
        containerID: 2,
        containerName: 'title',
        content: headerText,
        isEventCapture: 0,
      }),
    ],
    listObject: [
      new ListContainerProperty({
        xPosition: 0,
        yPosition: LIST_Y,
        width: SCREEN_W,
        height: LIST_H,
        paddingLength: 4,
        borderWidth: 0,
        borderColor: 5,
        containerID: 1,
        containerName: 'comment-list',
        isEventCapture: 1,
        itemContainer: new ListItemContainerProperty({
          itemCount: items.length,
          itemWidth: 0,
          isItemSelectBorderEn: 1,
          itemName: items,
        }),
      }),
    ],
  })
}

async function renderCommentDetail() {
  if (view.kind !== 'comment-detail') return
  await rebuild({
    textObject: [
      new TextContainerProperty({
        xPosition: 0,
        yPosition: 0,
        width: DETAIL_BODY_W,
        height: DETAIL_BODY_H,
        paddingLength: DETAIL_BODY_PAD,
        borderWidth: 0,
        borderColor: 5,
        containerID: 1,
        containerName: 'body',
        content: view.pages[view.page] ?? '(empty)',
        isEventCapture: 1,
      }),
      new TextContainerProperty({
        xPosition: 0,
        yPosition: DETAIL_PAGER_Y,
        width: SCREEN_W,
        height: DETAIL_PAGER_H,
        paddingLength: 4,
        borderWidth: 0,
        borderColor: 5,
        containerID: 2,
        containerName: 'pager',
        content: detailPagerLabel(),
        isEventCapture: 0,
      }),
    ],
  })
}

async function upgradeDetailPage() {
  if (view.kind !== 'comment-detail') return
  const v = view
  rendering = rendering.then(async () => {
    await bridge.textContainerUpgrade(
      new TextContainerUpgrade({
        containerID: 1,
        containerName: 'body',
        content: v.pages[v.page] ?? '',
      }),
    )
    await bridge.textContainerUpgrade(
      new TextContainerUpgrade({
        containerID: 2,
        containerName: 'pager',
        content: detailPagerLabel(),
      }),
    )
  })
  await rendering
  mirrorCompanion()
}

function detailPagerLabel(): string {
  if (view.kind !== 'comment-detail') return ''
  return `${view.page + 1} / ${view.pages.length}  ·  tap: next  ·  swipe up: prev  ·  double-tap: back`
}

// ─────────────────────────── event routing ───────────────────────────
//
// Gesture vocabulary on G2: tap, swipe-up (SCROLL_TOP), swipe-down
// (SCROLL_BOTTOM), double-tap. Behaviour is depth-dependent: double-tap
// pops one level; from root (home / no-token / error) it exits the app.
//
// Protobuf zero-value omission: CLICK_EVENT (=0) arrives as `undefined`
// after deserialization. eventTypeOf coalesces a present envelope with a
// missing type to CLICK_EVENT so single-tap detection is reliable.

function eventTypeOf<T extends { eventType?: OsEventTypeList }>(
  env: T | undefined,
): OsEventTypeList | null {
  if (!env) return null
  return env.eventType ?? OsEventTypeList.CLICK_EVENT
}

let cleanedUp = false
function cleanup() {
  if (cleanedUp) return
  cleanedUp = true
  unsubscribe()
}

const unsubscribe = bridge.onEvenHubEvent(event => {
  const sysType = eventTypeOf(event.sysEvent)
  const textType = eventTypeOf(event.textEvent)
  const listType = eventTypeOf(event.listEvent)

  if (
    sysType === OsEventTypeList.SYSTEM_EXIT_EVENT ||
    sysType === OsEventTypeList.ABNORMAL_EXIT_EVENT
  ) {
    cleanup()
    return
  }

  // On returning from background, refetch active list so the user sees
  // current data (notifications, PR titles, comment counts can all change).
  if (sysType === OsEventTypeList.FOREGROUND_ENTER_EVENT) {
    if (view.kind === 'home' || view.kind === 'pr-list' || view.kind === 'notif-list') {
      void boot()
    }
    return
  }
  if (sysType === OsEventTypeList.FOREGROUND_EXIT_EVENT) {
    return
  }

  const isDoubleTap =
    sysType === OsEventTypeList.DOUBLE_CLICK_EVENT ||
    textType === OsEventTypeList.DOUBLE_CLICK_EVENT ||
    listType === OsEventTypeList.DOUBLE_CLICK_EVENT
  if (isDoubleTap) {
    handleBack()
    return
  }

  if (view.kind === 'comment-detail') {
    if (textType === OsEventTypeList.SCROLL_TOP_EVENT) {
      goToDetailPage(view.page - 1)
      return
    }
    if (
      textType === OsEventTypeList.SCROLL_BOTTOM_EVENT ||
      textType === OsEventTypeList.CLICK_EVENT ||
      sysType === OsEventTypeList.CLICK_EVENT
    ) {
      goToDetailPage(view.page + 1)
      return
    }
    return
  }

  // Lists handle scroll cursor movement internally; we only react to clicks
  // (which carry the selected item index in the list event payload).
  if (event.listEvent && listType === OsEventTypeList.CLICK_EVENT) {
    const idx = event.listEvent.currentSelectItemIndex ?? 0
    handleListClick(idx)
  }
})

function handleListClick(idx: number) {
  if (view.kind === 'home') {
    if (idx === 0) void showNotifList()
    else if (idx === 1) void showPRList('authored')
    else if (idx === 2) void showPRList('review')
    return
  }
  if (view.kind === 'pr-list') {
    const pr = view.prs[idx]
    if (pr) void loadAndShowComments(pr, view.mode)
    return
  }
  if (view.kind === 'notif-list') {
    const notif = view.notifs[idx]
    if (notif) void openNotification(notif)
    return
  }
  if (view.kind === 'comment-list') {
    if (idx === 0) {
      void backFromCommentList(view.cameFrom, view.pr)
    } else {
      const comment = view.comments[idx - 1]
      if (comment) void showCommentDetail(view.pr, view.comments, comment, view.cameFrom)
    }
  }
}

function handleBack() {
  switch (view.kind) {
    case 'home':
    case 'no-token':
    case 'error':
    case 'loading':
      bridge.shutDownPageContainer(1)
      return
    case 'pr-list':
    case 'notif-list':
      void showHome()
      return
    case 'notif-detail':
      void showNotifList()
      return
    case 'comment-list':
      void backFromCommentList(view.cameFrom, view.pr)
      return
    case 'comment-detail':
      void showCommentList(view.pr, view.comments, view.cameFrom)
      return
  }
}

async function backFromCommentList(cameFrom: CameFrom, _pr: PullRequest) {
  if (cameFrom === 'authored') return showPRList('authored')
  if (cameFrom === 'review') return showPRList('review')
  return showNotifList()
}

window.addEventListener('beforeunload', cleanup)

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// ─────────────────────────── companion mirror ───────────────────────────

function mountCompanion() {
  const app = document.querySelector<HTMLDivElement>('#app')!
  app.innerHTML = `
    <main style="margin:auto;padding:20px;max-width:680px;box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,system-ui,sans-serif;display:flex;flex-direction:column;gap:20px;">
      <section id="settings-panel"></section>
      <section id="mirror-section">
        <header style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;gap:12px;">
          <h2 id="title" style="font-size:16px;font-weight:600;margin:0;">GitHub</h2>
          <span id="subtitle" style="font-size:12px;color:#919191;text-align:right;"></span>
        </header>
        <pre id="mirror" style="background:#2E2E2E;border:1px solid #3E3E3E;border-radius:12px;padding:16px;font-size:14px;line-height:1.55;white-space:pre-wrap;word-break:break-word;color:#E5E5E5;margin:0;min-height:160px;"></pre>
        <footer id="footer" style="font-size:12px;color:#7B7B7B;text-align:center;margin-top:12px;"></footer>
      </section>
    </main>
  `
}

function mirrorCompanion() {
  const titleEl = document.getElementById('title')
  const subEl = document.getElementById('subtitle')
  const mirror = document.getElementById('mirror')
  const footer = document.getElementById('footer')

  let title = 'GitHub'
  let sub = ''
  let body = ''
  let foot = ''

  if (view.kind === 'no-token') {
    title = 'GitHub'
    body = 'Set a GitHub token in Settings to begin.'
    foot = 'Glasses: double-tap to exit.'
  } else if (view.kind === 'loading' || view.kind === 'error') {
    body = view.text
    foot = 'Double-tap to exit.'
  } else if (view.kind === 'home') {
    title = cachedIdentity ? `GitHub · @${cachedIdentity.login}` : 'GitHub'
    sub = `${cachedNotifs.length} unread · ${cachedAuthored.length} mine · ${cachedReviews.length} to review`
    body =
      `Notifications  (${cachedNotifs.length})\n` +
      `My PRs         (${cachedAuthored.length})\n` +
      `Review requests (${cachedReviews.length})`
    foot = 'Tap an entry on the glasses · double-tap to exit'
  } else if (view.kind === 'pr-list') {
    title = view.mode === 'authored' ? 'My PRs' : 'Review requests'
    sub = `${view.prs.length} PR${view.prs.length === 1 ? '' : 's'}`
    body =
      view.prs.length === 0 ? '(none)' : view.prs.map(pr => formatPRListItem(pr, true)).join('\n')
    foot = 'Tap to open · double-tap to go back'
  } else if (view.kind === 'notif-list') {
    title = 'Notifications'
    sub = `${view.notifs.length} unread`
    body =
      view.notifs.length === 0
        ? '(no unread notifications)'
        : view.notifs.map(n => formatNotificationListItem(n)).join('\n')
    foot = 'Tap to open · double-tap to go back'
  } else if (view.kind === 'notif-detail') {
    title = view.notif.repoFullName
    sub = `${view.notif.kind} · ${view.notif.reason}`
    body = view.notif.title
    foot = 'Open on github.com · double-tap to go back'
  } else if (view.kind === 'comment-list') {
    title = `${view.pr.repo} #${view.pr.number} ${view.pr.title}`
    const counts = view.comments.reduce(
      (acc, c) => ({
        issue: acc.issue + (c.kind === 'issue' ? 1 : 0),
        review: acc.review + (c.kind === 'review' ? 1 : 0),
        line: acc.line + (c.kind === 'line' ? 1 : 0),
      }),
      { issue: 0, review: 0, line: 0 },
    )
    const parts = []
    if (counts.issue) parts.push(`${counts.issue} conversation`)
    if (counts.review) parts.push(`${counts.review} review${counts.review === 1 ? '' : 's'}`)
    if (counts.line) parts.push(`${counts.line} line`)
    sub = parts.length ? parts.join(' · ') : 'no comments'
    body =
      '← Back\n' +
      (view.comments.length === 0
        ? '(no comments)'
        : view.comments.map(c => formatThreadListItem(c)).join('\n'))
    foot = 'Tap to open · double-tap to go back'
  } else if (view.kind === 'comment-detail') {
    title = `${view.comment.author} on #${view.pr.number}`
    sub = `${view.page + 1} / ${view.pages.length}`
    body = view.pages[view.page] ?? ''
    foot = 'Tap: next · swipe up: prev · double-tap to go back'
  }

  if (titleEl) titleEl.textContent = title
  if (subEl) subEl.textContent = sub
  if (mirror) mirror.textContent = body
  if (footer) footer.textContent = foot
}
