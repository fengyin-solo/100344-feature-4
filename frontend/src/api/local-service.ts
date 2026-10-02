import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, appendRow, commitRow, listRows, resetRows } from '@/data/local-store'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

const LOOKOUT_KEY = 'lookout'
const EQUIPMENT_KEY = 'equipment'

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

function isPending(meta: ModuleMeta, status: string): boolean {
  if (meta.pendingWhen) {
    return meta.pendingWhen.includes(status)
  }
  // 没配状态机的模块沿用旧规则：末态即办结，其余状态算待处理。
  return status !== meta.statuses[meta.statuses.length - 1]
}

// 瞭望台各动作在越级发起时给出的针对性提示。
const LOOKOUT_GUARD_MESSAGES: Record<string, string> = {
  登记故障: '只有「正常值守」的瞭望台才能登记故障',
  安排维修: '故障确认后才能安排维修，请先登记故障',
  维修完成: '维修完成后才能恢复值守，不允许从故障或关闭状态越级恢复',
  关闭瞭望台: '只有正常值守期间才能关闭瞭望台，维修期间不得关闭',
}

function guardMessage(meta: ModuleMeta, action: string, current: string): string {
  if (meta.key === LOOKOUT_KEY && LOOKOUT_GUARD_MESSAGES[action]) {
    return LOOKOUT_GUARD_MESSAGES[action]
  }
  return `${meta.entity}当前状态为「${current}」，不能执行「${action}」`
}

// 恢复值守后，给另一个页面（消防装备清单）同步挂一条器材归还待办；按瞭望台编号幂等。
function createEquipmentReturnTodo(lookout: EntryRow): EntryRow | null {
  const code = `RETURN-${String(lookout['瞭望台编号'] ?? lookout.id)}`
  return appendRow(EQUIPMENT_KEY, (existing) => {
    if (existing.some((row) => String(row['关联编号'] ?? '') === code)) {
      return null
    }
    const created: EntryRow = {
      id: existing.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1,
      status: '已领用',
      pending: true,
      abnormal: false,
      装备编号: `EQUI-RET-${String(lookout.id).padStart(4, '0')}`,
      装备名称: `${lookout['瞭望台编号'] ?? ''} 维修器材归还`.trim(),
      装备类型: '器材归还',
      规格型号: String(lookout['设备配置'] ?? ''),
      保管林场: String(lookout['所在山头'] ?? ''),
      购入日期: '',
      最近检修日: '',
      装备状态: '待归还',
      关联编号: code,
    }
    return created
  })
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const row = rows.find((item) => Number(item.id) === id)
  if (!row) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(row.status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }

  // 状态机守卫：配置了 transitions 的模块只允许从白名单状态发起动作，越级一律拒绝。
  const allowedFrom = meta.transitions?.[action]
  if (allowedFrom && !allowedFrom.includes(current)) {
    return { ok: false, message: guardMessage(meta, action, current) }
  }

  // 关闭瞭望台时留存原交接人：取原交接人，没有就快照当前瞭望员；恢复值守时不动它。
  const patch: Partial<EntryRow> = {
    status: target,
    pending: isPending(meta, target),
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  if (key === LOOKOUT_KEY && action === '关闭瞭望台') {
    const previous = String(row['交接人'] ?? '').trim()
    patch['交接人'] = previous || String(row['瞭望员'] ?? '')
  }

  // CAS 落库：并发关闭同一瞭望台时，只接受先落库的一次。
  const committed = commitRow(key, id, current, patch)
  if (!committed.ok) {
    if (!committed.current) {
      return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
    }
    return {
      ok: false,
      message: `${meta.entity}状态已被其他操作更新为「${committed.current.status}」，本次${action}未生效，请刷新后重试`,
    }
  }

  // 恢复值守（维修完成）后同步器材归还待办。
  if (key === LOOKOUT_KEY && action === '维修完成') {
    createEquipmentReturnTodo(row)
  }

  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
