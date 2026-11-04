/**
 * The "Agents working" aggregate for one workspace, shaped exactly like the iOS
 * `AgentsActivityState` / `WorkingAgent` (apps/apple/Sources/MaskinCore/LiveActivity/
 * AgentsActivityState.swift): a Codable CONTRACT. Every key is present except the optionals;
 * dates are Swift reference seconds (since 2001-01-01), never ISO strings.
 */

export const WORKING_AGENT_NAME_MAX = 40
export const WORKING_AGENT_DOING_MAX = 80
export const WORKING_AGENT_TOPIC_MAX = 60
/** Rows carried in a push; `count` still describes the whole set. */
export const MAX_ENCODED_AGENTS = 6
/** Seconds between the Unix epoch and Swift's reference date (2001-01-01T00:00:00Z). */
const SWIFT_REFERENCE_DATE_OFFSET_S = 978_307_200
/** "Finishing soon" means within this much of now (matches `AgentsActivityState`). */
export const FINISHING_SOON_WINDOW_MS = 15 * 60 * 1000

export const toSwiftReferenceSeconds = (d: Date): number =>
	d.getTime() / 1000 - SWIFT_REFERENCE_DATE_OFFSET_S

/** One working agent (actor), before encoding. */
export interface WorkingAgent {
	/** The agent's actor id. */
	id: string
	/** The running session behind the row (what Pause acts on). */
	sessionId: string
	name: string
	doing?: string | null
	startedAt: Date
	expectedFinishAt?: Date | null
	touchesCustomersOrProduction?: boolean
	objectId?: string | null
	conversationId?: string | null
	/** The conversation title. */
	topic?: string | null
}

export interface EncodedWorkingAgent {
	id: string
	sessionId: string
	name: string
	doing: string
	startedAt: number
	expectedFinishAt?: number
	touchesCustomersOrProduction: boolean
	objectId?: string
	conversationId?: string
	topic?: string
}

export interface EncodedAgentsState {
	count: number
	finishingSoon: number
	agents: EncodedWorkingAgent[]
}

/** Same rule as Swift's `clamp`: trim, fall back when blank, cut with an ellipsis. */
function clamp(text: string | null | undefined, max: number, fallback: string): string {
	const trimmed = (text ?? '').trim()
	if (!trimmed) return fallback
	return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed
}

/**
 * Soonest expected finish first (unknown last), then customer/production work, then the agent
 * that has been at it longest; ids break the last ties. Mirrors `AgentsActivityState.ranked`.
 */
export function rankWorkingAgents(agents: WorkingAgent[]): WorkingAgent[] {
	return [...agents].sort((a, b) => {
		const x = a.expectedFinishAt?.getTime()
		const y = b.expectedFinishAt?.getTime()
		if (x !== undefined && y !== undefined && x !== y) return x - y
		if (x !== undefined && y === undefined) return -1
		if (x === undefined && y !== undefined) return 1
		const ta = a.touchesCustomersOrProduction ? 1 : 0
		const tb = b.touchesCustomersOrProduction ? 1 : 0
		if (ta !== tb) return tb - ta
		if (a.startedAt.getTime() !== b.startedAt.getTime()) {
			return a.startedAt.getTime() - b.startedAt.getTime()
		}
		return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
	})
}

function encodeAgent(a: WorkingAgent): EncodedWorkingAgent {
	const topic = a.topic?.trim()
	return {
		id: a.id,
		sessionId: a.sessionId,
		name: clamp(a.name, WORKING_AGENT_NAME_MAX, 'Agent'),
		doing: clamp(a.doing, WORKING_AGENT_DOING_MAX, 'working'),
		startedAt: toSwiftReferenceSeconds(a.startedAt),
		...(a.expectedFinishAt
			? { expectedFinishAt: toSwiftReferenceSeconds(a.expectedFinishAt) }
			: {}),
		touchesCustomersOrProduction: a.touchesCustomersOrProduction === true,
		...(a.objectId ? { objectId: a.objectId } : {}),
		...(a.conversationId ? { conversationId: a.conversationId } : {}),
		...(topic ? { topic: clamp(topic, WORKING_AGENT_TOPIC_MAX, '') } : {}),
	}
}

/**
 * Ranks, counts and encodes the set. `maxBytes` bounds the JSON of the state so a push stays
 * inside APNs' 4 KB limit: trailing rows are dropped before the limit is hit, `count` is not.
 */
export function encodeAgentsState(
	agents: WorkingAgent[],
	nowMs: number,
	maxBytes = 3000,
): EncodedAgentsState {
	const ranked = rankWorkingAgents(agents)
	const finishingSoon = ranked.filter(
		(a) => a.expectedFinishAt && a.expectedFinishAt.getTime() - nowMs <= FINISHING_SOON_WINDOW_MS,
	).length
	let rows = ranked.slice(0, MAX_ENCODED_AGENTS).map(encodeAgent)
	const state = () => ({ count: ranked.length, finishingSoon, agents: rows })
	while (rows.length > 1 && Buffer.byteLength(JSON.stringify(state())) > maxBytes) {
		rows = rows.slice(0, -1)
	}
	return state()
}

/** A session row as `LiveActivityFanout` reads it, before it becomes a working agent. */
export interface WorkingSessionRow {
	sessionId: string
	actorId: string
	agentName: string
	currentActivity: string | null
	startedAt: Date
	conversationId: string | null
	topic: string | null
}

/** One row per agent (actor), however many sessions it runs: the session started first. */
export function groupWorkingAgents(rows: WorkingSessionRow[]): WorkingAgent[] {
	const byActor = new Map<string, WorkingSessionRow>()
	for (const r of rows) {
		const prev = byActor.get(r.actorId)
		if (
			!prev ||
			r.startedAt.getTime() < prev.startedAt.getTime() ||
			(r.startedAt.getTime() === prev.startedAt.getTime() && r.sessionId < prev.sessionId)
		) {
			byActor.set(r.actorId, r)
		}
	}
	return [...byActor.values()].map((r) => ({
		id: r.actorId,
		sessionId: r.sessionId,
		name: r.agentName,
		doing: r.currentActivity,
		startedAt: r.startedAt,
		conversationId: r.conversationId,
		topic: r.topic,
	}))
}
