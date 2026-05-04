import { describe, expect, it } from 'vitest'
import { LIST_ITEM_MAX_BYTES, clipItem, sanitizeBody } from './github'

const utf8 = new TextEncoder()
const bytes = (s: string) => utf8.encode(s).length

describe('clipItem', () => {
  it('returns short ASCII unchanged', () => {
    expect(clipItem('hello')).toBe('hello')
  })

  it('returns string at the byte limit unchanged', () => {
    const s = 'a'.repeat(LIST_ITEM_MAX_BYTES)
    expect(bytes(s)).toBe(LIST_ITEM_MAX_BYTES)
    expect(clipItem(s)).toBe(s)
  })

  it('clips one byte over the limit and appends an ellipsis', () => {
    const s = 'a'.repeat(LIST_ITEM_MAX_BYTES + 1)
    const out = clipItem(s)
    expect(out.endsWith('…')).toBe(true)
    expect(bytes(out)).toBeLessThanOrEqual(LIST_ITEM_MAX_BYTES)
  })

  // The case CLAUDE.md calls out: a 64-char string with two `·` (2 bytes
  // each) and one `…` (3 bytes) is 68 bytes — would silently fail to
  // render if not pre-clipped.
  it('clips multibyte glyphs by byte count, not char count', () => {
    const s = 'repo · #1234 · ' + 'x'.repeat(60) + '…'
    expect(bytes(s)).toBeGreaterThan(LIST_ITEM_MAX_BYTES)
    const out = clipItem(s)
    expect(bytes(out)).toBeLessThanOrEqual(LIST_ITEM_MAX_BYTES)
    expect(out.endsWith('…')).toBe(true)
  })

  it('handles 3-byte CJK characters', () => {
    const s = '日'.repeat(30) // 90 bytes
    expect(bytes(s)).toBe(90)
    const out = clipItem(s)
    expect(bytes(out)).toBeLessThanOrEqual(LIST_ITEM_MAX_BYTES)
    expect(out.endsWith('…')).toBe(true)
  })

  it('handles 4-byte emoji without producing invalid UTF-8', () => {
    const s = '🎉'.repeat(20) // 80 bytes
    const out = clipItem(s)
    expect(bytes(out)).toBeLessThanOrEqual(LIST_ITEM_MAX_BYTES)
    expect(out.endsWith('…')).toBe(true)
  })

  it('returns empty string unchanged', () => {
    expect(clipItem('')).toBe('')
  })

  it('never produces a result longer than the byte limit', () => {
    const cases = [
      'a'.repeat(1000),
      '·'.repeat(500),
      '日'.repeat(500),
      '🎉'.repeat(500),
      'mixed · 日本 🎉 ' + 'x'.repeat(200),
    ]
    for (const s of cases) {
      expect(bytes(clipItem(s))).toBeLessThanOrEqual(LIST_ITEM_MAX_BYTES)
    }
  })
})

describe('sanitizeBody', () => {
  it('strips markdown link reference definitions', () => {
    const s = '[vc]: #abc123==:eyJpc01vbm9yZXBvIjp0cnVlfQ==\nhello'
    expect(sanitizeBody(s)).toBe('hello')
  })

  it('replaces markdown images with their alt text', () => {
    expect(sanitizeBody('see ![Ready](https://x.com/r.svg) status')).toBe('see Ready status')
  })

  it('uses [image] when markdown image alt is empty', () => {
    expect(sanitizeBody('![](https://x.com/y.png)')).toBe('[image]')
  })

  it('keeps the text of markdown links', () => {
    expect(sanitizeBody('Learn more about [Vercel for GitHub](https://vercel.link/x).')).toBe(
      'Learn more about Vercel for GitHub.',
    )
  })

  it('drops self-closing HTML media tags entirely', () => {
    expect(sanitizeBody('a<br/>b<img src="x.png"/>c')).toBe('abc')
  })

  it('strips wrapping HTML tags but keeps inner text', () => {
    expect(sanitizeBody('<a href="x"><b>click</b> me</a>')).toBe('click me')
  })

  it('collapses runs of blank lines created by stripping', () => {
    const s = 'top\n\n\n\n\nbottom'
    expect(sanitizeBody(s)).toBe('top\n\nbottom')
  })

  it('handles the Vercel bot fixture without leaking media or HTML', () => {
    const vercel = [
      '[vc]: #W5EMQhxOwwEGNhYCv07QmSQPy7qaB5Z2C2ZC9ukI52Y=:eyJpc01vbm9yZXBvIjp0cnVlfQ==',
      'The latest updates on your projects. Learn more about [Vercel for GitHub](https://vercel.link/github-learn-more).',
      '',
      '| Project | Deployment | Actions | Updated (UTC) |',
      '| :--- | :----- | :------ | :------ |',
      '| [apps](https://vercel.com/x/apps) | ![Ready](https://vercel.com/static/status/ready.svg) [Ready](https://vercel.com/x/apps/y) | [Preview](https://apps-x.vercel.app), [Comment](https://vercel.live/x) | Apr 23, 2026 5:09am |',
      '',
      '<a href="https://vercel.com/x"><picture><source media="(prefers-color-scheme: dark)" srcset="https://x.svg"><source media="(prefers-color-scheme: light)" srcset="https://y.svg"><img src="https://z.svg" alt="Request Review"></picture></a>',
    ].join('\n')

    const out = sanitizeBody(vercel)

    expect(out).not.toMatch(/\[vc\]:/)
    expect(out).not.toMatch(/!\[/)
    expect(out).not.toMatch(/<[a-z]/i)
    expect(out).not.toMatch(/https?:\/\//) // every URL was inside a markdown/HTML construct
    expect(out).toContain('Vercel for GitHub')
    expect(out).toContain('Ready')
    expect(out).toContain('apps')
  })
})
