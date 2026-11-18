/**
 * R24: 派发 / 续跑回执的「收口」契约。
 *
 * 宿主对空闲会话收到 followup 会**新开一个 turn**，只有会话正忙时才排队
 * （见 dsh-agent 的 inbox：nextTurn 在 turn 结束后才被 claim）。因此中枢在
 * 本轮里等分支，等于把 relay 锁在队列里——分支不是中枢 subagent 树的成员，
 * wait_agent 永远等不到它们。回执带 nextAction，让模型在拿到回执的同一步
 * 结束本轮，由 relay 开启下一轮。
 *
 * 文案是唯一来源：dispatch.ts 的回执、tools.ts 的输出 schema 渲染、冒烟断言
 * 都引用这里，防止三处文案漂移。
 * @module supermemory/round-end
 */

/** memory_dispatch 成功回执的收口提示（单条 / 并行组通用）。 */
export const DISPATCH_NEXT_ACTION = '已派发。请立即结束本轮回复；分支完成后 relay 会自动开启新一轮对话，届时再汇总转述给用户。'

/** memory_resume 续跑回执的收口提示（只查清单时不需要）。 */
export const RESUME_NEXT_ACTION = '已续跑。请立即结束本轮回复；分支完成后 relay 会自动开启新一轮对话，届时再汇总转述给用户。'
