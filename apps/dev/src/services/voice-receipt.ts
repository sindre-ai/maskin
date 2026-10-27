import type { Database } from '@maskin/db'
import { actors, messages, objects, type voiceSessions } from '@maskin/db/schema'
import { type MessageMetadata, buildWebAppHref, resolveWebAppBaseUrl } from '@maskin/shared'
import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import { logger } from '../lib/logger'
import { insertConversationMessage } from './conversation-messages'
import {
	type VoiceCallState,
	cardIdOf,
	dropVoiceCallState,
	matchStartCard,
	peekVoiceCallState,
} from './voice-call-state'
import { type VoiceSessionRow, ensureVoiceConversation } from './voice-transcript'

/**
 * The receipt of a Live call: what it actually did, written by the server, not by the model.
 *
 * Two kinds of chat message, both with metadata source voice and the call's voice_session_id:
 *   kind receipt          one per write the call ran, failed or left undone, as it happens
 *   kind receipt_summary  one when the call ends, however it ends
 *
 * They go through insertConversationMessage, never the POST /messages route, so no agent is woken,
 * and they are not final_output messages, so no push is sent. Unlike a spoken line they are posted
 * whether or not the workspace keeps transcripts: they record actions, not speech.
 *
 * The closing summary is built from the saved per-write rows, not from memory, so a server restart
 * mid-call does not lose them. Only a hold still waiting for a yes and the start-of-call cards are
 * in memory (voice-call-state.ts); when a restart lost them the summary says unknown.
 *
 * No receipt number and no event holds card, draft or transcript text. A per-write line does name
 * the object it touched by its title, because that is what the person reads in the chat.
 */

export type ReceiptEvent =
	| 'created_bet'
	| 'created_task'
	| 'opened_task'
	| 'moved_to_review'
	| 'decided'
	| 'other'
export type ReceiptOutcome = 'ran' | 'failed' | 'not_done'

/** Largest closing receipt: this many lines and about this many characters, then "and N more". */
export const VOICE_SUMMARY_MAX_LINES = 25
export const VOICE_SUMMARY_MAX_CHARS = 2_000
const TITLE_MAX = 120
const REASON_MAX = 120
/** Most objects a single create or update call gets a line for. */
const LINES_PER_CALL_MAX = 5

const oneLine = (value: string, max: number) => value.replace(/\s+/g, ' ').trim().slice(0, max)
const escapeLabel = (text: string) => text.replace(/[[\]\\]/g, '\\$&')
const isUuid = (value: unknown): value is string =>
	typeof value === 'string' &&
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)

export function humanToolName(tool: string): string {
	return tool.replace(/__/g, ' / ').replace(/_/g, ' ')
}

// ── What a tool call did ─────────────────────────────────────────────

/** One thing a tool call did, before it is written as a line. */
export interface ReceiptDraft {
	event: ReceiptEvent
	objectId: string | null
	objectType: string | null
	objectTitle: string | null
	/** The sentence with {title} where the object's name goes. */
	template: string
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
	value && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null

/** Every object id a call's arguments point at, in order, without repeats. */
export function targetIdsOf(args: unknown): string[] {
	const found: string[] = []
	const add = (value: unknown) => {
		if (isUuid(value) && !found.includes(value.toLowerCase())) found.push(value.toLowerCase())
	}
	const record = asRecord(args)
	if (!record) return found
	for (const key of ['object_id', 'entity_id', 'id', 'notification_id']) add(record[key])
	for (const key of ['ids', 'object_ids']) {
		const list = record[key]
		if (Array.isArray(list)) for (const value of list) add(value)
	}
	for (const key of ['updates', 'objects']) {
		const list = record[key]
		if (Array.isArray(list)) for (const entry of list) add(asRecord(entry)?.id)
	}
	return found
}

async function lookupObjects(db: Database, workspaceId: string, ids: string[]) {
	if (ids.length === 0) return new Map<string, { title: string; type: string }>()
	const rows = await db
		.select({ id: objects.id, title: objects.title, type: objects.type })
		.from(objects)
		.where(and(eq(objects.workspaceId, workspaceId), inArray(objects.id, ids)))
	return new Map(rows.map((r) => [r.id, { title: r.title ?? '', type: r.type }]))
}

/** The ids a tool's JSON result reports it created, in order. Empty when the result is not that shape. */
function createdIdsOf(resultText: string | null): string[] {
	if (!resultText) return []
	try {
		const parsed = asRecord(JSON.parse(resultText))
		const results = parsed?.results
		if (!Array.isArray(results)) return []
		return results.map((r) => (isUuid(asRecord(r)?.id) ? String(asRecord(r)?.id) : ''))
	} catch {
		return []
	}
}

const statusLabel = (status: string) => status.replace(/_/g, ' ')

/**
 * Turns one tool call into the lines it earns. `cards` is the call's start-of-call card list, used
 * to tell a decision card answered apart from an ordinary comment.
 */
export async function describeToolCall(input: {
	db: Database
	workspaceId: string
	tool: string
	args: unknown
	resultText: string | null
	state: Pick<VoiceCallState, 'startCards'>
}): Promise<ReceiptDraft[]> {
	const { db, workspaceId, tool, state } = input
	const args = asRecord(input.args) ?? {}

	if (tool === 'create_objects') {
		const list = Array.isArray(args.objects) ? args.objects : []
		const createdIds = createdIdsOf(input.resultText)
		return list.slice(0, LINES_PER_CALL_MAX).map((entry, i) => {
			const o = asRecord(entry) ?? {}
			const type = typeof o.type === 'string' ? o.type : 'object'
			const title = typeof o.title === 'string' ? oneLine(o.title, TITLE_MAX) : ''
			return {
				event: type === 'bet' ? 'created_bet' : type === 'task' ? 'created_task' : 'other',
				objectId: createdIds[i] || null,
				objectType: type,
				objectTitle: title || null,
				template: `Created ${type} {title}`,
			}
		})
	}

	const ids = targetIdsOf(args)
	const known = await lookupObjects(db, workspaceId, ids.slice(0, LINES_PER_CALL_MAX))
	const nameOf = (id: string) => oneLine(known.get(id)?.title ?? '', TITLE_MAX) || null

	if (tool === 'update_objects') {
		const updates = (Array.isArray(args.updates) ? args.updates : []).slice(0, LINES_PER_CALL_MAX)
		return updates.map((entry) => {
			const u = asRecord(entry) ?? {}
			const id = isUuid(u.id) ? u.id.toLowerCase() : null
			const type = id ? (known.get(id)?.type ?? null) : null
			const status = typeof u.status === 'string' ? u.status : null
			const moved = status === 'in_review' && type === 'task'
			return {
				event: moved ? 'moved_to_review' : 'other',
				objectId: id,
				objectType: type,
				objectTitle: id ? nameOf(id) : null,
				template: moved
					? 'Moved task {title} to review'
					: status
						? `Set {title} to ${statusLabel(status)}`
						: 'Edited {title}',
			}
		})
	}

	if (tool === 'get_objects') {
		const id = ids.length === 1 ? (ids[0] as string) : null
		if (id && known.get(id)?.type === 'task') {
			return [
				{
					event: 'opened_task',
					objectId: id,
					objectType: 'task',
					objectTitle: nameOf(id),
					template: 'Opened task {title}',
				},
			]
		}
		return []
	}

	const target = ids[0] ?? null
	if (tool === 'create_comment') {
		const card = target ? matchStartCard(state, [target]) : null
		const decided = card?.source === 'decision'
		return [
			{
				event: decided ? 'decided' : 'other',
				objectId: target,
				objectType: target ? (known.get(target)?.type ?? null) : null,
				objectTitle: target ? nameOf(target) : null,
				template: decided ? 'Answered {title}' : 'Commented on {title}',
			},
		]
	}

	return [
		{
			event: 'other',
			objectId: target,
			objectType: target ? (known.get(target)?.type ?? null) : null,
			objectTitle: target ? nameOf(target) : null,
			template: target ? `Ran ${humanToolName(tool)} on {title}` : `Ran ${humanToolName(tool)}`,
		},
	]
}

// ── Per-write lines ──────────────────────────────────────────────────

/** What the write gate knew about a send that went through a yes. */
export interface ReceiptSendInfo {
	yesCount: number
	/** True when the text read back before the yes is the text sent; null when no preview could be made. */
	readBackMatches: boolean | null
}

export interface ReceiptLineInput {
	db: Database
	session: Pick<VoiceSessionRow, 'id' | 'workspaceId' | 'humanActorId' | 'agentActorId'> & {
		startedAt?: Date
	}
	agentName: string
	tool: string
	draft: ReceiptDraft
	outcome: ReceiptOutcome
	/** Why it failed or was not done; one short plain sentence. */
	reason?: string
	/** Set when the write went through the write gate. */
	send?: ReceiptSendInfo
	/** The start-of-call card this write was about, when it was one. */
	cardId?: string | null
	nowMs: number
	webAppBaseUrl?: string
}

function sentence(template: string, title: string | null, linked: boolean, href: string | null) {
	const name = title ?? 'an item'
	const shown = linked && href ? `[${escapeLabel(name)}](${href})` : `"${name}"`
	return template.replace('{title}', shown)
}

/** Writes one receipt line into the call's chat. Returns the chat it landed in. */
export async function postReceiptLine(input: ReceiptLineInput): Promise<string> {
	const { db, session, draft } = input
	const base = input.webAppBaseUrl ?? resolveWebAppBaseUrl(process.env)
	const href = draft.objectId
		? buildWebAppHref(base, session.workspaceId, { kind: 'object', id: draft.objectId })
		: null
	const reason = input.reason ? oneLine(input.reason, REASON_MAX) : null
	const wrap = (sentenceText: string) =>
		input.outcome === 'failed'
			? `${sentenceText}: failed${reason ? ` (${reason})` : ''}`
			: input.outcome === 'not_done'
				? `Not done: ${sentenceText}.${reason ? ` ${reason}` : ''}`
				: sentenceText
	const text = wrap(sentence(draft.template, draft.objectTitle, false, null))
	const content = wrap(sentence(draft.template, draft.objectTitle, true, href))
	const t = session.startedAt
		? Math.max(0, Math.floor((input.nowMs - session.startedAt.getTime()) / 1000))
		: 0

	const conversationId = await ensureVoiceConversation(db, session, input.agentName)
	const message = await insertConversationMessage(db, {
		conversationId,
		workspaceId: session.workspaceId,
		actorId: session.agentActorId,
		content,
		metadata: {
			source: 'voice',
			voice_session_id: session.id,
			kind: 'receipt',
			event: draft.event,
			object_id: draft.objectId,
			text,
			t,
			outcome: input.outcome,
			tool: input.tool,
			...(draft.objectType ? { object_type: draft.objectType } : {}),
			...(draft.objectTitle ? { object_title: draft.objectTitle } : {}),
			...(input.send
				? {
						held: true,
						yes_count: input.send.yesCount,
						read_back_matches: input.send.readBackMatches,
					}
				: {}),
			...(input.cardId ? { card_id: input.cardId } : {}),
		} as MessageMetadata,
		sessionId: null,
		// A receipt is not something said in the chat, so it is not copied as a comment onto the
		// object the chat is about.
		skipObjectMirror: true,
	})
	if (!message) throw new Error('receipt message insert was suppressed')
	return conversationId
}

/** The line for a hold that ended without running. */
export function notDoneDraft(summary: string): ReceiptDraft {
	return {
		event: 'other',
		objectId: null,
		objectType: null,
		objectTitle: null,
		template: oneLine(summary, TITLE_MAX).replace(/\{title\}/g, '') || 'A change',
	}
}

// ── Closing summary ──────────────────────────────────────────────────

export interface ReceiptRow {
	id: number
	event: ReceiptEvent
	outcome: ReceiptOutcome
	text: string
	objectId: string | null
	objectType: string | null
	objectTitle: string | null
	tool: string | null
	held: boolean
	yesCount: number | null
	readBackMatches: boolean | null
	cardId: string | null
}

async function loadReceiptRows(
	db: Database,
	conversationId: string,
	voiceSessionId: string,
): Promise<ReceiptRow[]> {
	const rows = await db
		.select({ id: messages.id, metadata: messages.metadata })
		.from(messages)
		.where(
			and(
				eq(messages.conversationId, conversationId),
				sql`${messages.metadata}->>'voice_session_id' = ${voiceSessionId}`,
				sql`${messages.metadata}->>'kind' = 'receipt'`,
			),
		)
		.orderBy(asc(messages.id))
	return rows.map((row) => {
		const m = asRecord(row.metadata) ?? {}
		const str = (key: string) => (typeof m[key] === 'string' ? (m[key] as string) : null)
		return {
			id: row.id,
			event: (str('event') as ReceiptEvent | null) ?? 'other',
			outcome: (str('outcome') as ReceiptOutcome | null) ?? 'ran',
			text: str('text') ?? '',
			objectId: str('object_id'),
			objectType: str('object_type'),
			objectTitle: str('object_title'),
			tool: str('tool'),
			held: m.held === true,
			yesCount: typeof m.yes_count === 'number' ? m.yes_count : null,
			readBackMatches: typeof m.read_back_matches === 'boolean' ? m.read_back_matches : null,
			cardId: str('card_id'),
		}
	})
}

const END_REASON_WORDS: Record<string, string> = {
	user_hangup: 'hangup',
	idle_timeout: 'idle timeout',
	vendor_error: 'vendor error',
	network_error: 'socket drop',
	server_stop: 'server stop',
}

export interface ReceiptNumbers {
	/** Number 1: the top card of the ranked list when the call began. unknown when it was not kept. */
	rank_1_card_at_start: string
	/** Number 2: the first start-of-call card the call showed, opened or changed. */
	first_card_named: string
	/** True/false when both of the above are known; null when either is not. */
	first_card_is_rank_1: boolean | null
	/** Number 3: distinct cards where a voice action ran ok. */
	cards_cleared: number
	/** Numbers 4 and 5: one entry per send that went through a yes. */
	sends: Array<{
		tool: string
		outcome: ReceiptOutcome
		read_back_matches: boolean | null
		yes_count: number
	}>
	/** Number 6: one of user_hangup, idle_timeout, vendor_error, network_error, server_stop. */
	end_reason: string
}

export interface ReceiptCounts {
	cardsCleared: number
	writesHeld: number
	writesDone: number
	posted: boolean
}

const EMPTY_COUNTS: ReceiptCounts = { cardsCleared: 0, writesHeld: 0, writesDone: 0, posted: false }

export function buildReceiptNumbers(
	rows: ReceiptRow[],
	state: VoiceCallState | undefined,
	endReason: string,
): ReceiptNumbers {
	const rank1 = state?.startCards
		? state.startCards[0]
			? (cardIdOf(state.startCards[0]) ?? 'none')
			: 'none'
		: 'unknown'
	const first = state
		? (state.firstCardNamed ?? (state.startCards ? 'none' : 'unknown'))
		: 'unknown'
	const comparable = !['unknown', 'none'].includes(rank1) && !['unknown', 'none'].includes(first)
	return {
		rank_1_card_at_start: rank1,
		first_card_named: first,
		first_card_is_rank_1: comparable ? rank1 === first : null,
		cards_cleared: new Set(rows.filter((r) => r.outcome === 'ran' && r.cardId).map((r) => r.cardId))
			.size,
		sends: rows
			.filter((r) => r.held)
			.map((r) => ({
				tool: r.tool ?? 'unknown',
				outcome: r.outcome,
				read_back_matches: r.readBackMatches,
				yes_count: r.yesCount ?? 0,
			})),
		end_reason: endReason,
	}
}

const short = (id: string) => (id.length > 8 ? id.slice(0, 8) : id)

/** The numbers as one plain sentence group. Ids and counts only, never card or draft text. */
export function numbersInWords(n: ReceiptNumbers): string {
	const first =
		n.first_card_is_rank_1 === true
			? 'The first card named was the top card.'
			: n.first_card_is_rank_1 === false
				? `The first card named (${short(n.first_card_named)}) was not the top card (${short(n.rank_1_card_at_start)}).`
				: `Top card at start: ${n.rank_1_card_at_start === 'unknown' ? 'unknown' : n.rank_1_card_at_start === 'none' ? 'none' : short(n.rank_1_card_at_start)}. First card named: ${n.first_card_named === 'unknown' || n.first_card_named === 'none' ? n.first_card_named : short(n.first_card_named)}.`
	const sends = n.sends.length
		? n.sends
				.map((s, i) => {
					const back =
						s.read_back_matches === null
							? 'no preview to compare'
							: s.read_back_matches
								? 'read-back matched'
								: 'read-back did not match'
					const yes = `${s.yes_count} ${s.yes_count === 1 ? 'yes' : 'yeses'}`
					return `Send ${i + 1}: ${back}, ${yes}${s.outcome === 'ran' ? '' : ', not sent'}.`
				})
				.join(' ')
		: 'No sends.'
	const ended = END_REASON_WORDS[n.end_reason] ?? n.end_reason
	return `${first} Cards cleared: ${n.cards_cleared}. ${sends} Call ended by ${ended}.`
}

const minutesWords = (seconds: number) =>
	seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`

/** Closes a call with its receipt. Called once, from the one place every call ends. */
export async function postClosingReceipt(
	db: Database,
	ended: typeof voiceSessions.$inferSelect,
	opts: { reason: string; webAppBaseUrl?: string } = { reason: 'user_hangup' },
): Promise<ReceiptCounts> {
	const state = peekVoiceCallState(ended.id)
	try {
		// Lines still being written for the last tool call or a hold that just ended.
		if (state) await Promise.allSettled([...state.inflight])

		const conversationId = ended.conversationId
		const rows = conversationId ? await loadReceiptRows(db, conversationId, ended.id) : []
		const pending = state?.pendingHold?.() ?? null
		const counts: ReceiptCounts = {
			cardsCleared: new Set(
				rows.filter((r) => r.outcome === 'ran' && r.cardId).map((r) => r.cardId),
			).size,
			writesHeld: rows.filter((r) => r.held).length + (pending ? 1 : 0),
			writesDone: rows.filter((r) => r.outcome === 'ran').length,
			posted: false,
		}
		// A call that never got going leaves nothing to report and does not get a chat made for it.
		if (ended.turnCount === 0 && ended.toolCallsCount === 0 && rows.length === 0 && !pending) {
			return counts
		}
		// One closing receipt per call, even if this ever ran twice.
		if (conversationId) {
			const [already] = await db
				.select({ id: messages.id })
				.from(messages)
				.where(
					and(
						eq(messages.conversationId, conversationId),
						sql`${messages.metadata}->>'voice_session_id' = ${ended.id}`,
						sql`${messages.metadata}->>'kind' = 'receipt_summary'`,
					),
				)
				.limit(1)
			if (already) return { ...counts, posted: true }
		}

		const base = opts.webAppBaseUrl ?? resolveWebAppBaseUrl(process.env)
		const durationSeconds = Math.max(
			0,
			Math.floor(((ended.endedAt ?? new Date()).getTime() - ended.startedAt.getTime()) / 1000),
		)
		const numbers = buildReceiptNumbers(rows, state, opts.reason)

		const ran = rows.filter((r) => r.outcome === 'ran')
		const failed = rows.filter((r) => r.outcome === 'failed')
		const notDone = rows.filter((r) => r.outcome === 'not_done')
		const notDoneTexts = [
			...notDone.map((r) => r.text),
			...(pending
				? [`Not done: ${pending.summary}. The call ended before your yes was used.`]
				: []),
		]
		const decided = ran.filter((r) => r.event === 'decided').map((r) => r.text)
		const created = ran
			.filter((r) => r.event === 'created_bet' || r.event === 'created_task')
			.map((r) => ({
				type: r.objectType ?? (r.event === 'created_bet' ? 'bet' : 'task'),
				title: r.objectTitle ?? '',
				object_id: r.objectId,
			}))
		const next = ran
			.filter((r) => r.event === 'moved_to_review')
			.map((r) => `Review: ${r.objectTitle ?? r.text}`)

		const linkOf = (r: ReceiptRow) =>
			r.objectId && r.objectTitle
				? `[${escapeLabel(r.objectTitle)}](${buildWebAppHref(base, ended.workspaceId, { kind: 'object', id: r.objectId })})`
				: null
		const lineFor = (r: ReceiptRow) => {
			const link = linkOf(r)
			return `- ${link && r.objectTitle ? r.text.replace(`"${r.objectTitle}"`, link) : r.text}`
		}

		const header = `**Call receipt** (${minutesWords(durationSeconds)})`
		const footer = numbersInWords(numbers)
		const body: string[] = []
		const section = (title: string, lines: string[]) => {
			if (lines.length === 0) return
			body.push(`${title}:`, ...lines)
		}
		section('Done', ran.map(lineFor))
		section('Failed', failed.map(lineFor))
		body.push(...notDoneTexts.map((t) => `- ${t}`))
		if (body.length === 0) body.push('Nothing was changed.')

		const reserved = [header, footer]
		let used = reserved.join('\n').length
		const kept: string[] = []
		for (const line of body) {
			const room = reserved.length + kept.length < VOICE_SUMMARY_MAX_LINES - 1
			if (!room || used + line.length + 1 > VOICE_SUMMARY_MAX_CHARS - 40) break
			kept.push(line)
			used += line.length + 1
		}
		const more = body.length - kept.length
		const content = [header, ...kept, ...(more > 0 ? [`and ${more} more`] : []), footer].join('\n')

		const agentName = await db
			.select({ name: actors.name })
			.from(actors)
			.where(eq(actors.id, ended.agentActorId))
			.limit(1)
			.then((r) => r[0]?.name ?? 'the agent')
		const targetConversation = await ensureVoiceConversation(db, ended, agentName)
		const message = await insertConversationMessage(db, {
			conversationId: targetConversation,
			workspaceId: ended.workspaceId,
			actorId: ended.agentActorId,
			content,
			metadata: {
				source: 'voice',
				voice_session_id: ended.id,
				kind: 'receipt_summary',
				duration_seconds: durationSeconds,
				decided,
				created,
				next,
				not_done: notDoneTexts,
				numbers,
			} as MessageMetadata,
			sessionId: null,
			skipObjectMirror: true,
		})
		return { ...counts, posted: message !== null }
	} catch (err) {
		logger.warn('Voice closing receipt failed', {
			voice_session_id: ended.id,
			error: err instanceof Error ? err.message : String(err),
		})
		return EMPTY_COUNTS
	} finally {
		dropVoiceCallState(ended.id)
	}
}
