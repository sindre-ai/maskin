import type { Database } from '@maskin/db'
import { integrations } from '@maskin/db/schema'
import { and, eq, sql } from 'drizzle-orm'
import { logger } from '../../../logger'
import type { IntegrationConfig } from '../../../types'
import { TokenManager } from '../../oauth/token-manager'
import { getProvider } from '../../registry'
import type {
	NormalizedEvent,
	PostInstallContext,
	StoredCredentials,
	WebhookFanOutContext,
} from '../../types'

/**
 * Stored under integrations.config alongside system_actor_id.
 * `historyId` is always a string in Gmail's API — never coerce to Number.
 */
export interface GmailIntegrationConfig extends IntegrationConfig {
	gmail?: {
		historyId: string
		watchExpiresAt: number
		topicName: string
	}
}

interface WatchResponse {
	historyId: string
	expiration: string
}

interface HistoryListResponse {
	history?: HistoryRecord[]
	historyId?: string
	nextPageToken?: string
}

interface HistoryRecord {
	id: string
	messages?: Array<{ id: string; threadId: string }>
	messagesAdded?: Array<{ message: HistoryMessage }>
	messagesDeleted?: Array<{ message: HistoryMessage }>
	labelsAdded?: Array<{ message: HistoryMessage; labelIds: string[] }>
	labelsRemoved?: Array<{ message: HistoryMessage; labelIds: string[] }>
}

interface HistoryMessage {
	id: string
	threadId: string
	labelIds?: string[]
}

const GMAIL_API_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me'

function getTopicName(): string {
	const topic = process.env.GMAIL_PUBSUB_TOPIC
	if (!topic) {
		throw new Error(
			'GMAIL_PUBSUB_TOPIC env var is required (e.g. projects/<project>/topics/gmail-push)',
		)
	}
	return topic
}

async function callWatch(accessToken: string, topicName: string): Promise<WatchResponse> {
	const res = await fetch(`${GMAIL_API_BASE}/watch`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${accessToken}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			topicName,
			labelIds: ['INBOX'],
			labelFilterBehavior: 'INCLUDE',
		}),
	})
	if (!res.ok) {
		const text = await res.text()
		throw new Error(`Gmail users.watch failed: HTTP ${res.status} ${text}`)
	}
	return (await res.json()) as WatchResponse
}

/**
 * Initial setup AND renewal share this path: fetch a valid token, call users.watch,
 * persist historyId + watchExpiresAt to integrations.config (preserving existing keys
 * such as system_actor_id).
 */
export async function setupGmailWatch(ctx: PostInstallContext): Promise<void> {
	const db = ctx.db as Database
	const topicName = getTopicName()
	const accessToken = ctx.credentials.accessToken
	if (!accessToken) {
		throw new Error('Gmail postInstall: no access token in credentials')
	}

	const watch = await callWatch(accessToken, topicName)

	const [row] = await db
		.select({ config: integrations.config })
		.from(integrations)
		.where(eq(integrations.id, ctx.integrationId))
		.limit(1)

	const existing = (row?.config as GmailIntegrationConfig | undefined) ?? {}
	const merged: GmailIntegrationConfig = {
		...existing,
		gmail: {
			historyId: watch.historyId,
			watchExpiresAt: Number(watch.expiration),
			topicName,
		},
	}

	await db
		.update(integrations)
		.set({ config: merged, updatedAt: new Date() })
		.where(eq(integrations.id, ctx.integrationId))

	logger.info('Gmail watch registered', {
		integrationId: ctx.integrationId,
		historyId: watch.historyId,
		expiresAt: watch.expiration,
	})
}

/**
 * Re-register an existing watch using a freshly-resolved access token.
 * Used by gmail-watch-renewer.ts on its 12h cadence.
 */
export async function renewGmailWatch(db: Database, integrationId: string): Promise<void> {
	const [integration] = await db
		.select()
		.from(integrations)
		.where(eq(integrations.id, integrationId))
		.limit(1)
	if (!integration) throw new Error(`Integration ${integrationId} not found`)

	const provider = getProvider(integration.provider)
	const tokenManager = new TokenManager()
	const accessToken = await tokenManager.getValidToken(db, integrationId, provider)

	await setupGmailWatch({
		db,
		integrationId,
		workspaceId: integration.workspaceId,
		credentials: { accessToken } as StoredCredentials,
	})
}

async function fetchHistoryPage(
	accessToken: string,
	startHistoryId: string,
	pageToken?: string,
): Promise<HistoryListResponse | null> {
	const url = new URL(`${GMAIL_API_BASE}/history`)
	url.searchParams.set('startHistoryId', startHistoryId)
	url.searchParams.set('historyTypes', 'messageAdded')
	url.searchParams.append('historyTypes', 'messageDeleted')
	url.searchParams.append('historyTypes', 'labelAdded')
	url.searchParams.append('historyTypes', 'labelRemoved')
	if (pageToken) url.searchParams.set('pageToken', pageToken)

	const res = await fetch(url.toString(), {
		headers: { Authorization: `Bearer ${accessToken}` },
	})
	if (res.status === 404) {
		// Gmail returns 404 when startHistoryId is too old (>~7 days). Caller resets.
		return null
	}
	if (!res.ok) {
		const text = await res.text()
		throw new Error(`Gmail history.list failed: HTTP ${res.status} ${text}`)
	}
	return (await res.json()) as HistoryListResponse
}

async function fetchAllHistory(
	accessToken: string,
	startHistoryId: string,
): Promise<{ records: HistoryRecord[]; latestHistoryId?: string } | null> {
	const records: HistoryRecord[] = []
	let pageToken: string | undefined
	let latestHistoryId: string | undefined
	// Bound the loop to protect against pathological pagination / API regressions.
	for (let i = 0; i < 50; i++) {
		const page = await fetchHistoryPage(accessToken, startHistoryId, pageToken)
		if (page === null) return null // 404 — caller resets cursor
		if (page.history) records.push(...page.history)
		if (page.historyId) latestHistoryId = page.historyId
		if (!page.nextPageToken) return { records, latestHistoryId }
		pageToken = page.nextPageToken
	}
	logger.warn('Gmail history.list pagination exceeded safety bound', { startHistoryId })
	return { records, latestHistoryId }
}

/**
 * Expand one Pub/Sub push (a `gmail.history.updated` placeholder event) into
 * concrete per-message events. Persists the new historyId on success so the next
 * push picks up where this one left off.
 *
 * Concurrency: two pushes for the same mailbox can arrive in parallel and both
 * read the same starting cursor. We guard against double-emit with a
 * compare-and-swap on `config->'gmail'->>'historyId'` — only the first writer
 * wins, the loser drops its events.
 */
export async function fanOutGmailHistory(ctx: WebhookFanOutContext): Promise<NormalizedEvent[]> {
	const db = ctx.db as Database
	const provider = getProvider('gmail')
	const tokenManager = new TokenManager()
	const accessToken = await tokenManager.getValidToken(db, ctx.integrationId, provider)

	const [integration] = await db
		.select()
		.from(integrations)
		.where(eq(integrations.id, ctx.integrationId))
		.limit(1)
	if (!integration) return []

	const config = (integration.config as GmailIntegrationConfig) ?? {}
	const startHistoryId = config.gmail?.historyId
	const incomingHistoryId = String(ctx.normalized.data.historyId ?? '')
	if (!startHistoryId) {
		// First push after install: nothing to fan out yet, just record the cursor.
		// Best-effort CAS from "no cursor" → incomingHistoryId; loser is a concurrent
		// push that already advanced the cursor.
		await casHistoryCursor(db, ctx.integrationId, config, undefined, incomingHistoryId)
		return []
	}

	const result = await fetchAllHistory(accessToken, startHistoryId)
	const events: NormalizedEvent[] = []
	const emailAddress = String(ctx.normalized.data.emailAddress ?? '')

	if (result === null) {
		// 404 — startHistoryId too old. Reset cursor to incoming push so the next
		// push picks up from current state rather than re-failing forever. Use CAS
		// so we don't clobber a concurrent fan-out that already advanced past us.
		await casHistoryCursor(db, ctx.integrationId, config, startHistoryId, incomingHistoryId)
		return []
	}

	for (const record of result.records) {
		for (const m of record.messagesAdded ?? []) {
			events.push(
				makeMessageEvent(messageAddedAction(m.message), emailAddress, m.message, {
					historyEntryId: record.id,
				}),
			)
		}
		for (const m of record.messagesDeleted ?? []) {
			events.push(
				makeMessageEvent('trashed', emailAddress, m.message, { historyEntryId: record.id }),
			)
		}
		for (const m of record.labelsAdded ?? []) {
			events.push(
				makeMessageEvent('labeled', emailAddress, m.message, {
					historyEntryId: record.id,
					labelIds: m.labelIds,
				}),
			)
		}
		for (const m of record.labelsRemoved ?? []) {
			events.push(
				makeMessageEvent('unlabeled', emailAddress, m.message, {
					historyEntryId: record.id,
					labelIds: m.labelIds,
				}),
			)
		}
	}

	const newCursor = result.latestHistoryId ?? incomingHistoryId
	const advanced = await casHistoryCursor(db, ctx.integrationId, config, startHistoryId, newCursor)
	if (!advanced) {
		// Another concurrent fan-out already advanced the cursor past startHistoryId.
		// Drop our events — the winner emitted (or will emit) the same delta.
		logger.info('Gmail fan-out lost cursor race; dropping events', {
			integrationId: ctx.integrationId,
			startHistoryId,
		})
		return []
	}

	return events
}

/** Gmail's messagesAdded covers both inbound and outbound mail; SENT label disambiguates. */
function messageAddedAction(message: HistoryMessage): string {
	return message.labelIds?.includes('SENT') ? 'sent' : 'received'
}

function makeMessageEvent(
	action: string,
	emailAddress: string,
	message: HistoryMessage,
	extra: Record<string, unknown>,
): NormalizedEvent {
	return {
		entityType: 'gmail.message',
		action,
		installationId: emailAddress,
		data: {
			messageId: message.id,
			threadId: message.threadId,
			labelIds: message.labelIds,
			emailAddress,
			...extra,
		},
	}
}

/**
 * Atomic compare-and-swap on the stored historyId. Returns true if this writer
 * advanced the cursor; false if the row's cursor no longer matches `expected`
 * (concurrent fan-out won the race) or the row vanished.
 *
 * `expected === undefined` matches the "no cursor yet" state: we only want to
 * succeed when nobody has populated `gmail.historyId` yet.
 */
async function casHistoryCursor(
	db: Database,
	integrationId: string,
	existing: GmailIntegrationConfig,
	expected: string | undefined,
	historyId: string,
): Promise<boolean> {
	const merged: GmailIntegrationConfig = {
		...existing,
		gmail: existing.gmail
			? { ...existing.gmail, historyId }
			: { historyId, watchExpiresAt: 0, topicName: process.env.GMAIL_PUBSUB_TOPIC ?? '' },
	}
	const cursorMatches =
		expected === undefined
			? sql`(${integrations.config}->'gmail'->>'historyId') IS NULL`
			: sql`(${integrations.config}->'gmail'->>'historyId') = ${expected}`

	const updated = await db
		.update(integrations)
		.set({ config: merged, updatedAt: new Date() })
		.where(and(eq(integrations.id, integrationId), cursorMatches))
		.returning({ id: integrations.id })

	return updated.length > 0
}
