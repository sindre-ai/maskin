import type { Database } from '@maskin/db'
import { actors, sessions } from '@maskin/db/schema'
import { CHIEF_OF_STAFF_DEFAULT } from '@maskin/shared'
import { eq } from 'drizzle-orm'
import { logger } from '../logger'
import { capturePosthogEvent } from './posthog'

/**
 * Server-side emitter for the Chief of Staff prototype bet's thinness-violation
 * event (`chief_of_staff_domain_output_detected`). The parent bet's rolling
 * kill clause treats even one hit as a stop signal, so the heuristic below
 * favours precision over recall — under-detection is safe (the bet just runs
 * a day longer), over-detection is expensive (it kills the prototype early).
 */

const CHIEF_OF_STAFF_DISPLAY_NAME = CHIEF_OF_STAFF_DEFAULT.name

/**
 * Minimum assistant-text length that trips the heuristic. Any shorter response
 * is treated as a greeting, clarifying question, or routing acknowledgement —
 * i.e. exactly the traffic the boundary agent is *supposed* to produce.
 */
export const CHIEF_OF_STAFF_MIN_DOMAIN_OUTPUT_CHARS = 400

/**
 * Tool names that mean the assistant is delegating to a specialist rather
 * than producing domain output itself. Presence of any of these in the same
 * message block as long text means the text is context/preamble for a
 * summon, not standalone domain output.
 *
 * Includes bare names (as Anthropic tools would report them) and the
 * `mcp__<server>__<tool>` form Claude Code emits when a tool is exposed via
 * an MCP server — the Chief of Staff summons through the maskin MCP.
 */
const SUMMON_TOOL_NAMES: ReadonlySet<string> = new Set([
	'run_agent',
	'create_session',
	'mcp__maskin__run_agent',
	'mcp__maskin__create_session',
])

export interface CoSDomainOutputHit {
	chars: number
	messageId: string | null
	sessionId: string | null
}

interface AssistantContentBlock {
	type?: unknown
	text?: unknown
	name?: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Scan a raw stdout chunk from the Claude Code CLI for a Chief-of-Staff-produced
 * assistant message that trips the domain-output heuristic.
 *
 * The CLI emits one JSON envelope per line under `--output-format stream-json`.
 * We split on newlines and try to parse each; anything that isn't valid JSON
 * or isn't an `assistant` envelope is ignored. For each assistant envelope we
 * sum the text-block lengths and collect tool_use names; if the concatenated
 * text is ≥ CHIEF_OF_STAFF_MIN_DOMAIN_OUTPUT_CHARS and no summon-flavoured
 * tool_use appears in the same message, we return the hit. Otherwise `null`.
 */
export function detectChiefOfStaffDomainOutput(chunk: string): CoSDomainOutputHit | null {
	if (!chunk) return null
	const lines = chunk.split('\n')
	for (const raw of lines) {
		const line = raw.trim()
		if (line.length === 0 || line[0] !== '{') continue
		let envelope: unknown
		try {
			envelope = JSON.parse(line)
		} catch {
			continue
		}
		if (!isRecord(envelope)) continue
		if (envelope.type !== 'assistant') continue
		const message = envelope.message
		if (!isRecord(message)) continue
		const content = message.content
		if (!Array.isArray(content)) continue

		let totalChars = 0
		let hasSummon = false
		for (const block of content as AssistantContentBlock[]) {
			if (!isRecord(block)) continue
			if (block.type === 'text' && typeof block.text === 'string') {
				totalChars += block.text.length
				continue
			}
			if (block.type === 'tool_use' && typeof block.name === 'string') {
				if (SUMMON_TOOL_NAMES.has(block.name)) {
					hasSummon = true
				}
			}
		}
		if (hasSummon) continue
		if (totalChars < CHIEF_OF_STAFF_MIN_DOMAIN_OUTPUT_CHARS) continue

		const messageId = typeof message.id === 'string' ? message.id : null
		const sessionId = typeof envelope.session_id === 'string' ? envelope.session_id : null
		return { chars: totalChars, messageId, sessionId }
	}
	return null
}

interface CoSActorLookup {
	isChiefOfStaff: boolean
	workspaceId: string
	actorId: string
}

/**
 * Best-effort lookup — resolves the session's actor and reports whether it's
 * the Chief of Staff (default `isSystem` agent with the fixed name). Returns
 * `null` for unknown sessions. Callers are expected to memoise the result per
 * sessionId; this function does not cache internally so it can be tested in
 * isolation.
 */
export async function loadCoSSessionContext(
	db: Database,
	sessionId: string,
): Promise<CoSActorLookup | null> {
	const [row] = await db
		.select({
			workspaceId: sessions.workspaceId,
			actorId: sessions.actorId,
			actorName: actors.name,
			actorType: actors.type,
			isSystem: actors.isSystem,
		})
		.from(sessions)
		.innerJoin(actors, eq(actors.id, sessions.actorId))
		.where(eq(sessions.id, sessionId))
		.limit(1)
	if (!row) return null
	const isChiefOfStaff =
		row.actorType === 'agent' &&
		row.isSystem === true &&
		row.actorName === CHIEF_OF_STAFF_DISPLAY_NAME
	return { isChiefOfStaff, workspaceId: row.workspaceId, actorId: row.actorId }
}

interface TrackDomainOutputProps {
	workspaceId: string
	sessionId: string
	actorId: string
	chars: number
	messageId: string | null
}

/**
 * Fire the thinness-violation event. `distinct_id` keys off the actor id so
 * PostHog joins line up with the client-side super-properties
 * (`registerWorkspaceProperties` in `apps/web`) even when the workspace is
 * anonymised — the client hashes only the browser distinct_id, actor_id rides
 * as a first-class property.
 */
export async function trackChiefOfStaffDomainOutputDetected(
	p: TrackDomainOutputProps,
): Promise<void> {
	try {
		await capturePosthogEvent('chief_of_staff_domain_output_detected', p.actorId, {
			workspace_id: p.workspaceId,
			session_id: p.sessionId,
			actor_id: p.actorId,
			chars: p.chars,
			message_id: p.messageId,
			source: 'agent',
		})
	} catch (err) {
		logger.warn('Failed to emit chief_of_staff_domain_output_detected', {
			sessionId: p.sessionId,
			error: String(err),
		})
	}
}
