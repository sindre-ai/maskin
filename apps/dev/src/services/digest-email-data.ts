/**
 * digest-email-data.ts — what the digest email lists for one person, read from the database.
 *
 * Two parts, as in the mail:
 *
 * Needs you: what waits on the person at send time. The cards come from `buildForYouItems`, the
 * one function the For You screen and the push read, once per workspace the person belongs to, so
 * the count matches the app. On top of that, chats where an agent asked the person a question
 * that is still unanswered (pending or seen `needs_input` rows with `push_category: needs_you` and
 * a conversation id, the rows the app clears on a reply). Not limited to the lookback window: an
 * item stays until it is answered. Muted workspaces still show here, as the push lets needs_you
 * through a mute.
 *
 * Updates: the person's own notifications (rows targeted at them, so mentions, handoffs and
 * reviews, never a bare status change) created inside the lookback window and still unread at send
 * time, not already in Needs you and not caused by the person. Unread is `pending` for a normal
 * row; a chat reply is stored `seen` with `push_only`, so it counts as unread while the push's own
 * read check (`hasReadThrough`) says the person has not read up to it. A flow-activity row is
 * `seen` + `push_only` too and has no read state, so it counts while inside the window. Rows group
 * by what they point to: a chat (one row per chat), a flow (one row per flow), any other object.
 * A row that points to none of these is left out. Muted workspaces are left out.
 *
 * Nothing here reads message text. A chat row carries the chat's title and a count, never a message.
 */
import type { Database } from '@maskin/db'
import {
	actors,
	conversations,
	notifications,
	objects,
	workspaceMembers,
	workspaces,
} from '@maskin/db/schema'
import { FOR_YOU_KIND } from '@maskin/shared'
import { and, asc, desc, eq, gt, inArray, ne, sql } from 'drizzle-orm'
import { buildForYouItems } from '../lib/for-you-items'
import { logger } from '../lib/logger'
import { clipAtWord as clip } from './email-layout'
import { hasReadThrough } from './notification-push'

/** Most waiting items shown in the mail; the rest fold into one "N more waiting" link. */
export const MAX_WAITING_ROWS = 3
/** Most rows per Updates group; the rest fold into one "N more in Maskin" link. */
export const MAX_GROUP_ROWS = 5
const MAX_WORKSPACES = 25
/** How many notification rows one person's digest reads at most; keeps a flooded inbox cheap. */
const MAX_UPDATE_ROWS_READ = 300
const MAX_QUESTION_ROWS_READ = 200
/** The push category a flow's activity banner carries (the same string as flow-activity.ts, not imported: that file imports the email scheduler, which imports this one). */
const FLOW_ACTIVITY_CATEGORY = 'flow_activity'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type GroupKind = 'objects' | 'flows' | 'chats'

export interface DigestWaitingRow {
	workspaceId: string
	title: string
	/** What is asked, one line; null leaves it out. */
	line: string | null
	/** "Bet", "Task", "Chat" and so on. */
	typeLabel: string
	/** Colour key for the label: bet, task, flow, chat, insight or anything else. */
	typeKind: string
	/** When it was asked. */
	at: Date
	/** When the person must decide by, if the card says so. */
	dueAt: Date | null
	/** App path without host or query, like /<workspace>/objects/<id>. */
	path: string
	buttonLabel: 'Review' | 'Reply'
}

export interface DigestUpdateRow {
	workspaceId: string
	title: string
	/** Who did what, without a time. The mail adds the time. */
	line: string
	at: Date
	path: string
}

export interface DigestGroup {
	kind: GroupKind
	/** Every row in the group, not only the shown ones. */
	count: number
	/** Newest first, at most MAX_GROUP_ROWS. */
	rows: DigestUpdateRow[]
}

export interface DigestData {
	/** Everything waiting on the person, shown or not. */
	waitingCount: number
	/** The top MAX_WAITING_ROWS, in For You order, then chat questions newest first. */
	waiting: DigestWaitingRow[]
	/** Only groups with at least one row, in the order Objects, Flows, Chats. */
	groups: DigestGroup[]
	/** Rows over all groups. */
	updatesCount: number
	/** Workspace the mail's own button opens: the first waiting item's, else the newest update's. */
	anchorWorkspaceId: string | null
}

export interface LoadDigestInput {
	actorId: string
	mutedWorkspaceIds: string[]
	now: Date
	/** How far back Updates look. */
	lookbackMs: number
}

const TYPE_LABELS: Record<string, string> = { loop: 'Flow' }

/** "bet" becomes "Bet", a loop is a "Flow". */
export function typeLabelOf(objectType: string | null | undefined): string {
	if (!objectType) return 'Card'
	return TYPE_LABELS[objectType] ?? `${objectType.charAt(0).toUpperCase()}${objectType.slice(1)}`
}

function typeKindOf(objectType: string | null | undefined): string {
	return objectType === 'loop' ? 'flow' : (objectType ?? 'task')
}

type Meta = Record<string, unknown>

function conversationIdOf(meta: Meta): string | null {
	const id = meta.conversation_id
	return typeof id === 'string' && UUID_RE.test(id) ? id : null
}

function newMessages(count: number): string {
	return `${count} new ${count === 1 ? 'message' : 'messages'}`
}

/** Who did what for an object row: "Strategist mentioned you", "Strategist: Bet succeeded". */
function objectLine(args: {
	sourceName: string
	title: string
	objectTitle: string | null
	meta: Meta
}): string {
	const { sourceName, title, objectTitle, meta } = args
	if (meta.source === 'comment_mention') return `${sourceName} mentioned you`
	// Bet notifications are titled "Bet succeeded: <bet title>"; the row already shows the title.
	const what =
		objectTitle && title.endsWith(objectTitle)
			? title.slice(0, title.length - objectTitle.length).replace(/[\s:–—-]+$/, '')
			: title
	return what ? `${sourceName}: ${clip(what, 60)}` : sourceName
}

export async function loadDigest(db: Database, input: LoadDigestInput): Promise<DigestData> {
	const { actorId, now } = input
	const since = new Date(now.getTime() - input.lookbackMs)
	const muted = new Set(input.mutedWorkspaceIds)

	const memberships = await db
		.select({ id: workspaces.id })
		.from(workspaceMembers)
		.innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
		.where(eq(workspaceMembers.actorId, actorId))
		.orderBy(asc(workspaces.createdAt), asc(workspaces.id))
		.limit(MAX_WORKSPACES)
	const workspaceIds = memberships.map((w) => w.id)
	if (workspaceIds.length === 0) {
		return { waitingCount: 0, waiting: [], groups: [], updatesCount: 0, anchorWorkspaceId: null }
	}

	// ── Needs you: cards, in the order the For You screen shows them ──
	const cardRows: DigestWaitingRow[] = []
	for (const workspaceId of workspaceIds) {
		const items = await buildForYouItems(db, workspaceId, actorId)
		for (const item of [...items].sort((a, b) => a.rank - b.rank)) {
			const decision = item.latest_mention?.decision
			cardRows.push({
				workspaceId,
				title: clip(item.headline, 90),
				line: clipOrNull(item.rationale ?? decision?.summary ?? decision?.ask ?? null, 120),
				typeLabel: typeLabelOf(item.object?.type),
				typeKind: typeKindOf(item.object?.type),
				at: new Date(item.created_at ?? now),
				dueAt: item.due_at ? new Date(item.due_at) : null,
				path: item.entity_id ? `/${workspaceId}/objects/${item.entity_id}` : `/${workspaceId}`,
				buttonLabel: 'Review',
			})
		}
	}

	// ── Needs you: chats where an agent asked and nobody has answered ──
	const questionRows = await db
		.select()
		.from(notifications)
		.where(
			and(
				eq(notifications.targetActorId, actorId),
				inArray(notifications.workspaceId, workspaceIds),
				eq(notifications.type, 'needs_input'),
				inArray(notifications.status, ['pending', 'seen']),
				sql`${notifications.metadata}->>'push_category' = 'needs_you'`,
				sql`${notifications.metadata}->>'conversation_id' IS NOT NULL`,
			),
		)
		.orderBy(desc(notifications.createdAt))
		.limit(MAX_QUESTION_ROWS_READ)
	const questionIds = new Set(questionRows.map((n) => n.id))

	// ── Updates: unread notifications inside the window ──
	const updateWorkspaceIds = workspaceIds.filter((id) => !muted.has(id))
	const candidates = updateWorkspaceIds.length
		? await db
				.select({
					n: notifications,
					objectTitle: objects.title,
					objectType: objects.type,
					sourceName: actors.name,
				})
				.from(notifications)
				.leftJoin(objects, eq(objects.id, notifications.objectId))
				.innerJoin(actors, eq(actors.id, notifications.sourceActorId))
				.where(
					and(
						eq(notifications.targetActorId, actorId),
						inArray(notifications.workspaceId, updateWorkspaceIds),
						gt(notifications.createdAt, since),
						ne(notifications.sourceActorId, actorId),
						sql`(${notifications.status} = 'pending' OR (${notifications.status} = 'seen' AND ${notifications.metadata}->>'push_only' = 'true'))`,
						sql`coalesce(${notifications.metadata}->>'kind', '') <> ${FOR_YOU_KIND}`,
					),
				)
				.orderBy(desc(notifications.createdAt))
				.limit(MAX_UPDATE_ROWS_READ)
		: []

	// Chats: every unread row of a conversation, waiting questions and plain replies together.
	type ChatAcc = { workspaceId: string; count: number; latest: Date; fallbackTitle: string }
	const chatWaiting = new Map<string, ChatAcc>()
	const chatUpdates = new Map<string, ChatAcc>()
	const bump = (map: Map<string, ChatAcc>, key: string, n: typeof notifications.$inferSelect) => {
		const at = n.createdAt ?? now
		const acc = map.get(key)
		if (!acc) {
			map.set(key, { workspaceId: n.workspaceId, count: 1, latest: at, fallbackTitle: n.title })
		} else {
			acc.count++
			if (at > acc.latest) {
				acc.latest = at
				acc.fallbackTitle = n.title
			}
		}
	}
	for (const n of questionRows) {
		const conversationId = conversationIdOf((n.metadata ?? {}) as Meta)
		if (conversationId) bump(chatWaiting, conversationId, n)
	}

	const objectRows: DigestUpdateRow[] = []
	type FlowAcc = { workspaceId: string; title: string; count: number; latest: Date }
	const flowRows = new Map<string, FlowAcc>()
	for (const { n, objectTitle, objectType, sourceName } of candidates) {
		if (questionIds.has(n.id)) continue
		const meta = (n.metadata ?? {}) as Meta
		const at = n.createdAt ?? now
		const conversationId = conversationIdOf(meta)
		if (conversationId) {
			if (await hasReadThrough(db, actorId, meta)) continue
			// A chat that is waiting is in Needs you; its unread replies only add to that count.
			bump(chatWaiting.has(conversationId) ? chatWaiting : chatUpdates, conversationId, n)
			continue
		}
		// A push-only row with no chat is a flow's activity banner; any other one is not an update.
		if (meta.push_only === true && meta.push_category !== FLOW_ACTIVITY_CATEGORY) continue
		if (!n.objectId) continue
		if (objectType === 'loop') {
			const acc = flowRows.get(n.objectId)
			if (acc) {
				acc.count++
				if (at > acc.latest) acc.latest = at
			} else {
				flowRows.set(n.objectId, {
					workspaceId: n.workspaceId,
					title: objectTitle ?? n.title,
					count: 1,
					latest: at,
				})
			}
			continue
		}
		objectRows.push({
			workspaceId: n.workspaceId,
			title: clip(objectTitle ?? n.title, 80),
			line: objectLine({ sourceName, title: n.title, objectTitle, meta }),
			at,
			path: `/${n.workspaceId}/objects/${n.objectId}`,
		})
	}

	// Chat titles for both lists in one read.
	const chatIds = [...chatWaiting.keys(), ...chatUpdates.keys()]
	const titleById = new Map<string, string>()
	if (chatIds.length > 0) {
		try {
			const rows = await db
				.select({ id: conversations.id, title: conversations.title })
				.from(conversations)
				.where(inArray(conversations.id, chatIds))
			for (const r of rows) titleById.set(r.id, r.title)
		} catch (err) {
			// The names are a nicety: fall back to the notification's own title.
			logger.warn('Digest chat titles failed', { actorId, error: String(err) })
		}
	}
	const chatTitle = (id: string, acc: ChatAcc) =>
		clip(titleById.get(id) || acc.fallbackTitle || 'Chat', 80)

	const chatQuestionRows: DigestWaitingRow[] = [...chatWaiting.entries()]
		.sort(([, a], [, b]) => b.latest.getTime() - a.latest.getTime())
		.map(([id, acc]) => ({
			workspaceId: acc.workspaceId,
			title: chatTitle(id, acc),
			line: newMessages(acc.count),
			typeLabel: 'Chat',
			typeKind: 'chat',
			at: acc.latest,
			dueAt: null,
			path: `/${acc.workspaceId}/chats/${id}`,
			buttonLabel: 'Reply' as const,
		}))

	const flows: DigestUpdateRow[] = [...flowRows.entries()].map(([id, acc]) => ({
		workspaceId: acc.workspaceId,
		title: clip(acc.title, 80),
		line: acc.count === 1 ? 'Finished a run' : `Finished ${acc.count} runs`,
		at: acc.latest,
		path: `/${acc.workspaceId}/loops/${id}`,
	}))
	const chats: DigestUpdateRow[] = [...chatUpdates.entries()].map(([id, acc]) => ({
		workspaceId: acc.workspaceId,
		title: chatTitle(id, acc),
		line: newMessages(acc.count),
		at: acc.latest,
		path: `/${acc.workspaceId}/chats/${id}`,
	}))

	const newestFirst = (a: DigestUpdateRow, b: DigestUpdateRow) => b.at.getTime() - a.at.getTime()
	const groups: DigestGroup[] = (
		[
			['objects', objectRows],
			['flows', flows],
			['chats', chats],
		] as const
	)
		.filter(([, rows]) => rows.length > 0)
		.map(([kind, rows]) => ({
			kind,
			count: rows.length,
			rows: [...rows].sort(newestFirst).slice(0, MAX_GROUP_ROWS),
		}))

	const allWaiting = [...cardRows, ...chatQuestionRows]
	const newestUpdate = groups.flatMap((g) => g.rows).sort(newestFirst)[0]
	return {
		waitingCount: allWaiting.length,
		waiting: allWaiting.slice(0, MAX_WAITING_ROWS),
		groups,
		updatesCount: groups.reduce((sum, g) => sum + g.count, 0),
		anchorWorkspaceId: allWaiting[0]?.workspaceId ?? newestUpdate?.workspaceId ?? null,
	}
}

function clipOrNull(text: string | null, max: number): string | null {
	if (!text) return null
	const clipped = clip(text, max)
	return clipped || null
}
