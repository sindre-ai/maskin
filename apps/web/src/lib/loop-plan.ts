import { getActorInitials } from '@/components/shared/actor-avatar'

/**
 * Plan model + cue-word parser for the language-only loop builder (T1).
 *
 * Turns an operator's plain-language description (or a tapped example sentence)
 * into an in-memory `LoopPlan`: the object types and their state chain, the
 * triggers, the agents, and the exact point the loop stops for the operator.
 *
 * This is a PURE model — parsing never creates, mutates, or persists any
 * workspace object. Nothing is created until the operator accepts (Create in
 * T2). It is also a composite over existing primitives only: object types and
 * statuses reuse the workspace-vocabulary concept (optional per-type chain
 * override), agent avatars reuse `getActorInitials`, and the plan carries no
 * CSS tokens — status values are domain statuses, mapped to the live
 * `--st-*` / `--tp-*` tokens by whichever surface renders it.
 */

export type PlanAct = 'create' | 'state_change' | 'notify'

export interface PlanObjectType {
	type: string
	name: string
	role: string
	live: boolean
	stateChain: string[]
}

export interface PlanThenWrite {
	act: PlanAct
	type?: string
	state?: string
}

export interface PlanTrigger {
	kindLabel: string
	whenClause: string
	targetAgent: string
	thenWrites: PlanThenWrite[]
	asks?: string
}

export interface PlanAgent {
	avatar: string
	name: string
	role: string
	count: number
}

export interface LoopPlan {
	objectTypes: PlanObjectType[]
	triggers: PlanTrigger[]
	agents: PlanAgent[]
	stopForOperator: string | null
}

export interface ParseOptions {
	/** Optional per-object-type status chain overrides (from workspace.settings.statuses). */
	statusChains?: Record<string, string[]>
}

interface ObjectTypeSpec {
	type: string
	name: string
	baseChain: string[]
	role: string
}

interface DetectedType {
	type: string
	spec: ObjectTypeSpec
}

const TASK: ObjectTypeSpec = {
	type: 'task',
	name: 'Task',
	baseChain: ['todo', 'in_progress', 'in_review', 'validated', 'done'],
	role: 'Unit of work',
}

// Proposed state chains reuse existing workspace-vocabulary status names; they
// are rendered later through the live `--st-*` family, not invented here.
const OBJECT_TYPE_VOCAB: Array<{ keywords: string[]; spec: ObjectTypeSpec }> = [
	{
		keywords: ['feedback', 'customer'],
		spec: {
			type: 'feedback',
			name: 'Feedback',
			baseChain: ['new', 'triage', 'approved', 'published'],
			role: 'Submissions from customers',
		},
	},
	{
		keywords: ['bet'],
		spec: {
			type: 'bet',
			name: 'Bet',
			baseChain: ['signal', 'active', 'at_risk', 'rescue'],
			role: 'A wager on an outcome',
		},
	},
	{ keywords: ['task', 'todo', 'work'], spec: TASK },
]

interface CueFlags {
	summaryInterval: string | null
	notify: boolean
	note: boolean
	coach: boolean
}

/** Parse a plain-language description into a deterministic LoopPlan. */
export function parseLoopDescription(description: string, options: ParseOptions = {}): LoopPlan {
	const lower = (description ?? '').toLowerCase().trim()
	if (!lower) {
		return { objectTypes: [], triggers: [], agents: [], stopForOperator: null }
	}

	const detected = detectObjectType(lower)
	const stateChain = options.statusChains?.[detected.type] ?? detected.spec.baseChain
	const cue = detectCueWords(lower)
	const agentName = detectAgent(lower, detected)
	const planNoun = matchPlanNoun(lower)
	const asks = detectAsks(lower)

	const objectTypes: PlanObjectType[] = [
		{
			type: detected.type,
			name: detected.spec.name,
			role: objectTypeRole(detected.spec, cue.summaryInterval),
			live: false,
			stateChain,
		},
	]
	if (cue.note) {
		objectTypes.push({
			type: 'note',
			name: 'Note',
			role: 'Captured notes',
			live: false,
			stateChain: ['new', 'done'],
		})
	}

	const coreTrigger = buildCoreTrigger(lower, detected.type, agentName, cue, asks)
	const triggers: PlanTrigger[] = []
	if (coreTrigger) triggers.push(coreTrigger)
	if (cue.summaryInterval) {
		triggers.push({
			kindLabel: 'RECURRING',
			whenClause: `when the ${cue.summaryInterval} summary is due`,
			targetAgent: agentName,
			thenWrites: [{ act: 'create', type: detected.type }, { act: 'notify' }],
		})
	}
	if (cue.notify && !coreTrigger) {
		triggers.push({
			kindLabel: 'NOTIFY',
			whenClause: 'when there is something to report',
			targetAgent: agentName,
			thenWrites: [{ act: 'notify' }],
		})
	}

	const agents: PlanAgent[] = [
		{
			avatar: getActorInitials(agentName),
			name: agentName,
			role: agentRole(lower, detected, cue, asks, planNoun),
			count: 1,
		},
	]

	return {
		objectTypes,
		triggers,
		agents,
		stopForOperator: detectStop(lower, cue),
	}
}

function detectObjectType(lower: string): DetectedType {
	for (const entry of OBJECT_TYPE_VOCAB) {
		if (entry.keywords.some((k) => hasWord(lower, k))) {
			return { type: entry.spec.type, spec: entry.spec }
		}
	}
	return { type: TASK.type, spec: TASK }
}

function detectCueWords(lower: string): CueFlags {
	return {
		summaryInterval: detectInterval(lower),
		notify:
			hasWord(lower, 'notify') ||
			hasWord(lower, 'ping') ||
			hasWord(lower, 'alert') ||
			hasWord(lower, 'message') ||
			hasWord(lower, 'remind'),
		note: hasWord(lower, 'note') || hasWord(lower, 'log') || hasWord(lower, 'record'),
		coach: hasWord(lower, 'coach') || hasWord(lower, 'guide') || hasWord(lower, 'mentor'),
	}
}

function detectInterval(lower: string): string | null {
	if (hasWord(lower, 'weekly')) return 'weekly'
	if (hasWord(lower, 'daily')) return 'daily'
	if (hasWord(lower, 'monthly')) return 'monthly'
	if (hasWord(lower, 'quarterly')) return 'quarterly'
	if (hasWord(lower, 'biweekly')) return 'biweekly'
	if (hasWord(lower, 'summary') || hasWord(lower, 'digest')) return 'weekly'
	return null
}

function detectAgent(lower: string, detected: DetectedType): string {
	const named = lower.match(/have(?:\s+the)?\s+([a-z][a-z -]*?)\s+agent\b/)
	if (named?.[1].trim()) return normalizeAgentName(named[1])
	const directed = lower.match(
		/(?:ping|have|message|notify|get|ask|let)\s+(?:the\s+)?([a-z][a-z ,]*?)\s+(?:to|run|write|triage)\b/,
	)
	if (directed?.[1].trim()) return normalizeAgentName(directed[1])
	return normalizeAgentName(detected.spec.name)
}

function normalizeAgentName(raw: string): string {
	const words = raw
		.trim()
		.replace(/\s+agent$/i, '')
		.replace(/[^a-z ]+/gi, ' ')
		.split(/\s+/)
		.filter(Boolean)
	if (words.length === 0) return 'Agent agent'
	return `${words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')} agent`
}

function matchPlanNoun(lower: string): string | null {
	const m = lower.match(/(?:write|draft|create)\s+(?:a|an|the)?\s*([a-z]+)\s+plan\b/)
	return m ? m[1] : null
}

function detectAsks(lower: string): string | undefined {
	const before = lower.match(/ask\s+(?:me|you)?\s*before\s+([a-z][a-z ]*)/)
	if (before) return `you before ${stripTrailingPunctuation(before[1])}`
	if (hasWord(lower, 'ask')) return 'you first'
	return undefined
}

function detectStop(lower: string, cue: CueFlags): string | null {
	const before = lower.match(/ask\s+(?:me|you)?\s*before\s+([a-z][a-z ]*)/)
	if (before) return `before ${stripTrailingPunctuation(before[1])}`
	if (hasWord(lower, 'ask')) return 'before it proceeds'
	if (cue.coach) return 'before coaching notes are shared with you'
	return null
}

function deriveCoreWrites(lower: string, type: string): PlanThenWrite[] {
	const writes: PlanThenWrite[] = []
	const push = (w: PlanThenWrite) => {
		if (!writes.some((x) => x.act === w.act && x.type === w.type && x.state === w.state)) {
			writes.push(w)
		}
	}
	if (hasWord(lower, 'triage')) push({ act: 'state_change', type, state: 'triage' })
	if (hasWord(lower, 'approve') || hasWord(lower, 'review')) {
		push({ act: 'state_change', type, state: 'approved' })
	}
	if (hasWord(lower, 'publish')) push({ act: 'state_change', type, state: 'published' })
	if (lower.includes('at-risk') || lower.includes('at_risk')) {
		push({ act: 'state_change', type, state: 'at_risk' })
	}
	const planNoun = matchPlanNoun(lower)
	if (
		planNoun &&
		(hasWord(lower, 'write') || hasWord(lower, 'draft') || hasWord(lower, 'create'))
	) {
		push({ act: 'create', type, state: planNoun })
	}
	if (writes.length === 0) push({ act: 'create', type })
	return writes
}

function buildCoreTrigger(
	lower: string,
	type: string,
	agentName: string,
	cue: CueFlags,
	asks: string | undefined,
): PlanTrigger | null {
	const when = lower.match(/\bwhen\s+(.+)$/)
	if (!when) return null
	const clause = stripTrailingPunctuation(extractWhenClause(when[1]))

	const writes = deriveCoreWrites(lower, type)
	if (cue.notify && !writes.some((w) => w.act === 'notify')) writes.push({ act: 'notify' })
	if (cue.note && !writes.some((w) => w.act === 'create' && w.type === 'note')) {
		writes.push({ act: 'create', type: 'note' })
	}

	return {
		kindLabel: 'JUST ADDED',
		whenClause: `when ${clause}`,
		targetAgent: agentName,
		thenWrites: writes,
		...(asks ? { asks } : {}),
	}
}

/** The condition that starts the loop — the text before the action clause. */
function extractWhenClause(afterWhen: string): string {
	const parts = afterWhen.split(/,?\s+(?=have\b|then\b|ping\b|notify\b|message\b|ask\b|also\b)/)
	return parts[0].trim()
}

function objectTypeRole(spec: ObjectTypeSpec, summaryInterval: string | null): string {
	return spec.role + (summaryInterval ? ` · ${summaryInterval} summary` : '')
}

function agentRole(
	lower: string,
	detected: DetectedType,
	cue: CueFlags,
	asks: string | undefined,
	planNoun: string | null,
): string {
	const subject = detected.spec.name.toLowerCase()
	let role: string
	if (planNoun) {
		role = `writes the ${planNoun} plan`
	} else if (hasWord(lower, 'triage')) {
		role = `triages ${subject}`
	} else if (hasWord(lower, 'review')) {
		role = `reviews ${subject}`
	} else {
		role = `handles ${subject}`
	}
	if (cue.summaryInterval) role += ` · writes the ${cue.summaryInterval} summary`
	if (cue.notify) role += ', notifies you'
	if (cue.coach) role += ' · coaches you'
	if (asks) role += ` and asks ${asks}`
	return role
}

function stripTrailingPunctuation(value: string): string {
	return value
		.trim()
		.replace(/[.,;!?]+$/g, '')
		.trim()
}

function hasWord(text: string, word: string): boolean {
	return new RegExp(`(^|[^a-z])${word}([^a-z]|$)`, 'i').test(text)
}
