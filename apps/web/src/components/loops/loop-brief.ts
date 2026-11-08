import { deriveAgentFocus } from '@/lib/agent-detail'
import type { ActorListItem, LoopSummary, SessionResponse } from '@/lib/api'

/** An agent of a flow whose newest run failed, with that run (Restart reruns its prompt). */
export interface FailedAgent {
	agent: Pick<ActorListItem, 'id' | 'name'>
	session: SessionResponse
}

/**
 * The first agent of the flow (in the flow's own agent order) whose newest run
 * failed. Read from the workspace sessions the page already loads: the flow
 * summary carries no failure field. Null when no agent of the flow failed, so
 * the card shows no banner and no Restart.
 */
export function failedAgentForLoop(
	loop: Pick<LoopSummary, 'agentIds'>,
	sessions: SessionResponse[] | undefined,
	actors: Pick<ActorListItem, 'id' | 'name'>[] | undefined,
): FailedAgent | null {
	if (!sessions || sessions.length === 0) return null
	for (const agentId of loop.agentIds) {
		const own = sessions.filter((s) => s.actorId === agentId)
		const focus = deriveAgentFocus(own)
		if (focus?.kind !== 'failed') continue
		const agent = actors?.find((a) => a.id === agentId)
		if (!agent) continue
		return { agent: { id: agent.id, name: agent.name }, session: focus.session }
	}
	return null
}

/** A flow needs the viewer when it waits on them or one of its agents stopped. */
export function loopNeedsYou(loop: Pick<LoopSummary, 'pill'>, failed: FailedAgent | null): boolean {
	return loop.pill === 'waiting_on_you' || failed !== null
}

export interface FlowsBrief {
	total: number
	needYou: number
	/** "4 of 5 flows need you." */
	lead: string
	/** One clause per flow that has something specific to say; never invented. */
	clauses: string[]
}

/**
 * The plain-text brief under the Flows title: how many flows need the viewer,
 * then one clause per flow where the data says why. A flow that needs the
 * viewer but has nothing detectable to say adds no clause.
 */
export function buildFlowsBrief(
	loops: Pick<LoopSummary, 'id' | 'name' | 'pill' | 'waitingCount'>[],
	failedByLoopId: Map<string, FailedAgent>,
): FlowsBrief {
	const total = loops.length
	const clauses: string[] = []
	let needYou = 0
	for (const loop of loops) {
		const failed = failedByLoopId.get(loop.id) ?? null
		if (!loopNeedsYou(loop, failed)) continue
		needYou += 1
		const name = loop.name ?? 'Untitled flow'
		if (failed) {
			clauses.push(`${name}: ${failed.agent.name} stopped on its last run.`)
		} else if (loop.waitingCount > 0) {
			clauses.push(
				`${name}: ${loop.waitingCount} ${loop.waitingCount === 1 ? 'item waits' : 'items wait'} for you.`,
			)
		}
	}
	const lead =
		needYou === 0
			? 'No flows need you.'
			: `${needYou} of ${total} ${total === 1 ? 'flow needs' : 'flows need'} you.`
	return { total, needYou, lead, clauses }
}
