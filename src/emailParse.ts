// Reads a saved email — the .eml you get by dragging a message out of Outlook —
// into its text and its attachments, so a pack list can be pulled straight out
// of the message it arrived in.

export interface EmailAttachment {
  filename: string
  bytes: Uint8Array
}

export interface ParsedEmail {
  subject: string
  from: string
  date: string
  /** The message the planner actually typed, headers and quoting stripped. */
  body: string
  attachments: EmailAttachment[]
}

function decodeHeaderWord(s: string): string {
  // =?utf-8?B?...?= and =?utf-8?Q?...?= as used for accents in subjects
  return s.replace(/=\?([^?]+)\?([BQ])\?([^?]*)\?=/gi, (_m, charset: string, enc: string, data: string) => {
    try {
      const bytes =
        enc.toUpperCase() === 'B'
          ? Uint8Array.from(atob(data), (c) => c.charCodeAt(0))
          : Uint8Array.from(
              data.replace(/_/g, ' ').replace(/=([0-9A-F]{2})/gi, (_x, h: string) => String.fromCharCode(parseInt(h, 16))),
              (c) => c.charCodeAt(0),
            )
      return new TextDecoder(charset.toLowerCase()).decode(bytes)
    } catch {
      return data
    }
  })
}

function decodeQuotedPrintable(s: string): string {
  return s
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-F]{2})/gi, (_m, h: string) => String.fromCharCode(parseInt(h, 16)))
}

function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/\s+/g, '')
  const bin = atob(clean)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&rsquo;/g, "'")
    .replace(/&quot;|&ldquo;|&rdquo;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

interface Part {
  headers: Record<string, string>
  body: string
}

function splitHeaders(chunk: string): Part {
  const idx = chunk.search(/\r?\n\r?\n/)
  const rawHeaders = idx < 0 ? chunk : chunk.slice(0, idx)
  const body = idx < 0 ? '' : chunk.slice(idx).replace(/^\r?\n\r?\n/, '')
  const headers: Record<string, string> = {}
  // headers can wrap onto continuation lines that start with whitespace
  for (const line of rawHeaders.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const m = /^([\w-]+):\s*(.*)$/.exec(line)
    if (m) headers[m[1].toLowerCase()] = m[2]
  }
  return { headers, body }
}

function walk(part: Part, out: { text: string[]; html: string[]; atts: EmailAttachment[] }) {
  // Kept raw for anything case-sensitive: boundaries and filenames are, the
  // media type is not.
  const rawType = part.headers['content-type'] ?? 'text/plain'
  const type = rawType.toLowerCase()
  const encoding = (part.headers['content-transfer-encoding'] ?? '').toLowerCase()
  const disposition = part.headers['content-disposition'] ?? ''

  if (type.startsWith('multipart/')) {
    const boundary = /boundary="?([^";]+)"?/i.exec(rawType)?.[1]
    if (!boundary) return
    const chunks = part.body.split(new RegExp(`--${boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:--)?\\r?\\n?`))
    for (const chunk of chunks.slice(1)) {
      if (!chunk.trim()) continue
      walk(splitHeaders(chunk), out)
    }
    return
  }

  const nameMatch = /filename\*?="?([^";]+)"?/i.exec(disposition) || /name="?([^";]+)"?/i.exec(rawType)
  const filename = nameMatch ? decodeHeaderWord(nameMatch[1]) : ''

  if (filename || disposition.toLowerCase().startsWith('attachment')) {
    if (encoding === 'base64') {
      try {
        out.atts.push({ filename: filename || 'attachment', bytes: base64ToBytes(part.body) })
      } catch {
        /* unreadable attachment — the rest of the message is still useful */
      }
    }
    return
  }

  const decoded =
    encoding === 'base64'
      ? new TextDecoder().decode(base64ToBytes(part.body))
      : encoding === 'quoted-printable'
        ? decodeQuotedPrintable(part.body)
        : part.body

  if (type.startsWith('text/html')) out.html.push(decoded)
  else out.text.push(decoded)
}

/** Everything below this is the thread they replied on, not what they wrote. */
export function trimQuoted(body: string): string {
  // Outlook writes CRLF; leaving the carriage returns in makes the text look
  // right in one browser and doubled in another.
  const text = body.replace(/\r\n?/g, '\n')
  const cut = text.search(/\n\s*(-{3,}\s*Original Message|From:\s.+\nSent:|On .+ wrote:|_{10,})/i)
  return (cut > 0 ? text.slice(0, cut) : text).trim()
}

export function parseEml(raw: string): ParsedEmail {
  const root = splitHeaders(raw)
  const out = { text: [] as string[], html: [] as string[], atts: [] as EmailAttachment[] }
  walk(root, out)
  const body = out.text.join('\n').trim() || stripHtml(out.html.join('\n'))
  return {
    subject: decodeHeaderWord(root.headers['subject'] ?? ''),
    from: decodeHeaderWord(root.headers['from'] ?? ''),
    date: root.headers['date'] ?? '',
    body: trimQuoted(body),
    attachments: out.atts,
  }
}

export const isSpreadsheet = (name: string) => /\.(xls|xlsx|xlsm)$/i.test(name)
