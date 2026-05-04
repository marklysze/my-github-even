import { measureTextWrap } from '@evenrealities/pretext'

// Splits long text into page-sized chunks using pretext's pixel-accurate
// glyph measurements — the same ones LVGL uses on the G2 firmware. Pages
// fill the container without clipping or leaving large empty gaps, and
// switching font size or container dimensions just works.
//
// Pass the container's *inner* box (width/height minus padding and border).
// Line height is a fixed 27px in EvenHub's LVGL build.

const LINE_HEIGHT = 27

export interface PaginateBox {
  width: number
  height: number
}

export function paginate(source: string, box: PaginateBox): string[] {
  const maxLines = Math.max(1, Math.floor(box.height / LINE_HEIGHT))
  const paragraphs = source.split(/\n{2,}/).map(p => p.trim()).filter(Boolean)

  const pages: string[] = []
  let buffer: string[] = []
  let bufferLines = 0

  const flush = () => {
    if (!buffer.length) return
    pages.push(buffer.join('\n\n'))
    buffer = []
    bufferLines = 0
  }

  for (const para of paragraphs) {
    const paraLines = measureTextWrap(para, box.width).lineCount

    if (paraLines > maxLines) {
      flush()
      for (const chunk of splitParagraph(para, box.width, maxLines)) {
        pages.push(chunk)
      }
      continue
    }

    // +1 line for the blank between two paragraphs on the same page.
    const cost = paraLines + (buffer.length ? 1 : 0)
    if (bufferLines + cost > maxLines) {
      flush()
      buffer.push(para)
      bufferLines = paraLines
    } else {
      buffer.push(para)
      bufferLines += cost
    }
  }
  flush()
  return pages
}

function splitParagraph(text: string, width: number, maxLines: number): string[] {
  const tokens = text.split(/(\s+)/)
  const chunks: string[] = []
  let current = ''

  for (const token of tokens) {
    const candidate = current + token
    const { lineCount } = measureTextWrap(candidate, width)
    if (lineCount > maxLines && current.trim()) {
      chunks.push(current.trim())
      current = token.replace(/^\s+/, '')
    } else {
      current = candidate
    }
  }
  if (current.trim()) chunks.push(current.trim())
  return chunks
}
