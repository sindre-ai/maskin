import { logger } from '../logger'

/**
 * Keeps backend PostHog volume inside the free tier (target 15k events a day).
 * 29 and 30 Oct 2026 ran at 35k and 79k, so every event name now has a daily
 * ceiling and the plumbing diagnostics are sampled.
 *
 * Counts live in memory per process: a restart resets them, and with several
 * replicas each one has its own ceiling.
 */

const DEFAULT_DAILY_CAP = 2_500

// Events the product questions depend on. Never sampled, never capped.
const TIER1_EXACT = new Set([
	'agent_session_completed',
	'agent_session_started',
	'chat_session_started',
])
const TIER1_PREFIXES = ['foryou_card_', 'signup_', 'workspace_', 'checkout_']

// Fraction of events sent. 0 drops the event. Sampled events carry
// `sample_rate`, so a count is read as `count / sample_rate`.
//
// Dropped: provenance_edge_written, always sent next to relationship_created
// with type produced_by, which holds the same information.
// Sampled: the rest are diagnostics where the shape of the trend matters more
// than every row. keychain_credential_accessed also has the credential access
// log table; session_waiting_stuck also has a warn log per session.
const SAMPLE_RATES: Record<string, number> = {
	provenance_edge_written: 0,
	mcp_tool_call_response_size: 0.1,
	mcp_handshake: 0.1,
	trigger_match_failed: 0.2,
	keychain_credential_accessed: 0.2,
	session_waiting_stuck: 0.1,
	runtime_concurrent_sessions_gauge: 0.1,
}

interface Counts {
	seen: number
	sent: number
	sampledOut: number
	capped: number
}

export interface EventAdmission {
	send: boolean
	/** Set when the event was sampled, so the sender can stamp it on the event. */
	sampleRate?: number
}

let day = ''
let counts = new Map<string, Counts>()

function isTier1(event: string): boolean {
	return TIER1_EXACT.has(event) || TIER1_PREFIXES.some((prefix) => event.startsWith(prefix))
}

// 0 turns the ceiling off. A missing or malformed value falls back to the default.
function dailyCap(): number {
	const raw = process.env.POSTHOG_EVENT_DAILY_CAP?.trim()
	if (!raw) return DEFAULT_DAILY_CAP
	const parsed = Number(raw)
	return Number.isInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_DAILY_CAP
}

function rollDay(today: string): void {
	if (today === day) return
	if (day && counts.size > 0) {
		const byName = [...counts.entries()].sort((a, b) => b[1].seen - a[1].seen)
		logger.info('PostHog events by name for the previous UTC day', {
			day,
			sentTotal: byName.reduce((sum, [, c]) => sum + c.sent, 0),
			events: Object.fromEntries(byName.map(([name, c]) => [name, c])),
		})
	}
	day = today
	counts = new Map()
}

/**
 * Decides whether a backend event is sent, and counts it for the daily log line.
 * Tier 1 events always pass. Sampling is applied before the ceiling, so a
 * sampled-out event never uses up the ceiling.
 */
export function admitPosthogEvent(event: string): EventAdmission {
	const today = new Date().toISOString().slice(0, 10)
	rollDay(today)

	let c = counts.get(event)
	if (!c) {
		c = { seen: 0, sent: 0, sampledOut: 0, capped: 0 }
		counts.set(event, c)
	}
	c.seen++

	if (isTier1(event)) {
		c.sent++
		return { send: true }
	}

	const rate = SAMPLE_RATES[event]
	if (rate !== undefined && Math.random() >= rate) {
		c.sampledOut++
		return { send: false }
	}

	const cap = dailyCap()
	if (cap > 0 && c.sent >= cap) {
		c.capped++
		if (c.capped === 1) {
			logger.warn('PostHog event over its daily cap, dropping the rest of the UTC day', {
				event,
				dailyCap: cap,
				day,
			})
		}
		return { send: false }
	}

	c.sent++
	return rate === undefined ? { send: true } : { send: true, sampleRate: rate }
}

/** Test-only: forgets today's counts. */
export function __resetPosthogEventBudgetForTesting(): void {
	day = ''
	counts = new Map()
}
