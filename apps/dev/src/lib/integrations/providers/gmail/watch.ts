import type { Database } from '@maskin/db'
import { integrations } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
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

async function fetchHistory(
	accessToken: string,
	startHistoryId: string,
): Promise<HistoryListResponse> {
	const url = new URL(`${GMAIL_API_BASE}/history`)
	url.searchParams.set('startHistoryId', startHistoryId)
	url.searchParams.set('historyTypes', 'messageAdded')
	url.searchParams.append('historyTypes', 'messageDeleted')
	url.searchParams.append('historyTypes', 'labelAdded')
	url.searchParams.append('historyTypes', 'labelRemoved')

	const res = await fetch(url.toString(), {
		headers: { Authorization: `Bearer ${accessToken}` },
	})
	if (res.status === 404) {
		// Gmail returns 404 when startHistoryId is too old (>~7 days). Caller resets.
		return {}
	}
	if (!res.ok) {
		const text = await res.text()
		throw new Error(`Gmail history.list failed: HTTP ${res.status} ${text}`)
	}
	return (await res.json()) as HistoryListResponse
}

/**
 * Expand one Pub/Sub push (a `gmail.history.updated` placeholder event) into
 * concrete per-message events. Persists the new historyId on success so the next
 * push picks up where this one left off.
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
		await persistHistoryCursor(db, ctx.integrationId, config, incomingHistoryId)
		return []
	}

	const result = await fetchHistory(accessToken, startHistoryId)
	const events: NormalizedEvent[] = []
	const emailAddress = String(ctx.normalized.data.emailAddress ?? '')

	for (const record of result.history ?? []) {
		for (const m of record.messagesAdded ?? []) {
			events.push(
				makeMessageEvent('received', emailAddress, m.message, { historyEntryId: record.id }),
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

	const newCursor = result.historyId ?? incomingHistoryId
	await persistHistoryCursor(db, ctx.integrationId, config, newCursor)

	return events
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

async function persistHistoryCursor(
	db: Database,
	integrationId: string,
	existing: GmailIntegrationConfig,
	historyId: string,
): Promise<void> {
	const merged: GmailIntegrationConfig = {
		...existing,
		gmail: existing.gmail
			? { ...existing.gmail, historyId }
			: { historyId, watchExpiresAt: 0, topicName: process.env.GMAIL_PUBSUB_TOPIC ?? '' },
	}
	await db
		.update(integrations)
		.set({ config: merged, updatedAt: new Date() })
		.where(eq(integrations.id, integrationId))
}
