import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, appendRow, commitRow, listRows, resetRows } from '@/data/local-store'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

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

// 当前状态下还能发起的动作：登记了来源白名单的动作只有来源命中才显示，
// 没登记来源的动作保持原样。页面用它渲染按钮，服务层仍会再校验一遍。
export function availableActions(meta: ModuleMeta, status: string): string[] {
  return meta.actions.filter((action) => {
    const sources = meta.actionSources?.[action]
    return !sources || sources.includes(status)
  })
}

function resolvePending(meta: ModuleMeta, target: string): boolean {
  if (meta.pendingStates) {
    return meta.pendingStates.includes(target)
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  return target !== lastStatus
}

// 瞭望台的专属流转规则与连带动作：其它模块继续走通用分支。
function buildLookoutPatch(
  row: EntryRow,
  action: string,
  target: string,
  pending: boolean,
): EntryRow {
  const patch: EntryRow = {
    ...row,
    status: target,
    pending,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  if (action === '关闭瞭望台') {
    // 关闭前把值守交接人快照下来，恢复值守时原样带回，不能丢。
    patch['交接人'] = String(row['瞭望员'] ?? '')
  } else if (action === '记录值守') {
    // 兼容已经临时关闭的瞭望台：恢复时保留原交接人，瞭望员字段一并还原。
    if (row['交接人'] !== undefined) {
      patch['瞭望员'] = String(row['交接人'])
      delete patch['交接人']
    }
  }
  return patch
}

function createReturnTodo(lookout: EntryRow): void {
  const today = new Date().toISOString().slice(0, 10)
  appendRow('equipment', {
    status: '待归还',
    pending: true,
    abnormal: false,
    装备编号: `RETN-${today}-${String(lookout.id).padStart(4, '0')}`,
    装备名称: `瞭望台维修器材归还（${String(lookout['瞭望台编号'] ?? lookout.id)}）`,
    装备类型: '器材归还待办',
    规格型号: '—',
    保管林场: String(lookout['所在山头'] ?? '—'),
    购入日期: '—',
    最近检修日: today,
    装备状态: '待归还',
    来源瞭望台: String(lookout['瞭望台编号'] ?? lookout.id),
    交接人: String(lookout['交接人'] ?? lookout['瞭望员'] ?? ''),
  })
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const current = rows.find((row) => Number(row.id) === id)
  if (!current) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const currentStatus = String(current.status)
  if (currentStatus === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  // 单向状态流转：只允许从白名单来源发起，越级恢复（如故障/维修中直接切回值守）在此拒绝。
  const sources = meta.actionSources?.[action]
  if (sources && !sources.includes(currentStatus)) {
    return {
      ok: false,
      message: `「${currentStatus}」状态下不能${action}，请按值守 → 故障 → 维修 → 恢复值守的顺序流转`,
    }
  }

  const pending = resolvePending(meta, target)
  let patch: EntryRow
  if (key === 'lookout') {
    patch = buildLookoutPatch(current, action, target, pending)
  } else {
    patch = {
      ...current,
      status: target,
      pending,
      abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
    }
  }

  // compare-and-set：以读取到的状态为准提交，被并发抢先落库（例如并发关闭）则本次拒绝。
  const result = commitRow(key, id, currentStatus, patch)
  if (!result.ok) {
    if (result.reason === 'missing') {
      return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
    }
    return {
      ok: false,
      message: `${meta.entity}已被其他操作先一步处理（当前「${result.current}」），本次${action}未生效，请刷新后重试`,
    }
  }

  // 瞭望台维修完成恢复值守后，到消防装备页补一条器材归还待办。
  if (key === 'lookout' && action === '维修完成') {
    createReturnTodo(result.row)
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
