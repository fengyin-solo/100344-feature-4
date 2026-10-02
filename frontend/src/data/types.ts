/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  // 动作允许的来源状态白名单：没登记来源的动作沿用旧规则（任意状态可发起）。
  // 用来约束单向状态流转，例如瞭望台只有「正常值守」能登记故障。
  actionSources?: Record<string, string[]>
  // 计入「待处理」的状态；不登记时沿用旧规则（非末态即待处理）。
  pendingStates?: string[]
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}
