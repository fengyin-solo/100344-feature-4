import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'forest-fire-patrol:entries'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function withSeed(parsed: Record<string, EntryRow[]>): Record<string, EntryRow[]> {
  // 老存档可能缺后来新增的模块，用种子补齐。
  return { ...clone(SEED_ROWS), ...parsed }
}

// 落库前的最新快照：每次都重读 localStorage，避免用过期缓存覆盖别的标签页的写入。
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
    return withSeed(JSON.parse(raw) as Record<string, EntryRow[]>)
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: Record<string, EntryRow[]> | null = null

if (typeof window !== 'undefined') {
  // 其它标签页落库后本标签页的内存缓存即过期，强制下一次读取重新加载。
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

export function saveRows(key: string, rows: EntryRow[]): void {
  // 以落库瞬间的最新快照为底，只替换本模块，避免覆盖并发标签页对其它模块的改动。
  const next = { ...readStorage(), [key]: rows }
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

// 乐观锁提交：只有落库瞬间该行状态仍是期望状态时才接受写入（模拟唯一一次落库）。
// 同一瞭望台被并发关闭时，先落库的一次改了状态，后到的调用会在 expectedStatus 上比对失败。
export function commitRow(
  key: string,
  id: number,
  expectedStatus: string,
  patch: Partial<EntryRow>,
): { ok: boolean; current?: EntryRow } {
  const snapshot = readStorage()
  const rows = snapshot[key] ?? []
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false }
  }
  if (String(rows[index].status) !== expectedStatus) {
    return { ok: false, current: rows[index] }
  }
  const updated = { ...rows[index], ...patch } as EntryRow
  const nextRows = [...rows]
  nextRows[index] = updated
  const next = { ...snapshot, [key]: nextRows }
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
  cache = next
  return { ok: true }
}

// 跨模块追加一条记录（如瞭望台恢复后给装备清单挂器材归还待办）。
// 调用方传入的已存在判断在落库瞬间再校验一次，避免并发重复追加。
export function appendRow(
  key: string,
  build: (existing: EntryRow[]) => EntryRow | null,
): EntryRow | null {
  const snapshot = readStorage()
  const rows = snapshot[key] ?? []
  const created = build(rows)
  if (created === null) {
    return null
  }
  const nextRows = [...rows, created]
  const next = { ...snapshot, [key]: nextRows }
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
  cache = next
  return created
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
