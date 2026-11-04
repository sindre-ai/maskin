import type { Database } from '@maskin/db'
import {
	events,
	INTEGRATION_STATUS_ACTIVE,
	actors,
	conversationParticipants,
	integrations,
	workspaceMembers,
} from '@maskin/db/schema'
import { and, asc, desc, eq, gt, inArray, sql } from 'drizzle-orm'
import {
	trackCapabilityNoteSent,
	trackCapabilityNoteSkipped,
} from '../lib/analytics/capability-events'
import {
	type HolderContext,
	type HolderSource,
	holdersForSources,
	recipientCanAct,
	visibleHolders,
} from '../lib/capabilities/holders'
import { type NoteItem, buildCapabilityNote } from '../lib/capabilities/note-template'
import { sha256 } from '../lib/capabilities/schema-hash'
import { BUILTIN_SOURCE_KEY } from '../lib/capabilities/sources'
import { findChiefOfStaffId } from '../lib/chief-of-staff'
import { recordEvent } from '../lib/events/record-event'
import { FLAGS, isFlagEnabledForWorkspace } from '../lib/feature-flags'
import { getProvider } from '../lib/integrations/registry'
import { logger } from '../lib/logger'
import { findDirectChat } from './direct-chat'
import { isOptedOut, sendProactiveMessage } from './proactive-message'

/**
 * The half of the capability bet a person actually reads. Runs at the end of
 * each scanner tick, per workspace, as a server job: the note is a template,
 * there is no model call and no session. Findings are the capability_changed
 * events the scanner wrote; this file decides who hears about which of them.
 *
 * Who may use a source and who may be told about it come from holders.ts only.
 * Nothing here writes an agent, an integration or a grant.
 */

export const DIGEST_ACTIONS = {
	sent: 'capability_digest_sent',
	skipped: 'capability_note_skipped',
} as const

/** The reason on the delivery marker, which the weekly cap keys on. */
export const CAPABILITY_NOTE_REASON = 'capability_note'

const CHANGED_ACTION = 'capability_changed'
const ELIGIBLE_KINDS = ['tool_added', 'needs_reconnect', 'available_not_attached'] as const
const RECENT_CHAT_DAYS = 30
const DAY_MS = 24 * 60 * 60 * 1000

export interface DigestSummary {
	sent: number
	skipped: Record<string, number>
}

export interface CapabilityDigestOptions {
	now?: () => Date
}

interface PendingFinding {
	id: number
	source: string
	kind: (typeof ELIGIBLE_KINDS)[number]
	tools: string[]
	scopes: string[]
}

export async function runCapabilityDigest(
	db: Database,
	workspaceId: string,
	options: CapabilityDigestOptions = {},
): Promise<DigestSummary> {
	const now = options.now ?? (() => new Date())
	const summary: DigestSummary = { sent: 0, skipped: {} }
	// Off by default in every workspace. Findings stay pending, so they merge into
	// the first note once the flag goes on.
	if (!isFlagEnabledForWorkspace(workspaceId, FLAGS.AGENT_PROACTIVE_1_1)) {
		summary.skipped.flag_off = 1
		return summary
	}
	const senderId = await findChiefOfStaffId(db, workspaceId)
	if (!senderId) {
		summary.skipped.no_chief_of_staff = 1
		return summary
	}

	const humans = await db
		.select({ id: actors.id, name: actors.name })
		.from(workspaceMembers)
		.innerJoin(actors, eq(actors.id, workspaceMembers.actorId))
		.where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(actors.type, 'human')))
		.orderBy(asc(actors.createdAt), asc(actors.id))

	for (const human of humans) {
		try {
			const outcome = await digestForRecipient(db, {
				workspaceId,
				senderId,
				recipientId: human.id,
				recipientName: human.name,
				now: now(),
			})
			if (outcome === 'sent') summary.sent++
			else if (outcome) summary.skipped[outcome] = (summary.skipped[outcome] ?? 0) + 1
		} catch (err) {
			// One person's failure never stops the tick; their findings stay pending.
			logger.error('Capability digest failed for recipient', {
				workspaceId,
				recipientId: human.id,
				error: err instanceof Error ? err.message : String(err),
			})
		}
	}
	return summary
}

interface RecipientRun {
	workspaceId: string
	senderId: string
	recipientId: string
	recipientName: string
	now: Date
}

/** Returns 'sent', a skip reason that was recorded, or null for a quiet week. */
async function digestForRecipient(db: Database, run: RecipientRun): Promise<string | null> {
	const { workspaceId, senderId, recipientId } = run
	const chat = await findDirectChat(db, { workspaceId, humanId: recipientId, agentId: senderId })
	const last = chat ? await lastDigest(db, workspaceId, chat.id) : null

	const pending = await pendingFindings(db, workspaceId, last?.upToEventId ?? 0)
	if (pending.length === 0) return null

	const skip = async (reason: string) => {
		await recordSkip(db, { ...run, reason, conversationId: chat?.id ?? null })
		return reason
	}

	// Never create a chat: a person who has no 1-1 with Chief of Staff is not messaged.
	if (!chat) return skip('no_direct_chat')
	// A person who replied stop keeps their findings pending; they merge into the next note on start.
	if (await isOptedOut(db, { conversationId: chat.id, recipientHumanId: recipientId })) {
		return skip('opted_out')
	}
	if (!(await activeWithin(db, run, chat.id, RECENT_CHAT_DAYS))) return skip('inactive_chat')

	// The previous note has to be read before another goes out; findings stay pending and merge.
	if (last) {
		const [state] = await db
			.select({ lastRead: conversationParticipants.lastReadMessageId })
			.from(conversationParticipants)
			.where(
				and(
					eq(conversationParticipants.conversationId, chat.id),
					eq(conversationParticipants.actorId, recipientId),
				),
			)
			.limit(1)
		if ((state?.lastRead ?? 0) < last.messageId) return skip('unread_previous_note')
	}

	const items = await buildItems(db, run, pending)
	if (items.noteItems.length === 0) return skip('nothing_to_say')

	const upToEventId = Math.max(...pending.map((f) => f.id))
	const note = buildCapabilityNote({
		firstName: run.recipientName.trim().split(/\s+/)[0] ?? '',
		items: items.noteItems,
	})
	const dedupeKey = `capability-note:${sha256(`${recipientId}:${upToEventId}`).slice(0, 32)}`

	const result = await sendProactiveMessage(db, {
		workspaceId,
		senderAgentId: senderId,
		recipientHumanId: recipientId,
		reason: CAPABILITY_NOTE_REASON,
		content: note.content,
		dedupeKey,
	})

	if (!result.sent) {
		// A crash between the send and the cursor write leaves the note in the chat and the
		// cursor behind. The same key then comes back as a duplicate: adopt the stored message.
		if (result.reason === 'duplicate') {
			const stored = await messageIdForDedupeKey(db, chat.id, dedupeKey)
			if (stored) {
				await recordSent(db, run, chat.id, stored, upToEventId, items.findingIds)
				return 'sent'
			}
		}
		return skip(result.reason)
	}

	await recordSent(db, run, result.conversationId, result.messageId, upToEventId, items.findingIds)
	await trackCapabilityNoteSent(senderId, {
		workspace_id: workspaceId,
		recipient_id: recipientId,
		conversation_id: result.conversationId,
		findings: items.findingIds.length,
		agents_affected: items.agentIds.size,
	}).catch((err) =>
		logger.warn('capability_note_sent capture failed', {
			workspaceId,
			error: err instanceof Error ? err.message : String(err),
		}),
	)
	return 'sent'
}

/** The newest note sent in this chat: where the cursor stands and which message to check as read. */
async function lastDigest(
	db: Database,
	workspaceId: string,
	conversationId: string,
): Promise<{ upToEventId: number; messageId: number } | null> {
	const [row] = await db
		.select({ data: events.data })
		.from(events)
		.where(
			and(
				eq(events.workspaceId, workspaceId),
				eq(events.entityId, conversationId),
				eq(events.action, DIGEST_ACTIONS.sent),
			),
		)
		.orderBy(desc(events.id))
		.limit(1)
	const data = row?.data as { up_to_event_id?: unknown; message_id?: unknown } | null
	if (!data) return null
	const upToEventId = Number(data.up_to_event_id)
	const messageId = Number(data.message_id)
	return Number.isFinite(upToEventId) && Number.isFinite(messageId)
		? { upToEventId, messageId }
		: null
}

async function pendingFindings(
	db: Database,
	workspaceId: string,
	afterEventId: number,
): Promise<PendingFinding[]> {
	const rows = await db
		.select({ id: events.id, data: events.data })
		.from(events)
		.where(
			and(
				eq(events.workspaceId, workspaceId),
				eq(events.action, CHANGED_ACTION),
				gt(events.id, afterEventId),
				inArray(sql`${events.data}->>'kind'`, [...ELIGIBLE_KINDS]),
			),
		)
		.orderBy(asc(events.id))
	const out: PendingFinding[] = []
	for (const row of rows) {
		const data = (row.data ?? {}) as Record<string, unknown>
		if (typeof data.source !== 'string') continue
		out.push({
			id: row.id,
			source: data.source,
			kind: data.kind as PendingFinding['kind'],
			tools: stringList(data.tools),
			scopes: stringList(data.missing_scopes ?? data.scopes),
		})
	}
	return out
}

function stringList(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

/** The person wrote in the chat, or opened it, within the window. */
async function activeWithin(
	db: Database,
	run: RecipientRun,
	conversationId: string,
	days: number,
): Promise<boolean> {
	const since = new Date(run.now.getTime() - days * DAY_MS).toISOString()
	const rows = (await db.execute(sql`
		SELECT 1 AS hit FROM messages
		WHERE conversation_id = ${conversationId}
			AND actor_id = ${run.recipientId}
			AND created_at >= ${since}::timestamptz
		UNION ALL
		SELECT 1 AS hit FROM events
		WHERE workspace_id = ${run.workspaceId}
			AND entity_id = ${conversationId}
			AND action = 'conversation_participant_state_updated'
			AND actor_id = ${run.recipientId}
			AND created_at >= ${since}::timestamptz
		LIMIT 1
	`)) as unknown as unknown[]
	return rows.length > 0
}

function holderSourceFromKey(key: string): HolderSource | null {
	if (key === BUILTIN_SOURCE_KEY) return { key }
	const match = /^integration:([^:]+):([0-9a-f-]{36})$/i.exec(key)
	return match ? { key, provider: match[1], integrationId: match[2] } : null
}

function integrationName(source: HolderSource): string {
	if (!source.provider) return 'Maskin'
	try {
		return getProvider(source.provider).config.displayName
	} catch {
		return source.provider
	}
}

interface BuiltItems {
	noteItems: NoteItem[]
	findingIds: number[]
	agentIds: Set<string>
}

/**
 * Turns pending findings into note items for one person, at send time. The
 * holders stored on the finding are ignored: access can change in the weeks a
 * finding waits, so every source is asked again, and an agent is only named if
 * the person can already see it. Reconnect and unused-integration items go to
 * workspace owners and admins only.
 */
async function buildItems(
	db: Database,
	run: RecipientRun,
	pending: PendingFinding[],
): Promise<BuiltItems> {
	const ctx: HolderContext = { db, workspaceId: run.workspaceId }
	const sources = new Map<string, HolderSource>()
	for (const finding of pending) {
		const source = holderSourceFromKey(finding.source)
		if (source) sources.set(source.key, source)
	}
	const holders = await holdersForSources(ctx, [...sources.values()])
	const canAct = await recipientCanAct(ctx, run.recipientId)

	// A source whose integration was removed or switched off since the scan is not reported.
	const integrationIds = [...sources.values()].flatMap((s) =>
		s.integrationId ? [s.integrationId] : [],
	)
	const active = new Set<string>()
	if (integrationIds.length > 0) {
		const rows = await db
			.select({ id: integrations.id })
			.from(integrations)
			.where(
				and(
					eq(integrations.workspaceId, run.workspaceId),
					inArray(integrations.id, integrationIds),
					eq(integrations.status, INTEGRATION_STATUS_ACTIVE),
				),
			)
		for (const row of rows) active.add(row.id)
	}

	const newTools = new Map<string, { tools: Set<string>; ids: number[] }>()
	const reconnect = new Map<string, { scopes: Set<string>; ids: number[] }>()
	const unused = new Map<string, { ids: number[] }>()
	for (const finding of pending) {
		const source = sources.get(finding.source)
		if (!source) continue
		if (source.integrationId && !active.has(source.integrationId)) continue
		if (finding.kind === 'tool_added') {
			const entry = newTools.get(source.key) ?? { tools: new Set<string>(), ids: [] }
			for (const tool of finding.tools) entry.tools.add(tool)
			entry.ids.push(finding.id)
			newTools.set(source.key, entry)
		} else if (finding.kind === 'needs_reconnect') {
			if (!canAct) continue
			const entry = reconnect.get(source.key) ?? { scopes: new Set<string>(), ids: [] }
			for (const scope of finding.scopes) entry.scopes.add(scope)
			entry.ids.push(finding.id)
			reconnect.set(source.key, entry)
		} else {
			if (!canAct) continue
			const entry = unused.get(source.key) ?? { ids: [] }
			entry.ids.push(finding.id)
			unused.set(source.key, entry)
		}
	}

	const noteItems: NoteItem[] = []
	const findingIds: number[] = []
	const agentIds = new Set<string>()

	const visibleFor = (key: string) => visibleHolders(ctx, run.recipientId, holders.get(key) ?? [])

	for (const [key, entry] of newTools) {
		const source = sources.get(key) as HolderSource
		const visible = await visibleFor(key)
		if (visible.length === 0 || entry.tools.size === 0) continue
		for (const id of visible) agentIds.add(id)
		noteItems.push({
			kind: 'new_tools',
			integration: integrationName(source),
			tools: [...entry.tools].sort(),
			agents: await agentNames(db, visible),
		})
		findingIds.push(...entry.ids)
	}
	for (const [key, entry] of reconnect) {
		const source = sources.get(key) as HolderSource
		if ((await visibleFor(key)).length === 0) continue
		noteItems.push({
			kind: 'needs_reconnect',
			integration: integrationName(source),
			scopes: [...entry.scopes].sort(),
		})
		findingIds.push(...entry.ids)
	}
	for (const [key, entry] of unused) {
		const source = sources.get(key) as HolderSource
		// Someone can use it now: it is no longer unused, so there is nothing to say.
		if ((holders.get(key) ?? []).length > 0) continue
		noteItems.push({ kind: 'not_attached', integration: integrationName(source) })
		findingIds.push(...entry.ids)
	}
	return { noteItems, findingIds: findingIds.sort((a, b) => a - b), agentIds }
}

async function agentNames(db: Database, ids: string[]): Promise<string[]> {
	if (ids.length === 0) return []
	const rows = await db
		.select({ name: actors.name })
		.from(actors)
		.where(inArray(actors.id, ids))
		.orderBy(asc(actors.name))
	return rows.map((r) => r.name)
}

async function messageIdForDedupeKey(
	db: Database,
	conversationId: string,
	dedupeKey: string,
): Promise<number | null> {
	const rows = (await db.execute(sql`
		SELECT id FROM messages
		WHERE conversation_id = ${conversationId}
			AND metadata->'delivery'->>'dedupe_key' = ${dedupeKey}
		ORDER BY id LIMIT 1
	`)) as unknown as Array<{ id: number | string }>
	return rows[0] ? Number(rows[0].id) : null
}

async function recordSent(
	db: Database,
	run: RecipientRun,
	conversationId: string,
	messageId: number,
	upToEventId: number,
	findingIds: number[],
): Promise<void> {
	await recordEvent(db, {
		workspaceId: run.workspaceId,
		actorId: run.senderId,
		action: DIGEST_ACTIONS.sent,
		entityType: 'conversation',
		entityId: conversationId,
		data: {
			recipient_id: run.recipientId,
			up_to_event_id: upToEventId,
			finding_ids: findingIds,
			message_id: messageId,
		},
	})
}

async function recordSkip(
	db: Database,
	run: RecipientRun & { reason: string; conversationId: string | null },
): Promise<void> {
	await recordEvent(db, {
		workspaceId: run.workspaceId,
		actorId: run.senderId,
		action: DIGEST_ACTIONS.skipped,
		entityType: 'actor',
		entityId: run.recipientId,
		data: { reason: run.reason, conversation_id: run.conversationId },
	})
	await trackCapabilityNoteSkipped(run.senderId, run.reason).catch((err) =>
		logger.warn('capability_note_skipped capture failed', {
			workspaceId: run.workspaceId,
			error: err instanceof Error ? err.message : String(err),
		}),
	)
}
