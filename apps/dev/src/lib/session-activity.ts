import type { SessionActivityStep, SessionActivityTurn } from '@maskin/shared'

/**
 * Server-side port of the web's `segmentActivityByMessage`
 * (apps/web/src/components/agents/session-log-transcript.tsx): turns a
 * session's raw stream-json log rows into per-message activity turns so a
 * phone never has to download and parse thousands of raw envelopes.
 *
 * Pure: no DB access. Rows must be in ascending id order. Steps logged before
 * the first tagged turn boundary (sessions predating `maskin_message_id`
 * tagging) are dropped.
 */

export interface ActivityLogRow {
	id: number
	stream: string
	content: string
	createdAt: Date | null
}

export const MAX_STEPS_PER_TURN = 100
const MAX_LABEL = 120
const MAX_DETAIL = 300
const MAX_RESULT_TEXT = 8000
const REPLY_LABEL = 'Replied to the conversation.'
/** Input keys worth surfacing as a tool call's one-line detail, in priority order. */
const DETAIL_KEYS = ['description', 'command', 'file_path', 'path', 'pattern', 'query', 'url']

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function truncate(text: string, max: number): string {
	const t = text.replace(/\s+/g, ' ').trim()
	return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`
}

function iso(d: Date | null): string | null {
	return d ? d.toISOString() : null
}

function isReplyTool(name: string): boolean {
	return name === 'post_conversation_message' || name.endsWith('__post_conversation_message')
}

function toolDetail(input: unknown): string | undefined {
	if (!isRecord(input)) return undefined
	for (const key of DETAIL_KEYS) {
		const v = input[key]
		if (typeof v === 'string' && v.trim().length > 0) return truncate(v, MAX_DETAIL)
	}
	return undefined
}

interface OpenTurn {
	turn: SessionActivityTurn
	/** All steps ever pushed (truncation is applied at the end). */
	steps: SessionActivityStep[]
}

export function buildSessionActivity(rows: ActivityLogRow[]): SessionActivityTurn[] {
	const turns: OpenTurn[] = []
	let current: OpenTurn | null = null
	/** tool_use id -> its step, so a later tool_result can close it. */
	const toolSteps = new Map<string, SessionActivityStep>()

	for (const row of rows) {
		if (row.stream === 'stderr') {
			current?.steps.push({
				id: `${row.id}-stderr`,
				kind: 'error',
				label: truncate(row.content, MAX_LABEL),
				started_at: iso(row.createdAt),
				finished_at: iso(row.createdAt),
				status: 'failed',
			})
			continue
		}
		if (row.stream !== 'stdout') continue

		let env: unknown
		try {
			env = JSON.parse(row.content)
		} catch {
			continue
		}
		if (!isRecord(env)) continue
		const at = iso(row.createdAt)

		switch (env.type) {
			case 'user': {
				if (env.maskin_retry === true) {
					// Replay of the same turn: reopen it and retract the failed result.
					if (current) {
						current.turn.result = null
						current.turn.status = 'running'
						current.turn.finished_at = null
					}
					break
				}
				const mid = env.maskin_message_id
				if (typeof mid === 'number' && Number.isFinite(mid)) {
					current = {
						turn: {
							message_id: mid,
							started_at: at,
							finished_at: null,
							status: 'running',
							contains_reply: false,
							result: null,
							steps: [],
							steps_truncated: false,
						},
						steps: [],
					}
					turns.push(current)
					break
				}
				// Tool-result echoes close the matching tool step.
				const content = isRecord(env.message) ? env.message.content : undefined
				if (Array.isArray(content)) {
					for (const block of content) {
						if (!isRecord(block) || block.type !== 'tool_result') continue
						const step =
							typeof block.tool_use_id === 'string' ? toolSteps.get(block.tool_use_id) : undefined
						if (!step) continue
						step.finished_at = at
						step.status = block.is_error === true ? 'failed' : 'completed'
					}
				}
				break
			}
			case 'assistant': {
				const open = current
				const content = isRecord(env.message) ? env.message.content : undefined
				if (!Array.isArray(content) || !open) break
				content.forEach((block, index) => {
					if (!isRecord(block)) return
					const id = `${row.id}-${index}`
					if (block.type === 'tool_use') {
						const name = typeof block.name === 'string' ? block.name : null
						if (name === null) return
						const reply = isReplyTool(name)
						if (reply) open.turn.contains_reply = true
						const detail = reply ? undefined : toolDetail(block.input)
						const step: SessionActivityStep = {
							id,
							kind: 'tool_use',
							label: reply ? REPLY_LABEL : truncate(`Using ${name}`, MAX_LABEL),
							...(detail ? { detail } : {}),
							started_at: at,
							finished_at: null,
							status: 'running',
						}
						if (typeof block.id === 'string') toolSteps.set(block.id, step)
						open.steps.push(step)
					} else if (block.type === 'thinking') {
						const text =
							(typeof block.thinking === 'string' && block.thinking) ||
							(typeof block.text === 'string' && block.text) ||
							''
						const redacted = text.length === 0 && typeof block.signature === 'string'
						if (text.length === 0 && !redacted) return
						open.steps.push({
							id,
							kind: 'thinking',
							label: redacted ? 'Thinking (redacted)…' : 'Thinking…',
							started_at: at,
							finished_at: at,
							status: 'completed',
						})
					} else if (block.type === 'text' && typeof block.text === 'string') {
						const label = truncate(block.text, 80)
						if (!label) return
						// Wrap-up text right after the reply tool just restates it.
						const prev = open.steps[open.steps.length - 1]
						if (prev?.kind === 'tool_use' && prev.label === REPLY_LABEL) return
						open.steps.push({
							id,
							kind: 'text',
							label,
							started_at: at,
							finished_at: at,
							status: 'completed',
						})
					}
				})
				break
			}
			case 'result': {
				if (!current) break
				const isError = env.is_error === true
				const text = typeof env.result === 'string' ? env.result : ''
				current.turn.finished_at = at
				current.turn.status = isError ? 'failed' : 'completed'
				current.turn.result = text
					? { text: text.slice(0, MAX_RESULT_TEXT), is_error: isError, log_id: row.id }
					: null
				// A closed turn cannot still have tools in flight.
				for (const s of current.steps) {
					if (s.status === 'running') {
						s.status = isError ? 'failed' : 'completed'
						s.finished_at = at
					}
				}
				break
			}
			case 'error': {
				const msg =
					typeof env.message === 'string'
						? env.message
						: typeof env.error === 'string'
							? env.error
							: ''
				current?.steps.push({
					id: `${row.id}-0`,
					kind: 'error',
					label: truncate(msg || 'Error', MAX_LABEL),
					started_at: at,
					finished_at: at,
					status: 'failed',
				})
				break
			}
		}
	}

	return turns.map(({ turn, steps }) => {
		const truncated = steps.length > MAX_STEPS_PER_TURN
		return {
			...turn,
			steps: truncated ? steps.slice(steps.length - MAX_STEPS_PER_TURN) : steps,
			steps_truncated: truncated,
		}
	})
}
