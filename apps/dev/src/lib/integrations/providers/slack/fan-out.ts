import { randomUUID } from 'node:crypto'
import type { Database } from '@maskin/db'
import { events as eventsTable, files, integrations } from '@maskin/db/schema'
import type { StorageProvider } from '@maskin/storage'
import { eq } from 'drizzle-orm'
import { logger } from '../../../logger'
import type { IntegrationConfig } from '../../../types'
import { TokenManager } from '../../oauth/token-manager'
import { getProvider } from '../../registry'
import type { NormalizedEvent, WebhookFanOutContext } from '../../types'

/**
 * Slack file object shape from Events API message payloads. Slack returns many
 * more fields; we only read what we need to persist the bytes.
 */
interface SlackFile {
	id: string
	name?: string
	title?: string
	mimetype?: string
	filetype?: string
	url_private?: string
	url_private_download?: string
	size?: number
}

/** Cap to keep a single ingest event from blowing up storage if something goes wrong */
const MAX_FILES_PER_EVENT = 20
/** Hard cap on bytes per file (matches /api/files create limit) */
const MAX_FILE_BYTES = 10 * 1024 * 1024
/** Slack file download timeout */
const DOWNLOAD_TIMEOUT_MS = 30_000

function fileStorageKey(workspaceId: string, fileId: string): string {
	return `workspaces/${workspaceId}/files/${fileId}`
}

function extractSlackFiles(data: Record<string, unknown>): SlackFile[] | null {
	const event = data.event as Record<string, unknown> | undefined
	if (!event) return null
	const raw = event.files
	if (!Array.isArray(raw)) return null
	const result: SlackFile[] = []
	for (const f of raw) {
		if (!f || typeof f !== 'object') continue
		const file = f as SlackFile
		if (typeof file.id !== 'string') continue
		result.push(file)
	}
	return result.length > 0 ? result : null
}

async function downloadSlackFile(url: string, accessToken: string): Promise<Buffer> {
	const res = await fetch(url, {
		headers: { Authorization: `Bearer ${accessToken}` },
		signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
		redirect: 'follow',
	})
	if (!res.ok) {
		throw new Error(`Slack file download failed: HTTP ${res.status}`)
	}
	const ab = await res.arrayBuffer()
	if (ab.byteLength > MAX_FILE_BYTES) {
		throw new Error(`Slack file exceeds ${MAX_FILE_BYTES} byte limit (${ab.byteLength})`)
	}
	return Buffer.from(ab)
}

interface PersistedFile {
	slackFileId: string
	maskinFileId: string
	name: string
	mimeType: string
}

async function persistOne(
	db: Database,
	storage: StorageProvider,
	workspaceId: string,
	actorId: string,
	accessToken: string,
	slackFile: SlackFile,
): Promise<PersistedFile> {
	const downloadUrl = slackFile.url_private_download ?? slackFile.url_private
	if (!downloadUrl) throw new Error(`Slack file ${slackFile.id} has no url_private`)

	const bytes = await downloadSlackFile(downloadUrl, accessToken)
	const fileId = randomUUID()
	const storageKey = fileStorageKey(workspaceId, fileId)
	const name = slackFile.name ?? slackFile.title ?? `slack-${slackFile.id}`
	const mimeType = slackFile.mimetype ?? 'application/octet-stream'

	const [row] = await db
		.insert(files)
		.values({
			id: fileId,
			workspaceId,
			name,
			description: null,
			mimeType,
			sizeBytes: bytes.byteLength,
			storageKey,
			createdBy: actorId,
		})
		.returning()
	if (!row) throw new Error('Failed to insert files row')

	try {
		await storage.put(storageKey, bytes)
	} catch (err) {
		await db.delete(files).where(eq(files.id, row.id))
		throw err
	}

	await db
		.insert(eventsTable)
		.values({
			workspaceId,
			actorId,
			action: 'created',
			entityType: 'file',
			entityId: row.id,
			data: {
				id: row.id,
				name: row.name,
				mimeType: row.mimeType,
				sizeBytes: row.sizeBytes,
				source: 'slack-ingest',
				slack_file_id: slackFile.id,
			},
		})
		.catch((err) =>
			logger.error('Failed to record slack-ingested file audit event', {
				workspaceId,
				fileId: row.id,
				error: String(err),
			}),
		)

	return {
		slackFileId: slackFile.id,
		maskinFileId: row.id,
		name,
		mimeType,
	}
}

/**
 * For Slack message events that include file attachments, download the files
 * from Slack with the bot token and persist them as Maskin file rows + S3 objects
 * before the event hits the trigger pipeline. The returned event carries a
 * top-level `maskin_file_ids` array that the ingest agent passes through to
 * `create_objects` so the resulting insight gets the actual bytes attached
 * instead of a stale "Message included an attached image" text reference.
 *
 * When the event has no files, the original normalized event is returned
 * unchanged — no behavior change for the vast majority of Slack events.
 */
export async function slackWebhookFanOut(ctx: WebhookFanOutContext): Promise<NormalizedEvent[]> {
	const slackFiles = extractSlackFiles(ctx.normalized.data)
	if (!slackFiles) return [ctx.normalized]

	const db = ctx.db as Database
	const storage = ctx.storage as StorageProvider | undefined
	if (!storage) {
		logger.error('Slack fan-out missing storage provider; passing event through without files', {
			integrationId: ctx.integrationId,
		})
		return [ctx.normalized]
	}

	const [integration] = await db
		.select()
		.from(integrations)
		.where(eq(integrations.id, ctx.integrationId))
		.limit(1)
	if (!integration) return [ctx.normalized]

	const config = (integration.config as IntegrationConfig) ?? {}
	const actorId = config.system_actor_id
	if (!actorId) {
		logger.warn('Slack fan-out: integration missing system_actor_id; cannot persist files', {
			integrationId: ctx.integrationId,
		})
		return [ctx.normalized]
	}

	const provider = getProvider('slack')
	const tokenManager = new TokenManager()
	const accessToken = await tokenManager.getValidToken(db, ctx.integrationId, provider)

	const toPersist = slackFiles.slice(0, MAX_FILES_PER_EVENT)
	if (slackFiles.length > MAX_FILES_PER_EVENT) {
		logger.warn('Slack fan-out: more files than per-event cap; persisting first N', {
			integrationId: ctx.integrationId,
			fileCount: slackFiles.length,
			cap: MAX_FILES_PER_EVENT,
		})
	}

	const persisted: PersistedFile[] = []
	for (const slackFile of toPersist) {
		try {
			persisted.push(
				await persistOne(db, storage, integration.workspaceId, actorId, accessToken, slackFile),
			)
		} catch (err) {
			logger.error('Slack fan-out: failed to persist file', {
				integrationId: ctx.integrationId,
				slackFileId: slackFile.id,
				error: err instanceof Error ? err.message : String(err),
			})
		}
	}

	if (persisted.length === 0) return [ctx.normalized]

	logger.info('Slack fan-out: persisted attachments', {
		integrationId: ctx.integrationId,
		count: persisted.length,
		fileIds: persisted.map((p) => p.maskinFileId),
	})

	const maskinFileIds = persisted.map((p) => p.maskinFileId)
	const enriched: NormalizedEvent = {
		...ctx.normalized,
		data: {
			...ctx.normalized.data,
			maskin_file_ids: maskinFileIds,
			maskin_files: persisted.map((p) => ({
				id: p.maskinFileId,
				slack_file_id: p.slackFileId,
				name: p.name,
				mime_type: p.mimeType,
			})),
		},
	}
	return [enriched]
}
