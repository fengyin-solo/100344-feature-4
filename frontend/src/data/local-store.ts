import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'forest-fire-patrol:entries'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    return { ...fallback, ...parsed }
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: Record<string, EntryRow[]> | null = null

// 另一个标签页落库后，本页持有的内存快照就过期了，先作废重读，
// 这样并发操作同一记录时能看到对方先写入的状态。
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key === STORAGE_KEY) {
      cache = null
    }
  })
}

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

function persist(next: Record<string, EntryRow[]>): void {
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

export function saveRows(key: string, rows: EntryRow[]): void {
  persist({ ...allRows(), [key]: rows })
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

function readRaw(): Record<string, EntryRow[]> {
  // 提交前直接读 localStorage，不信内存缓存：另一个标签页可能已经先落库，
  // 而本页的 storage 事件未必已经送达。这是并发场景下 compare-and-set 的依据。
  if (typeof window === 'undefined' || !window.localStorage) {
    return allRows()
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (raw) {
    try {
      return { ...clone(SEED_ROWS), ...(JSON.parse(raw) as Record<string, EntryRow[]>) }
    } catch {
      // 落库数据损坏时退回内存快照，由正常读写流程修复。
    }
  }
  return allRows()
}

// 按编号提交单条记录的更新；expectedStatus 非空时做 compare-and-set：
// 只有记录当前仍是期望状态才落库，否则视为被并发改动抢先，提交失败。
// 并发关闭同一瞭望台时，先落库的一次改了状态，后到的一次就会被挡下。
export function commitRow(
  key: string,
  id: number,
  expectedStatus: string | null,
  patch: EntryRow,
): { ok: true; row: EntryRow } | { ok: false; reason: 'missing' | 'conflict'; current: string | null } {
  const snapshot = readRaw()
  const rows = snapshot[key] ?? []
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, reason: 'missing', current: null }
  }
  const currentStatus = String(rows[index].status)
  if (expectedStatus !== null && currentStatus !== expectedStatus) {
    // 落库状态与读到的不一致，说明已被并发操作抢先；同步内存快照后拒绝本次提交。
    cache = snapshot
    return { ok: false, reason: 'conflict', current: currentStatus }
  }
  const nextRows = [...rows]
  nextRows[index] = patch
  persist({ ...snapshot, [key]: nextRows })
  return { ok: true, row: patch }
}

// 以当前落库数据为准追加一条记录，编号取该模块最大值加一（先落库者先占号）。
export function appendRow(key: string, row: Omit<EntryRow, 'id'> & { id?: number }): EntryRow {
  const snapshot = readRaw()
  const rows = snapshot[key] ?? []
  const nextId =
    typeof row.id === 'number'
      ? row.id
      : rows.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0) + 1
  const stored: EntryRow = { ...(row as EntryRow), id: nextId }
  persist({ ...snapshot, [key]: [...rows, stored] })
  return stored
}

export function storageKey(): string {
  return STORAGE_KEY
}
