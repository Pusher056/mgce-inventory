import { useMemo, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, uuid } from '../db'
import { diffPackLists, type ParsedPackList } from '../packlistParse'
import { parseEml, isSpreadsheet } from '../emailParse'
import { parseMsg } from '../msgParse'
import { displayName, totalBottles, type PackImport } from '../types'
import { plain } from './ProductSearch'

const eventKeyOf = (name: string) => plain(name).replace(/[^a-z0-9]+/g, ' ').trim()

/**
 * Drop the emails in, get the week back.
 *
 * Reads their pack list workbooks — both layouts — plus the message they came
 * in, because half of what they ask for is typed in the email and never makes
 * it into the spreadsheet. A second version of the same event is compared
 * against the first instead of replacing it.
 */
export default function PackInbox() {
  const imports = useLiveQuery(() => db.packImports.orderBy('importedAt').reverse().toArray(), []) ?? []
  const products = useLiveQuery(() => db.products.toArray(), []) ?? []
  const entries = useLiveQuery(() => db.entries.toArray(), []) ?? []
  const fileRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [problems, setProblems] = useState<string[]>([])
  const [open, setOpen] = useState<string | null>(null)

  /** Bottles on the shelf, by product. */
  const stock = useMemo(() => {
    const perCase = new Map(products.map((p) => [p.id, p.unitsPerCase]))
    const total = new Map<string, number>()
    for (const e of entries) {
      total.set(e.productId, (total.get(e.productId) ?? 0) + totalBottles(e, perCase.get(e.productId) ?? 12))
    }
    return total
  }, [products, entries])

  const shelf = useMemo(
    () =>
      products
        .filter((p) => stock.has(p.id))
        .map((p) => ({ text: plain(`${p.brand ?? ''} ${displayName(p) || p.name}`), n: stock.get(p.id) ?? 0 })),
    [products, stock],
  )

  /** Rough name match against the inventory, so "do we have this?" is answered. */
  function onShelf(item: string): number | null {
    const needle = plain(item).replace(/\(.*?\)/g, '').trim()
    if (needle.length < 4) return null
    const hit = shelf.find((s) => s.text.includes(needle) || needle.includes(s.text))
    return hit ? hit.n : null
  }

  /** Newest import per event, and the one before it. */
  const byEvent = useMemo(() => {
    const map = new Map<string, PackImport[]>()
    for (const imp of imports) {
      const list = map.get(imp.eventKey) ?? []
      list.push(imp)
      map.set(imp.eventKey, list)
    }
    return [...map.values()].map((list) => ({ latest: list[0], previous: list[1], versions: list.length }))
  }, [imports])

  async function ingest(files: File[]) {
    setBusy(true)
    setProblems([])
    const trouble: string[] = []
    try {
      const XLSX = await import('xlsx')
      const { parsePackList } = await import('../packlistParse')

      for (const file of files) {
        const name = file.name
        try {
          let email = { subject: '', from: '', body: '' }
          const books: { filename: string; bytes: Uint8Array }[] = []

          if (/\.eml$/i.test(name) || /\.msg$/i.test(name)) {
            const mail = /\.msg$/i.test(name)
              ? parseMsg(new Uint8Array(await file.arrayBuffer()), XLSX.CFB)
              : parseEml(await file.text())
            email = { subject: mail.subject, from: mail.from, body: mail.body }
            books.push(...mail.attachments.filter((a) => isSpreadsheet(a.filename)))
            if (books.length === 0) {
              trouble.push(
                mail.attachments.length > 0
                  ? `${name}: nothing attached but ${mail.attachments.map((a) => a.filename).join(', ')}`
                  : `${name}: the message has no attachment`,
              )
            }
          } else if (/\.(jpe?g|png|heic|heif|webp|gif|pdf)$/i.test(name)) {
            // A photograph of a pack list is not a pack list: there are no
            // numbers in it to read. Say so here rather than leave him
            // wondering why nothing appeared.
            trouble.push(`${name}: a photo or PDF can't be read yet — send the Excel or the message itself`)
            continue
          } else if (isSpreadsheet(name)) {
            books.push({ filename: name, bytes: new Uint8Array(await file.arrayBuffer()) })
          } else {
            trouble.push(`${name}: not a pack list or an email`)
            continue
          }

          for (const book of books) {
            const parsed: ParsedPackList = parsePackList(XLSX.read(book.bytes, { type: 'array' }), XLSX)
            if (!parsed.eventName && parsed.lines.length === 0) {
              trouble.push(`${book.filename}: no event and no items found — is it a pack list?`)
              continue
            }
            const rec: PackImport = {
              id: uuid(),
              eventKey: eventKeyOf(parsed.eventName || book.filename),
              filename: book.filename,
              eventName: parsed.eventName || book.filename,
              eventDate: parsed.eventDate,
              venue: parsed.venue,
              planner: parsed.planner,
              guestCount: parsed.guestCount,
              iceNeeds: parsed.iceNeeds,
              kitchenPickup: parsed.kitchenPickup,
              kitchenDelivery: parsed.kitchenDelivery,
              emailSubject: email.subject,
              emailFrom: email.from,
              emailBody: email.body,
              lines: parsed.lines,
              importedAt: Date.now(),
            }
            await db.packImports.add(rec)
          }
        } catch (err) {
          trouble.push(`${name}: could not be read (${err instanceof Error ? err.message : 'unknown'})`)
        }
      }
    } catch (err) {
      // Anything that goes wrong before the loop — loading the spreadsheet
      // engine, say — used to fail silently and look like nothing happened.
      trouble.push(`Could not start reading: ${err instanceof Error ? err.message : 'unknown error'}`)
    } finally {
      setProblems(trouble)
      setBusy(false)
    }
  }

  const toBuy = useMemo(() => {
    const out: { item: string; qty: string; event: string }[] = []
    for (const { latest } of byEvent) {
      for (const l of latest.lines) {
        if (!/BEVERAGE|LIQUOR|WINE|BEER/i.test(l.section)) continue
        if (onShelf(l.item) === null || (onShelf(l.item) ?? 0) === 0) {
          out.push({ item: l.item, qty: l.qty, event: latest.eventName })
        }
      }
    }
    return out
  }, [byEvent, shelf])

  return (
    <div className="screen">
      <p className="lp-intro">
        Drop the pack lists here — the spreadsheets on their own, or whole messages dragged out of
        Outlook on either computer. The workbook travels inside the message, so the message alone
        is enough. A second version of the same event is compared against the first.
      </p>

      <input
        ref={fileRef}
        type="file"
        multiple
        // Extensions alone grey out half the files on an iPhone, so the media
        // types go in too — and photos are allowed through to the picker so
        // that choosing one gets an answer instead of a dead button.
        accept=".xls,.xlsx,.xlsm,.eml,.msg,application/vnd.ms-outlook,message/rfc822,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,image/*"
        style={{ display: 'none' }}
        onChange={(e) => {
          // Copy first: a FileList is live, and clearing the input so the same
          // files can be dropped again empties the very list being read.
          const picked = Array.from(e.target.files ?? [])
          e.target.value = ''
          if (picked.length) void ingest(picked)
        }}
      />
      <button className="big-btn primary" disabled={busy} onClick={() => fileRef.current?.click()}>
        {busy ? 'Reading…' : '📥 Drop in pack lists or emails'}
      </button>

      {problems.length > 0 && (
        <div className="inbox-problems">
          {problems.map((p, i) => (
            <div key={i}>⚠ {p}</div>
          ))}
        </div>
      )}

      {byEvent.length > 0 && (
        <div className="lp-stats" style={{ marginTop: 18 }}>
          <div className="lp-stat">
            <b>{byEvent.length}</b>
            <span>events read</span>
          </div>
          <div className="lp-stat">
            <b>{byEvent.reduce((s, e) => s + e.latest.lines.length, 0)}</b>
            <span>lines requested</span>
          </div>
          <div className="lp-stat">
            <b>{toBuy.length}</b>
            <span>drinks not on the shelf</span>
          </div>
          <div className="lp-stat">
            <b>{byEvent.filter((e) => e.previous).length}</b>
            <span>events with a newer version</span>
          </div>
        </div>
      )}

      {byEvent.map(({ latest, previous, versions }) => {
        const changes = previous ? diffPackLists(previous.lines, latest.lines) : []
        const isOpen = open === latest.eventKey
        return (
          <div className="lp-block" key={latest.eventKey}>
            <button className="lp-head" onClick={() => setOpen(isOpen ? null : latest.eventKey)}>
              <span className="caret">{isOpen ? '▼' : '▶'}</span>
              <span className="lp-title">{latest.eventName}</span>
              <span className="lp-count">
                {latest.lines.length} lines
                {versions > 1 && ` · v${versions}`}
              </span>
            </button>

            {changes.length > 0 && (
              <div className="inbox-changes">
                <div className="inbox-changes-title">Changed since the last version</div>
                {changes.map((c, i) => (
                  <div key={i} className={`inbox-change ${c.kind}`}>
                    {c.kind === 'added' && `＋ ${c.item} — ${c.to}`}
                    {c.kind === 'removed' && `− ${c.item} — no longer wanted`}
                    {c.kind === 'changed' && `↕ ${c.item} — ${c.from} → ${c.to}`}
                  </div>
                ))}
              </div>
            )}

            {latest.emailBody && (
              <div className="inbox-email">
                <div className="inbox-email-title">
                  What they wrote{latest.emailFrom && ` · ${latest.emailFrom}`}
                </div>
                <div className="inbox-email-body">{latest.emailBody}</div>
              </div>
            )}

            {isOpen && (
              <div className="lp-rows">
                <div className="lp-row">
                  <div className="lp-cat">Details</div>
                  <div className="lp-main">
                    <div className="lp-note">
                      {[
                        latest.eventDate,
                        latest.venue,
                        latest.guestCount && `${latest.guestCount} guests`,
                        latest.planner,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </div>
                    {(latest.iceNeeds || latest.kitchenPickup || latest.kitchenDelivery) && (
                      <div className="lp-note">
                        Ice: {latest.iceNeeds || '—'} · Pickup: {latest.kitchenPickup || '—'} · Delivery:{' '}
                        {latest.kitchenDelivery || '—'}
                      </div>
                    )}
                  </div>
                </div>

                {latest.lines.map((l, i) => {
                  const have = onShelf(l.item)
                  const drink = /BEVERAGE|LIQUOR|WINE|BEER/i.test(l.section)
                  return (
                    <div className="lp-row" key={i}>
                      <div className="lp-cat">{l.section}</div>
                      <div className="lp-main">
                        <div className="lp-brand">{l.item}</div>
                        {(l.size || l.note) && (
                          <div className="lp-note">{[l.size, l.note].filter(Boolean).join(' · ')}</div>
                        )}
                      </div>
                      <div className="lp-right">
                        <div className="lp-price">{l.qty}</div>
                        {drink &&
                          (have === null ? (
                            <span className="lp-chip act">not in inventory</span>
                          ) : have === 0 ? (
                            <span className="lp-chip act">none left</span>
                          ) : (
                            <span className="lp-chip ok">{have} in stock</span>
                          ))}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )
      })}

      {imports.length === 0 && !busy && (
        <div className="muted" style={{ textAlign: 'center', marginTop: 40, lineHeight: 1.6 }}>
          Nothing read yet.
          <br />
          Drop this week&rsquo;s pack lists in 👆
        </div>
      )}

      {imports.length > 0 && (
        <button
          className="chip-btn"
          style={{ marginTop: 18 }}
          onClick={async () => {
            if (window.confirm('Clear everything read so far? The emails and files are untouched.')) {
              await db.packImports.clear()
            }
          }}
        >
          Clear what has been read
        </button>
      )}

      <div className="inbox-how">
        <div className="inbox-how-title">How to get the messages out of Outlook</div>
        <div>
          <b>Windows</b> — select the emails and drag them onto a folder on the desktop. You get one
          file per message and nothing else; that is normal. The Excel is inside each one and this
          screen opens it.
        </div>
        <div>
          <b>Mac</b> — same drag, same result.
        </div>
        <div>
          <b>iPhone</b> — open the email in Outlook, tap the attachment, then Share ▸ Save to Files.
          Pick it here afterwards. A photo of the screen has no numbers in it to read.
        </div>
      </div>

      <p className="lp-foot">
        What you drop here stays on this device — it is a way of reading the week, not shared data.
      </p>
    </div>
  )
}
