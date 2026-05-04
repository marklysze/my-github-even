import { describe, expect, it } from 'vitest'
import { LIST_ITEM_MAX_BYTES, clipItem } from './github'

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
