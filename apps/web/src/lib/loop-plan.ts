import { getActorInitials } from '@/components/shared/actor-avatar'
import { z } from 'zod'

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
	/** Right-aligned live reading on the type card (mockup 2170 `t.live`).
	 *  Derived from the plan itself — `new type · N states` for a type the
	 *  workspace has no vocabulary for, `reused` for one it already runs. Never
	 *  a fixed label, and never a count we don't actually have. */
	live: string | null
	/** Types the loop links but never moves (mockup 2183–2185). A read-only type
	 *  shows `note` instead of a state chain. */
	readOnly?: boolean
	note?: string
	stateChain: string[]
	/** True when the workspace has no vocabulary for this type yet — rendered as
	 *  the `NEW TYPE` badge (mockup 2168). Derived from `ParseOptions.statusChains`,
	 *  which is the workspace's own per-type status vocabulary. */
	isNew: boolean
}

export interface PlanThenWrite {
	act: PlanAct
	type?: string
	state?: string
}

/** The right-aligned TYPE+state chip on a trigger header (mockup 2199–2204). */
export interface PlanWhenChip {
	type: string
	state?: string
}

export interface PlanTrigger {
	/** The trigger's *kind* — EVENT / RECURRING / NOTIFY. Never a badge string:
	 *  "just added" is `isNew`, which is a separate concept (mockup 2197–2198). */
	kindLabel: string
	whenClause: string
	targetAgent: string
	thenWrites: PlanThenWrite[]
	asks?: string
	/** Drafted by this sentence rather than already living in the workspace —
	 *  rendered as the `JUST ADDED` badge beside `kindLabel`. */
	isNew: boolean
	whenChip?: PlanWhenChip
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

/**
 * Runtime shape of a persisted `LoopPlan`.
 *
 * A stored plan re-enters the app from `objects.metadata.plan`, which agents
 * write through `PATCH /api/objects` and MCP `update_objects` — an external
 * input per `.claude/rules/input-validation.md`, not something the parser
 * constructed. Validating only the outer object let a truncated or hand-edited
 * snapshot through, and the consumers (`planFields`, `describeLoopPlan`) then
 * dereferenced `triggers` / `agents` / `stateChain` unguarded.
 */
const planObjectTypeSchema = z.object({
	type: z.string(),
	name: z.string(),
	role: z.string(),
	live: z.string().nullable(),
	readOnly: z.boolean().optional(),
	note: z.string().optional(),
	stateChain: z.array(z.string()),
	isNew: z.boolean(),
})

const planTriggerSchema = z.object({
	kindLabel: z.string(),
	whenClause: z.string(),
	targetAgent: z.string(),
	thenWrites: z.array(
		z.object({
			act: z.enum(['create', 'state_change', 'notify']),
			type: z.string().optional(),
			state: z.string().optional(),
		}),
	),
	asks: z.string().optional(),
	isNew: z.boolean(),
	whenChip: z.object({ type: z.string(), state: z.string().optional() }).optional(),
})

export const loopPlanSchema = z.object({
	objectTypes: z.array(planObjectTypeSchema),
	triggers: z.array(planTriggerSchema),
	agents: z.array(
		z.object({
			avatar: z.string(),
			name: z.string(),
			role: z.string(),
			count: z.number(),
		}),
	),
	stopForOperator: z.string().nullable(),
})

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
	baseChain: ['backlog', 'todo', 'in_progress', 'in_review', 'validated', 'done'],
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

	const knownTypes = options.statusChains ? new Set(Object.keys(options.statusChains)) : null
	// With no workspace vocabulary supplied we can't tell new from existing, so
	// nothing is claimed to be new — the badge only ever appears on real signal.
	const isNewType = (type: string) => (knownTypes ? !knownTypes.has(type) : false)

	const primaryIsNew = isNewType(detected.type)
	const objectTypes: PlanObjectType[] = [
		{
			type: detected.type,
			name: detected.spec.name,
			role: objectTypeRole(detected.spec, cue.summaryInterval),
			live: liveReading(primaryIsNew, stateChain.length),
			stateChain,
			isNew: primaryIsNew,
		},
	]
	if (cue.note) {
		const noteIsNew = isNewType('note')
		objectTypes.push({
			type: 'note',
			name: 'Note',
			role: 'Captured notes',
			live: liveReading(noteIsNew, 2),
			stateChain: ['new', 'done'],
			isNew: noteIsNew,
		})
	}
	// A type the sentence only reports to — the loop links it, never moves it
	// through states (mockup 2183–2185). Detected from the notify cue when the
	// recipient is a different type from the one being moved.
	const readOnly = detectReadOnlyType(lower, detected.type)
	if (readOnly) {
		objectTypes.push({
			type: readOnly.type,
			name: readOnly.name,
			role: readOnly.role,
			live: 'reused',
			readOnly: true,
			note: readOnly.note,
			stateChain: [],
			isNew: false,
		})
	}

	const coreTrigger = buildCoreTrigger(lower, detected.type, agentName, cue, asks, stateChain)
	const triggers: PlanTrigger[] = []
	if (coreTrigger) triggers.push(coreTrigger)
	if (cue.summaryInterval) {
		triggers.push({
			kindLabel: 'RECURRING',
			whenClause: `when the ${cue.summaryInterval} summary is due`,
			targetAgent: agentName,
			thenWrites: [{ act: 'create', type: detected.type }, { act: 'notify' }],
			isNew: true,
			whenChip: { type: detected.type },
		})
	}
	if (cue.notify && !coreTrigger) {
		triggers.push({
			kindLabel: 'NOTIFY',
			whenClause: 'when there is something to report',
			targetAgent: agentName,
			thenWrites: [{ act: 'notify' }],
			isNew: true,
			whenChip: { type: detected.type },
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

/** `t.live` — what the workspace already has for this type. */
function liveReading(isNew: boolean, stateCount: number): string {
	return isNew ? `new type · ${stateCount} states` : 'reused'
}

const READ_ONLY_VOCAB: Record<string, { name: string; role: string; note: string }> = {
	customer: {
		name: 'Customer',
		role: 'who hears back',
		note: 'linked, never changed by this loop',
	},
	client: {
		name: 'Client',
		role: 'who hears back',
		note: 'linked, never changed by this loop',
	},
	account: {
		name: 'Account',
		role: 'who the work belongs to',
		note: 'linked, never changed by this loop',
	},
}

/** A party the sentence only reports to — "reply to the customer", "notify the
 *  account". The loop links it and never moves it, so the card shows a note
 *  where a state chain would be (mockup 2183–2185). Requires an explicit report
 *  verb so a passing mention ("customer feedback") never invents a type. */
function detectReadOnlyType(lower: string, movedType: string) {
	const match = lower.match(
		/\b(?:notify|tell|inform|update|email|message|reply to|report to|respond to)\s+(?:the\s+)?(customers?|clients?|accounts?)\b/,
	)
	if (!match) return null
	const noun = match[1].replace(/s$/, '')
	if (noun === movedType) return null
	const spec = READ_ONLY_VOCAB[noun]
	return spec ? { type: noun, ...spec } : null
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
			hasWord(lower, 'tell') ||
			hasWord(lower, 'report') ||
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
	// Bounded to at most two words, no commas: an unbounded lazy capture here ran
	// from the leading verb all the way to a trailing cue, so "Notify me weekly
	// with a summary of new customer feedback, and triage …" named an agent
	// "Me Weekly With A Summary Of New Customer Feedback And".
	const directed = lower.match(
		/(?:ping|have|message|notify|get|ask|let)\s+(?:a|an|the)?\s*([a-z]+(?:\s+[a-z]+)??)\s+(?:to|run|write|triage)\b/,
	)
	if (directed?.[1].trim()) return normalizeAgentName(directed[1])
	return normalizeAgentName(detected.spec.name)
}

function normalizeAgentName(raw: string): string {
	const words = raw
		.trim()
		.replace(/\s+agent$/i, '')
		.replace(/[^a-z ]+/gi, ' ')
		// "have a triage agent …" captures the article too — "A Triage" is not a
		// name anyone typed.
		.replace(/^\s*(?:a|an|the)\s+/i, '')
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

function deriveCoreWrites(lower: string, type: string, stateChain: string[]): PlanThenWrite[] {
	const writes: PlanThenWrite[] = []
	// A proposed state is only real if the type's own chain can hold it. The
	// chain is the workspace's vocabulary (or the base chain when the workspace
	// supplied none), so a cue word like "triage" on a type whose chain has no
	// triage state must not be drawn — the card renders these through
	// StatusBadge, and a status the workspace cannot hold is a promise the loop
	// can never keep.
	const push = (w: PlanThenWrite) => {
		if (w.state && !stateChain.includes(w.state)) return
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
	stateChain: string[],
): PlanTrigger | null {
	const when = lower.match(/\bwhen\s+(.+)$/)
	if (!when) return null
	const clause = stripTrailingPunctuation(extractWhenClause(when[1]))

	const writes = deriveCoreWrites(lower, type, stateChain)
	if (cue.notify && !writes.some((w) => w.act === 'notify')) writes.push({ act: 'notify' })
	if (cue.note && !writes.some((w) => w.act === 'create' && w.type === 'note')) {
		writes.push({ act: 'create', type: 'note' })
	}

	const chipState = writes.find((w) => w.act === 'state_change' && w.state)?.state

	return {
		kindLabel: 'EVENT',
		whenClause: `when ${clause}`,
		targetAgent: agentName,
		thenWrites: writes,
		isNew: true,
		whenChip: { type, ...(chipState ? { state: chipState } : {}) },
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

/** Whole-word match that also accepts a regular plural — an operator writes
 *  "track bets", not "track bet", while the vocabulary is stored in the
 *  singular. Words already ending in `s` match as-is, so `status` doesn't
 *  demand `statuss`. */
function hasWord(text: string, word: string): boolean {
	const stem = word.endsWith('s') ? word : `${word}s?`
	return new RegExp(`(^|[^a-z])${stem}([^a-z]|$)`, 'i').test(text)
}

/** One-line read-back of the drafted loop, shown under the card title
 *  (mockup 2157–2158 `lbDesc`). Describes *this* plan, never fixed copy. */
export function describeLoopPlan(plan: LoopPlan): string {
	if (plan.objectTypes.length === 0 && plan.triggers.length === 0) {
		return 'Nothing is drafted yet — say what should happen.'
	}
	const sentences: string[] = []
	const primary = plan.objectTypes[0]
	if (primary) {
		const noun = primary.name.toLowerCase()
		const chain = primary.stateChain
		sentences.push(
			chain.length > 1
				? `Moves ${noun} from ${chain[0]} to ${chain[chain.length - 1]}.`
				: `Tracks ${noun}.`,
		)
	}
	if (plan.triggers.length > 0) {
		const n = plan.triggers.length
		const agents = Array.from(new Set(plan.triggers.map((t) => t.targetAgent)))
		sentences.push(
			`${n} trigger${n === 1 ? '' : 's'} hand${n === 1 ? 's' : ''} the work to ${joinNames(agents)}.`,
		)
	}
	sentences.push(
		plan.stopForOperator
			? `It stops for you ${plan.stopForOperator}.`
			: 'It never stops for you — it runs on its own.',
	)
	return sentences.join(' ')
}

/** Footer reading of what would be created (mockup 2272 `lbSummary`). */
export function summariseLoopPlan(plan: LoopPlan): string {
	const counts = [
		countLabel(plan.objectTypes.length, 'object type'),
		countLabel(plan.triggers.length, 'trigger'),
		countLabel(plan.agents.length, 'agent'),
	]
	return `${counts.join(' · ')} — nothing exists in your workspace yet.`
}

function countLabel(n: number, noun: string): string {
	return `${n} ${noun}${n === 1 ? '' : 's'}`
}

function joinNames(names: string[]): string {
	if (names.length === 0) return 'an agent'
	if (names.length === 1) return names[0]
	return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}
