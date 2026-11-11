import { randomUUID } from 'node:crypto'
import type { Database } from '@maskin/db'
import { files, integrations, objects, relationships } from '@maskin/db/schema'
import type { StorageProvider } from '@maskin/storage'
import { Cron } from 'croner'
import { and, asc, eq, inArray, like, or, sql } from 'drizzle-orm'
import { recordEvent } from '../lib/events/record-event'
import { sha256Hex } from '../lib/file-save'
import { fileStorageKey } from '../lib/file-urls'
import { getCredential } from '../lib/integrations/lookup'
import { logger } from '../lib/logger'
import { derivePairEndpointKinds } from '../lib/relationships-endpoint-kind'
import { type TelnyxRecording, downloadRecording, listRecordings } from '../lib/telnyx-recordings'

/**
 * Saves every Telnyx call recording as a Maskin file. No model in the path.
 *
 * Every few minutes it lists the recordings Telnyx holds, skips the ones already
 * stored, downloads the rest and creates the file, linked to the person who was
 * phoned and to the outbound loop. The same pass is the backfill: it looks at
 * everything Telnyx still holds since `backfillFrom`, not only new calls.
 *
 * Idempotent by Telnyx recording id: the id is written into the file description
 * ("Telnyx recording <id>", the same words the hand-saved files carry), and a
 * recording whose id is found in a description is never fetched again. A recording
 * that fails to download is logged and left alone, so the next run retries it.
 *
 * The Telnyx key is read through the Keychain's own choke point (getCredential),
 * as `actorId`, so the grant check and the audit row apply. That actor must have
 * been granted the key. Off unless the workspace and actor are configured.
 */
const CRON_EXPRESSION = '*/5 * * * *'
/** Bounds one run; the rest waits for the next. */
const MAX_NEW_PER_TICK = 100
/** Overlap kept behind the point everything is known to be saved, for late-arriving recordings. */
const WATERMARK_OVERLAP_MS = 60 * 60 * 1000
const DEDUPE_CHUNK = 100

export interface TelnyxRecordingSyncConfig {
	workspaceId: string
	/** Agent that holds the Keychain grant for the Telnyx key; also the creator of the files. */
	actorId: string
	/** Loop the files are linked to. */
	loopId: string
	/** Display name of the Telnyx key in the Keychain. */
	keyName: string
	/** Earliest recording to save. Older ones are ignored. */
	backfillFrom: Date
}

export interface TelnyxRecordingSyncDeps {
	listRecordings: typeof listRecordings
	downloadRecording: typeof downloadRecording
	now: () => Date
}

const defaultDeps: TelnyxRecordingSyncDeps = {
	listRecordings,
	downloadRecording,
	now: () => new Date(),
}

type ContactMatch = { id: string; name: string | null; role: string | null; company: string | null }

export class TelnyxRecordingSyncJob {
	private job: Cron | null = null
	private running = false
	/** Recordings created before this are all saved. In memory: a restart rescans from backfillFrom. */
	private completeThrough: Date

	constructor(
		private db: Database,
		private storage: StorageProvider,
		private config: TelnyxRecordingSyncConfig,
		private deps: TelnyxRecordingSyncDeps = defaultDeps,
		private cronExpression: string = CRON_EXPRESSION,
	) {
		this.completeThrough = config.backfillFrom
	}

	start(): void {
		if (this.job) return
		this.job = new Cron(this.cronExpression, { timezone: 'UTC' }, async () => {
			await this.tick()
		})
	}

	stop(): void {
		if (this.job) {
			this.job.stop()
			this.job = null
		}
	}

	/** Returns the number of recordings saved. Never throws. */
	async tick(): Promise<number> {
		if (this.running) return 0
		this.running = true
		try {
			const tickStart = this.deps.now()
			const apiKey = await this.readKey()
			if (!apiKey) return 0
			const since = new Date(
				Math.max(this.config.backfillFrom.getTime(), this.completeThrough.getTime()),
			)
			const listed = await this.deps.listRecordings(apiKey, since)
			const known = await this.findStoredIds(
				listed.map((r) => r.id),
				since,
			)
			const todo = listed.filter((r) => !known.has(r.id))

			let saved = 0
			let failed = 0
			for (const rec of todo.slice(0, MAX_NEW_PER_TICK)) {
				if (await this.saveOne(rec)) saved++
				else failed++
			}
			const leftOver = Math.max(0, todo.length - MAX_NEW_PER_TICK)
			if (failed === 0 && leftOver === 0) {
				this.completeThrough = new Date(tickStart.getTime() - WATERMARK_OVERLAP_MS)
			}
			if (todo.length > 0) {
				logger.info('Telnyx recording sync tick', {
					listed: listed.length,
					alreadySaved: listed.length - todo.length,
					saved,
					failed,
					waiting: leftOver,
				})
			}
			return saved
		} catch (err) {
			logger.error('Telnyx recording sync tick failed', {
				error: String(err),
				code: (err as { code?: unknown }).code ?? null,
			})
			return 0
		} finally {
			this.running = false
		}
	}

	private async readKey(): Promise<string | null> {
		const { workspaceId, actorId, keyName } = this.config
		const [row] = await this.db
			.select({ id: integrations.id })
			.from(integrations)
			.where(
				and(
					eq(integrations.workspaceId, workspaceId),
					eq(integrations.providerMode, 'byo_apikey'),
					eq(integrations.displayName, keyName),
					eq(integrations.status, 'active'),
				),
			)
			.limit(1)
		if (!row) {
			logger.error('Telnyx recording sync: no active Keychain key with that name', { keyName })
			return null
		}
		const credential = await getCredential(this.db, workspaceId, row.id, {
			requestingActorId: actorId,
			outboundTarget: 'api.telnyx.com',
			requestId: `telnyx-recording-sync:${randomUUID()}`,
		})
		return credential.value
	}

	/** Which of these Telnyx ids already sit in a file description. */
	private async findStoredIds(ids: string[], since: Date): Promise<Set<string>> {
		const found = new Set<string>()
		for (let i = 0; i < ids.length; i += DEDUPE_CHUNK) {
			const chunk = ids.slice(i, i + DEDUPE_CHUNK)
			const rows = await this.db
				.select({ description: files.description })
				.from(files)
				.where(
					and(
						eq(files.workspaceId, this.config.workspaceId),
						sql`${files.createdAt} >= ${since.toISOString()}`,
						or(...chunk.map((id) => like(files.description, `%${id}%`))),
					),
				)
			for (const { description } of rows) {
				for (const id of chunk) if (description?.includes(id)) found.add(id)
			}
		}
		return found
	}

	/** The person this call was with, by the number dialled (or the caller's, for an inbound call). */
	private async matchContact(rec: TelnyxRecording): Promise<ContactMatch | null> {
		const numbers = [rec.to, rec.from].filter((n): n is string => !!n)
		if (numbers.length === 0) return null
		const rows = await this.db
			.select({ id: objects.id, metadata: objects.metadata })
			.from(objects)
			.where(
				and(
					eq(objects.workspaceId, this.config.workspaceId),
					eq(objects.type, 'contact'),
					inArray(sql<string>`${objects.metadata}->>'phone'`, numbers),
				),
			)
			.orderBy(asc(objects.createdAt))
		if (rows.length === 0) return null
		// Several people can share a number; the one in the loop is the one that was called.
		const inLoop = await this.db
			.select({ id: relationships.targetId })
			.from(relationships)
			.where(
				and(
					eq(relationships.sourceId, this.config.loopId),
					eq(relationships.type, 'in_loop'),
					inArray(
						relationships.targetId,
						rows.map((r) => r.id),
					),
				),
			)
		const inLoopIds = new Set(inLoop.map((r) => r.id))
		const pick = rows.find((r) => inLoopIds.has(r.id)) ?? rows[0]
		if (!pick) return null
		const meta = (pick.metadata ?? {}) as Record<string, unknown>
		const s = (k: string) => (typeof meta[k] === 'string' && meta[k] ? (meta[k] as string) : null)
		return {
			id: pick.id,
			name: s('contact_name'),
			role: s('contact_role'),
			company: s('company_name'),
		}
	}

	/** True when the recording is now stored. A failure is logged and leaves nothing behind. */
	private async saveOne(rec: TelnyxRecording): Promise<boolean> {
		const { workspaceId, actorId, loopId } = this.config
		try {
			if (!rec.mp3Url) throw new Error('recording has no mp3 download link')
			const bytes = await this.deps.downloadRecording(rec.mp3Url)
			const contact = await this.matchContact(rec)

			const fileId = randomUUID()
			const storageKey = fileStorageKey(workspaceId, fileId)
			await this.db.insert(files).values({
				id: fileId,
				workspaceId,
				name: recordingFileName(rec, contact),
				description: recordingDescription(rec, contact),
				tags: ['erase-on-request'],
				mimeType: 'audio/mpeg',
				sizeBytes: bytes.byteLength,
				storageKey,
				contentHash: sha256Hex(bytes),
				createdBy: actorId,
			})
			try {
				await this.storage.put(storageKey, bytes)
			} catch (err) {
				await this.db.delete(files).where(eq(files.id, fileId))
				throw err
			}

			for (const sourceId of contact ? [contact.id, loopId] : [loopId]) {
				const { sourceType, targetType } = await derivePairEndpointKinds(
					this.db,
					workspaceId,
					sourceId,
					fileId,
				)
				await this.db.insert(relationships).values({
					sourceType,
					sourceId,
					targetType,
					targetId: fileId,
					type: 'attached',
					createdBy: actorId,
				})
			}
			await recordEvent(this.db, {
				workspaceId,
				actorId,
				action: 'created',
				entityType: 'file',
				entityId: fileId,
				data: { id: fileId, mimeType: 'audio/mpeg', sizeBytes: bytes.byteLength },
			})
			return true
		} catch (err) {
			logger.error('Telnyx recording not saved; will retry on the next run', {
				recordingId: rec.id,
				error: String(err),
			})
			return false
		}
	}
}

const pad = (n: number) => String(n).padStart(2, '0')

/** "2026-11-10" and "0917" of the call start, in UTC. */
function utcStamp(startedAt: string): { date: string; time: string } {
	const d = new Date(startedAt)
	return {
		date: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`,
		time: `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`,
	}
}

function slugify(text: string): string {
	return text
		.toLowerCase()
		.replace(/æ/g, 'ae')
		.replace(/ø/g, 'o')
		.replace(/å/g, 'a')
		.normalize('NFD')
		.replace(/\p{M}/gu, '')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 50)
		.replace(/-+$/, '')
}

/**
 * Same shape as the hand-saved files (call-slug-date-timeutc.mp3), minus the batch
 * and call counters, which only the calling run knows.
 */
export function recordingFileName(rec: TelnyxRecording, contact: ContactMatch | null): string {
	const { date, time } = utcStamp(rec.startedAt)
	const who = slugify(contact?.company ?? contact?.name ?? rec.to ?? '') || rec.id.slice(0, 8)
	return `call-${who}-${date}-${time}utc.mp3`
}

export function recordingDescription(rec: TelnyxRecording, contact: ContactMatch | null): string {
	const { date, time } = utcStamp(rec.startedAt)
	const parts = [
		`Call ${date} (saved automatically from Telnyx)`,
		contact?.company ?? 'no matching person found',
		`${date} ${time.slice(0, 2)}:${time.slice(2)} UTC`,
	]
	if (rec.durationMillis !== null) parts.push(`${Math.round(rec.durationMillis / 1000)} s`)
	const who = [contact?.name, contact?.role, contact?.company].filter(Boolean).join(', ')
	parts.push(`number ${rec.to ?? 'unknown'}${who ? ` (${who})` : ''}`)
	const session = rec.callSessionId ? `, call session ${rec.callSessionId}` : ''
	return `${parts.join(', ')}. Telnyx recording ${rec.id}${session}. Erase on request.`
}
