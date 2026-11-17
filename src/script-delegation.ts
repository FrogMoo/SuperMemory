/**
 * The branch's first message, built as a pure function (R18, 需求④).
 *
 * Capability setup must not live only in the hub model's head: it is written
 * into the delegation script itself, so the branch reads its boundary from the
 * first line of its own input ("本轮能力边界：…；越界请汇报而不是硬做"). The
 * host additionally restricts the branch's tools (src/capabilities.ts), but a
 * host without that seam still gets the explicit contract.
 *
 * Pure on purpose: scripts/mechanism-smoke.mjs asserts the exact text without a
 * DSH host.
 * @module supermemory/script-delegation
 */
import { CAPABILITY_PROFILES, resolveCapabilities, type CapabilityProfile } from './capabilities.ts'

export interface DispatchScriptInput {
  /** The task text the hub asked for. */
  task: string
  /** Capability profile the branch was granted (unknown values resolve to the default). */
  capabilities?: CapabilityProfile | string
  /** Topic set title shown to the branch. */
  topicTitle: string
  /** The branch session id (may be omitted while the script is built for a dry run). */
  branchSessionId?: string
  /** The dispatch id (kept in the header for traceability). */
  dispatchId?: string
}

/**
 * Build the branch's opening message: header + topic set + task + the explicit
 * capability boundary + the working-branch contract (R20: proceed under the
 * best interpretation; ask the HUB through `memory_raise_question`, never the
 * user directly).
 */
export function buildDispatchScript(input: DispatchScriptInput): string {
  const capability = resolveCapabilities(input.capabilities)
  const host = [
    '[supermemory-dispatch' + (input.dispatchId ? ` ${input.dispatchId}` : '') + ']',
    `话题集：${input.topicTitle}`,
    ...(input.branchSessionId ? [`分支会话：${input.branchSessionId}`] : []),
    `任务：${input.task}`,
    '',
    `本轮能力边界：${capability.label}（${capability.description}）；越界请汇报而不是硬做——做不到就说清楚缺什么，不要假装完成。`,
    '',
    '你是该话题集的一个工作分支：完成实质工作并汇报结果。',
    '遇到分歧按「最合理解释」直接执行，不要停下来等用户确认；把做出的假设写进最终汇报。',
    '',
    '提问约定（必须遵守）：',
    '- 需要用户裁决时，调用 memory_raise_question 把问题结构化上交中枢'
      + '（title/question 必填，可选 options/severity/blocking/progress/defaultPlan），'
      + '由中枢汇总所有分支的问题后统一向用户提问。',
    '- 不要在本分支对话里直接向用户提问，也不要因为提问而卡住不干活：'
      + '非阻塞问题（blocking=false）上交后继续按最合理解释推进并完成实质工作。',
    '- 只有真正阻断、非用户裁决无法继续时才 blocking=true，并同时写清已完成的进度（progress）'
      + '与默认备选方案（defaultPlan）。',
  ]
  return host.join('\n')
}

/** The four labels, for tool descriptions and docs (kept in one place). */
export function capabilityMenu(): string {
  return (Object.keys(CAPABILITY_PROFILES) as CapabilityProfile[])
    .map((name) => `${name}（${CAPABILITY_PROFILES[name].label}）`)
    .join('、')
}
