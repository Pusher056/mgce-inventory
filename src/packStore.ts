// Every write the pack list inbox makes, in one place, so each one reaches the
// other devices — upload on the PC, pack on the phone — and so every thing he
// can create he can also take back out.

import { db, pushDelete, uuid } from './db'
import { supabase } from './supabase'
import { itemKey } from './packMatch'
import { weekIdOf, weekLabel } from './packWeeks'
import type { ItemAlias, PackFile, PackImport, PackLineState, SyncTable } from './types'

type InboxTable = 'packWeeks' | 'packImports' | 'packPacked' | 'packLineStates' | 'itemAliases' | 'packFiles'

const SERVER: Record<InboxTable, SyncTable> = {
  packWeeks: 'pack_weeks',
  packImports: 'pack_imports',
  packPacked: 'pack_packed',
  packLineStates: 'pack_line_states',
  itemAliases: 'item_aliases',
  packFiles: 'pack_files',
}

async function queue(name: InboxTable, id: string) {
  await db.outbox.add({ table: SERVER[name], id, ts: Date.now() })
}

/** Write a row here and queue it for the other devices. */
export async function putRow<T extends { id: string; updatedAt: number }>(name: InboxTable, row: T) {
  // Un-ticking and re-ticking the same line reuses its id. A delete still
  // waiting for signal would otherwise go through later and take the new tick
  // with it.
  await db.tombstones.delete(row.id)
  await (db[name] as unknown as { put: (r: T) => Promise<unknown> }).put({ ...row, updatedAt: Date.now() })
  await queue(name, row.id)
}

/**
 * Remove rows here and on the server. The tombstone keeps a pull that is
 * already on its way from bringing them straight back.
 */
export async function removeRows(name: InboxTable, ids: string[]) {
  if (ids.length === 0) return
  const table = SERVER[name]
  await (db[name] as unknown as { bulkDelete: (k: string[]) => Promise<void> }).bulkDelete(ids)
  await db.outbox.where('id').anyOf(ids).delete()
  const now = Date.now()
  await db.tombstones.bulkPut(ids.map((id) => ({ id, table, ts: now })))
  for (const id of ids) await pushDelete(table, id)
}

/* ---------- weeks ---------- */

export async function createWeek(startIso: string) {
  const id = weekIdOf(startIso)
  if (await db.packWeeks.get(id)) return
  await putRow('packWeeks', { id, startDate: startIso, label: weekLabel(startIso), createdAt: Date.now(), updatedAt: Date.now() })
}

/** The order he packs this week's events in. */
export async function setWeekOrder(startIso: string, order: string[]) {
  const id = weekIdOf(startIso)
  const week = await db.packWeeks.get(id)
  await putRow('packWeeks', {
    id,
    startDate: startIso,
    label: weekLabel(startIso),
    createdAt: week?.createdAt ?? Date.now(),
    updatedAt: Date.now(),
    order,
  })
}

/** A week and everything dropped into it: the pack lists, the ticks, the pictures. */
export async function deleteWeek(startIso: string) {
  const [imports, packed, states, files] = await Promise.all([
    db.packImports.where('weekStart').equals(startIso).primaryKeys(),
    db.packPacked.where('weekStart').equals(startIso).primaryKeys(),
    db.packLineStates.where('weekStart').equals(startIso).primaryKeys(),
    db.packFiles.where('weekStart').equals(startIso).toArray(),
  ])
  await removeRows('packImports', imports as string[])
  await removeRows('packPacked', packed as string[])
  await removeRows('packLineStates', states as string[])
  await deleteFiles(files)
  await removeRows('packWeeks', [weekIdOf(startIso)])
}

/* ---------- events ---------- */

async function eventRows(weekStart: string, eventKey: string) {
  const [imports, packed, states] = await Promise.all([
    db.packImports.where('eventKey').equals(eventKey).filter((i) => i.weekStart === weekStart).toArray(),
    db.packPacked.where('[weekStart+eventKey]').equals([weekStart, eventKey]).toArray(),
    db.packLineStates.where('[weekStart+eventKey]').equals([weekStart, eventKey]).toArray(),
  ])
  return { imports, packed, states }
}

/** Every version of an event, and what was packed or decided for it. */
export async function deleteEvent(weekStart: string, eventKey: string) {
  const { imports, packed, states } = await eventRows(weekStart, eventKey)
  await removeRows('packImports', imports.map((i) => i.id))
  await removeRows('packPacked', packed.map((p) => p.id))
  await removeRows('packLineStates', states.map((s) => s.id))
}

/** Drop the newest version only — the one before it becomes current again. */
export async function undoVersion(importId: string) {
  await removeRows('packImports', [importId])
}

/**
 * A pack list dropped into the wrong week. Ticks and decisions are keyed by
 * week, so they are re-made under the new one rather than left behind.
 */
export async function moveEvent(fromWeek: string, eventKey: string, toWeek: string) {
  if (fromWeek === toWeek) return
  const { imports, packed, states } = await eventRows(fromWeek, eventKey)
  for (const i of imports) await putRow('packImports', { ...i, weekStart: toWeek })
  for (const p of packed) {
    await putRow('packPacked', { ...p, id: `${toWeek}|${eventKey}|${p.itemKey}`, weekStart: toWeek })
  }
  for (const s of states) {
    await putRow('packLineStates', { ...s, id: `${toWeek}|${eventKey}|${s.itemKey}`, weekStart: toWeek })
  }
  await removeRows('packPacked', packed.map((p) => p.id))
  await removeRows('packLineStates', states.map((s) => s.id))
  await createWeek(toWeek)
}

/* ---------- lines ---------- */

export const lineId = (weekStart: string, eventKey: string, item: string) => `${weekStart}|${eventKey}|${itemKey(item)}`

export async function setPacked(weekStart: string, eventKey: string, item: string, on: boolean) {
  const id = lineId(weekStart, eventKey, item)
  // Packed means the whole amount went out, so a shortage noted on it is over.
  if (on && (await db.packLineStates.get(id))?.onlyHave != null) {
    await setLineState(weekStart, eventKey, item, { onlyHave: null })
  }
  if (on) {
    await putRow('packPacked', { id, weekStart, eventKey, itemKey: itemKey(item), packedAt: Date.now(), updatedAt: Date.now() })
  } else {
    await removeRows('packPacked', [id])
  }
}

/** Not his, removed, or which bottle goes — merged with whatever was decided before. */
export async function setLineState(
  weekStart: string,
  eventKey: string,
  item: string,
  patch: Partial<Pick<PackLineState, 'status' | 'productId' | 'onlyHave'>>,
) {
  const id = lineId(weekStart, eventKey, item)
  const prev = await db.packLineStates.get(id)
  const next: PackLineState = {
    id,
    weekStart,
    eventKey,
    itemKey: itemKey(item),
    status: prev?.status ?? '',
    productId: prev?.productId ?? null,
    onlyHave: prev?.onlyHave ?? null,
    updatedAt: Date.now(),
    ...patch,
  }
  // Nothing left to remember: drop the row instead of keeping an empty one.
  const hasShort = next.onlyHave !== null && next.onlyHave !== undefined
  if (!next.status && !next.productId && !hasShort) await removeRows('packLineStates', [id])
  else await putRow('packLineStates', next)
}

/* ---------- same / not the same ---------- */

export async function decidePair(a: string, b: string, kind: ItemAlias['kind']) {
  const existing = await db.itemAliases
    .filter((x) => {
      if (x.kind !== 'same' && x.kind !== 'different') return false
      const pa = itemKey(x.alias)
      const pb = itemKey(x.canonical)
      return (pa === itemKey(a) && pb === itemKey(b)) || (pa === itemKey(b) && pb === itemKey(a))
    })
    .toArray()
  await removeRows('itemAliases', existing.map((x) => x.id))
  await putRow('itemAliases', { id: uuid(), alias: a, canonical: b, kind, createdAt: Date.now(), updatedAt: Date.now() })
}

/**
 * "When they write this, send that." Remembered for every event after, so the
 * question is asked once — replacing whatever was chosen for it before.
 */
export async function decideUse(item: string, productId: string) {
  const key = itemKey(item)
  const old = await db.itemAliases.filter((x) => x.kind === 'use' && itemKey(x.alias) === key).toArray()
  await removeRows('itemAliases', old.map((x) => x.id))
  await putRow('itemAliases', { id: uuid(), alias: item, canonical: productId, kind: 'use' as const, createdAt: Date.now(), updatedAt: Date.now() })
}

/**
 * Whose it is, learned. `key` is an item name, or a section key ("§BAR NEEDS")
 * for the whole section. Replaces whatever was said about it before.
 */
export async function decideOwner(key: string, kind: 'mine' | 'notMine' | 'ask') {
  const isSection = key.startsWith('§')
  const k = isSection ? key : itemKey(key)
  const old = await db.itemAliases
    .filter(
      (x) =>
        (x.kind === 'mine' || x.kind === 'notMine' || x.kind === 'ask') &&
        (isSection ? x.alias === k : !x.alias.startsWith('§') && itemKey(x.alias) === k),
    )
    .toArray()
  await removeRows('itemAliases', old.map((x) => x.id))
  await putRow('itemAliases', { id: uuid(), alias: key, canonical: '', kind, createdAt: Date.now(), updatedAt: Date.now() })
}

/** "That's not a drink" / "that one is" — for the week's drink totals. */
export async function decideDrink(item: string, kind: 'drink' | 'notDrink') {
  const k = itemKey(item)
  const old = await db.itemAliases
    .filter((x) => (x.kind === 'drink' || x.kind === 'notDrink') && itemKey(x.alias) === k)
    .toArray()
  await removeRows('itemAliases', old.map((x) => x.id))
  await putRow('itemAliases', { id: uuid(), alias: item, canonical: '', kind, createdAt: Date.now(), updatedAt: Date.now() })
}

export async function undoPair(id: string) {
  await removeRows('itemAliases', [id])
}

/* ---------- files ---------- */

export async function addFile(file: File, kind: PackFile['kind'], weekStart: string) {
  await putRow('packFiles', {
    id: uuid(),
    weekStart,
    eventKey: '',
    filename: file.name,
    kind,
    blob: file,
    path: null,
    uploaded: 0 as const,
    addedAt: Date.now(),
    updatedAt: Date.now(),
  })
}

export async function deleteFiles(files: PackFile[]) {
  const paths = files.map((f) => f.path).filter((p): p is string => !!p)
  // Best effort: an orphaned file in storage costs nothing he can see, a row
  // that will not go away does.
  if (paths.length > 0) await supabase.storage.from('pack-files').remove(paths).catch(() => undefined)
  await removeRows('packFiles', files.map((f) => f.id))
}

/** The bytes, from here if we have them, from storage the first time otherwise. */
export async function fileBlob(f: PackFile): Promise<Blob | null> {
  if (f.blob) return f.blob
  if (!f.path) return null
  const { data, error } = await supabase.storage.from('pack-files').download(f.path)
  if (error || !data) return null
  // Cached without touching updatedAt: fetching is not an edit.
  await db.packFiles.update(f.id, { blob: data })
  return data
}

/** New version of an event, or its first. */
export async function saveImport(rec: PackImport): Promise<'added' | 'updated'> {
  const existing = await db.packImports.where('eventKey').equals(rec.eventKey).count()
  await putRow('packImports', rec)
  return existing > 0 ? 'updated' : 'added'
}
