import { randomUUID } from 'node:crypto'
import type { Database } from '@maskin/db'
import { events as eventsTable, files, integrations } from '@maskin/db/schema'
import { MAX_FILE_SIZE_BYTES } from '@maskin/shared'
import type { StorageProvider } from '@maskin/storage'
import { and, eq, sql } from 'drizzle-orm'
import { fileStorageKey } from '../../../file-urls'
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
/** Slack file download timeout */
const DOWNLOAD_TIMEOUT_MS = 30_000

// Defense-in-depth: refuse to send the bot token to anything but a Slack-owned host.
// Node fetch already strips Authorization on cross-origin redirects, so token exfil via
// a malicious url_private is bounded today — this guard removes a class of regressions
// if that behaviour ever changes.
function isAllowedSlackHost(url: string): boolean {
	let parsed: URL
	try {
		parsed = new URL(url)
	} catch {
		return false
	}
	if (parsed.protocol !== 'https:') return false
	const host = parsed.hostname.toLowerCase()
	return host === 'slack.com' || host.endsWith('.slack.com')
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
	if (!isAllowedSlackHost(url)) {
		throw new Error(`Slack file download rejected: host not in allow-list (${url})`)
	}
	const res = await fetch(url, {
		headers: { Authorization: `Bearer ${accessToken}` },
		signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
		redirect: 'follow',
	})
	if (!res.ok) {
		throw new Error(`Slack file download failed: HTTP ${res.status}`)
	}

	// Bail before buffering when the server advertises a too-large response.
	// `res.arrayBuffer()` would otherwise pull the whole body into memory before
	// any size check, OOM-ing the process on a multi-GB response.
	const declared = Number(res.headers.get('content-length'))
	if (Number.isFinite(declared) && declared > MAX_FILE_SIZE_BYTES) {
		throw new Error(`Slack file exceeds ${MAX_FILE_SIZE_BYTES} byte limit (${declared})`)
	}

	// Belt-and-suspenders: stream the body and bail as soon as the accumulated
	// bytes exceed the cap, in case Content-Length is missing or lies.
	const body = res.body
	if (!body) {
		throw new Error('Slack file download returned no body')
	}
	const reader = body.getReader()
	const chunks: Uint8Array[] = []
	let received = 0
	try {
		while (true) {
			const { value, done } = await reader.read()
			if (done) break
			if (!value) continue
			received += value.byteLength
			if (received > MAX_FILE_SIZE_BYTES) {
				throw new Error(`Slack file exceeds ${MAX_FILE_SIZE_BYTES} byte limit (${received})`)
			}
			chunks.push(value)
		}
	} catch (err) {
		await reader.cancel().catch(() => {})
		throw err
	}
	return Buffer.concat(chunks, received)
}

interface PersistedFile {
	slackFileId: string
	maskinFileId: string
	name: string
	mimeType: string
}

/**
 * Look up a previously persisted Slack file by its Slack file ID. We key off
 * the audit event we write below — every persisted Slack file gets an event
 * row with `data.slack_file_id` — which keeps the dedup contract in one place
 * without a schema migration. Returns the existing Maskin file when found so
 * we can skip both the download and the S3 write on retries / re-shares of
 * the same file across messages.
 */
async function findPersistedBySlackFileId(
	db: Database,
	workspaceId: string,
	slackFileId: string,
): Promise<PersistedFile | null> {
	const rows = await db
		.select({ id: files.id, name: files.name, mimeType: files.mimeType })
		.from(files)
		.innerJoin(eventsTable, eq(eventsTable.entityId, files.id))
		.where(
			and(
				eq(files.workspaceId, workspaceId),
				// Repeat the workspace constraint on the events side so the planner
				// can drive the join with `events_ws_entity_id_idx (workspace_id,
				// entity_id, id)` instead of falling back to a workspace-wide scan
				// to evaluate the JSONB predicate.
				eq(eventsTable.workspaceId, workspaceId),
				eq(eventsTable.entityType, 'file'),
				eq(eventsTable.action, 'created'),
				sql`${eventsTable.data}->>'slack_file_id' = ${slackFileId}`,
			),
		)
		.limit(1)
	const row = rows[0]
	if (!row) return null
	return {
		slackFileId,
		maskinFileId: row.id,
		name: row.name,
		mimeType: row.mimeType,
	}
}

async function persistOne(
	db: Database,
	storage: StorageProvider,
	workspaceId: string,
	actorId: string,
	accessToken: string,
	slackFile: SlackFile,
): Promise<PersistedFile> {
	const existing = await findPersistedBySlackFileId(db, workspaceId, slackFile.id)
	if (existing) {
		logger.info('Slack fan-out: reusing existing file for Slack file id', {
			workspaceId,
			slackFileId: slackFile.id,
			maskinFileId: existing.maskinFileId,
		})
		return existing
	}

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

	// Any unexpected throw below (DB lookup, token refresh) must not drop the
	// message itself — the caller swallows fan-out errors and skips the whole
	// event, which would regress the text-only ingest path that worked before
	// this fan-out existed. Fall back to the original event on failure.
	try {
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

		// Download + persist in parallel — sequential would make a 20-file message hold
		// the webhook open for up to MAX_FILES_PER_EVENT × DOWNLOAD_TIMEOUT_MS, well past
		// Slack's 3s ack window. Each persistOne is independent (its own UUID + S3 key).
		const results = await Promise.allSettled(
			toPersist.map((slackFile) =>
				persistOne(db, storage, integration.workspaceId, actorId, accessToken, slackFile),
			),
		)
		const persisted: PersistedFile[] = []
		for (let i = 0; i < results.length; i++) {
			const r = results[i]
			if (!r) continue
			if (r.status === 'fulfilled') {
				persisted.push(r.value)
			} else {
				logger.error('Slack fan-out: failed to persist file', {
					integrationId: ctx.integrationId,
					slackFileId: toPersist[i]?.id,
					error: r.reason instanceof Error ? r.reason.message : String(r.reason),
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
	} catch (err) {
		logger.error('Slack fan-out: unexpected failure; ingesting event without files', {
			integrationId: ctx.integrationId,
			error: err instanceof Error ? err.message : String(err),
		})
		return [ctx.normalized]
	}
}
