// Reads a .msg — the file you get when you drag a message out of Outlook on
// Windows. It looks like one file in the folder, which is why the spreadsheets
// seem to disappear: the workbook is not next to the message, it is inside it.
//
// A .msg is an OLE compound file: a little filesystem of its own. Each property
// is a stream named __substg1.0_<id><type>, and every attachment is a folder
// named __attach_version1.0_#0000000N holding its filename and its bytes. The
// same container format as their old .xls files, so the reader is already here.

import { stripHtml, trimQuoted, type EmailAttachment, type ParsedEmail } from './emailParse'

interface CfbEntry {
  name: string
  type: number
  content: unknown
}

interface CfbFile {
  FullPaths: string[]
  FileIndex: CfbEntry[]
}

/** The slice of SheetJS we need: it ships the compound-file reader. */
export interface CfbApi {
  read: (data: Uint8Array, opts: { type: 'array' }) => CfbFile
}

// Property ids, from the message format. Only the ones worth reading.
const SUBJECT = '0037'
const BODY = '1000'
const BODY_HTML = '1013'
const SENDER_NAME = '0c1a'
const SENDER_SMTP = '5d01'
const SENDER_ADDR = '0c1f'
const SENT_ON = '0039'
const ATTACH_LONG_NAME = '3707'
const ATTACH_SHORT_NAME = '3704'
const ATTACH_DATA = '3701'

function bytesOf(content: unknown): Uint8Array {
  if (content instanceof Uint8Array) return content
  if (Array.isArray(content)) return Uint8Array.from(content as number[])
  return new Uint8Array(0)
}

function decodeText(bytes: Uint8Array, type: string): string {
  // 001F is the unicode flavour of a string property, 001E the old one. Outlook
  // writes both depending on how the message was made.
  const charset = type === '001f' ? 'utf-16le' : 'windows-1252'
  try {
    return new TextDecoder(charset).decode(bytes).replace(/\0+$/, '')
  } catch {
    let out = ''
    for (const b of bytes) out += String.fromCharCode(b)
    return out
  }
}

/** FILETIME: 100-nanosecond ticks since 1601, which is not how anyone writes a date. */
function decodeTime(bytes: Uint8Array): string {
  if (bytes.length < 8) return ''
  const view = new DataView(bytes.buffer, bytes.byteOffset, 8)
  const ticks = view.getUint32(0, true) + view.getUint32(4, true) * 2 ** 32
  if (!ticks) return ''
  const ms = ticks / 10000 - 11644473600000
  const d = new Date(ms)
  return Number.isNaN(d.getTime()) ? '' : d.toISOString()
}

interface Prop {
  type: string
  bytes: Uint8Array
}

/** Every property stream, filed under the folder it lives in. */
function indexProps(cfb: CfbFile): Map<string, Map<string, Prop>> {
  const byDir = new Map<string, Map<string, Prop>>()
  cfb.FullPaths.forEach((path, i) => {
    const entry = cfb.FileIndex[i]
    if (!entry || entry.type !== 2) return
    const slash = path.lastIndexOf('/')
    const dir = path.slice(0, slash + 1)
    const name = path.slice(slash + 1)
    const m = /^__substg1\.0_([0-9A-Fa-f]{4})([0-9A-Fa-f]{4})$/.exec(name)
    if (!m) return
    const props = byDir.get(dir) ?? new Map<string, Prop>()
    props.set(m[1].toLowerCase(), { type: m[2].toLowerCase(), bytes: bytesOf(entry.content) })
    byDir.set(dir, props)
  })
  return byDir
}

const str = (props: Map<string, Prop> | undefined, id: string): string => {
  const p = props?.get(id)
  return p ? decodeText(p.bytes, p.type).trim() : ''
}

/**
 * Pull a saved Outlook message apart into its text and its attachments.
 *
 * `CFB` is SheetJS's compound-file reader, passed in so the spreadsheet engine
 * stays a lazy import rather than weight on every screen.
 */
export function parseMsg(bytes: Uint8Array, CFB: CfbApi): ParsedEmail {
  const cfb = CFB.read(bytes, { type: 'array' })
  const byDir = indexProps(cfb)
  const rootDir = cfb.FullPaths[0] ?? 'Root Entry/'
  const root = byDir.get(rootDir)

  let body = str(root, BODY)
  if (!body) {
    const html = root?.get(BODY_HTML)
    // The HTML body is stored as raw bytes even when it is plainly text.
    if (html) body = stripHtml(decodeText(html.bytes, html.type === '001f' ? '001f' : '001e'))
  }

  const name = str(root, SENDER_NAME)
  const addr = str(root, SENDER_SMTP) || str(root, SENDER_ADDR)
  const from = name && addr ? `${name} <${addr}>` : name || addr

  const sent = root?.get(SENT_ON)
  const date = sent ? (sent.type === '0040' ? decodeTime(sent.bytes) : decodeText(sent.bytes, sent.type)) : ''

  const attachments: EmailAttachment[] = []
  for (const [dir, props] of byDir) {
    if (!/__attach_version1\.0_#[0-9A-Fa-f]+\/$/.test(dir)) continue
    const data = props.get(ATTACH_DATA)
    // 0102 is a real file. 000D is a message attached to a message, which has
    // no bytes of its own — nothing to hand the spreadsheet reader.
    if (!data || data.type !== '0102' || data.bytes.length === 0) continue
    attachments.push({
      filename: str(props, ATTACH_LONG_NAME) || str(props, ATTACH_SHORT_NAME) || 'attachment',
      bytes: data.bytes,
    })
  }

  return {
    subject: str(root, SUBJECT),
    from,
    date,
    body: trimQuoted(body),
    attachments,
  }
}
