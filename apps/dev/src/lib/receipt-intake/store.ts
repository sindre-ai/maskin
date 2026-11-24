import { randomUUID } from 'node:crypto'
import type { Database } from '@maskin/db'
import { actors, files, receiptIntakes, relationships, webhookDeliveries } from '@maskin/db/schema'
import type { StorageProvider } from '@maskin/storage'
import { and, eq, sql } from 'drizzle-orm'
import { recordEvent } from '../events/record-event'
import { sha256Hex } from '../file-save'
import { fileStorageKey } from '../file-urls'
import { sanitizeAttachmentName } from '../integrations/providers/gmail/attachment'
import { logger } from '../logger'
import type { IntakeRow, PipelineDeps, ReceiptFile, ReceivedEmail, Source } from './pipeline'
import { RECEIPT_DAILY_CAP, RECEIPT_MAX_BYTES, monthKey, utcDay } from './policy'

// The real database, storage and Resend behind PipelineDeps. Thin on purpose: every rule lives in
// pipeline.ts and policy.ts, where it is tested without any of this.

const DELIVERY_PROVIDER = 'receipt-intake-email'
const RESEND_API = 'https://api.resend.com'
const RESEND_TIMEOUT_MS = 8000

/** The event an agent trigger listens for. Ids only, never mail text or a file name. */
export const RECEIPT_EVENT_ENTITY_TYPE = 'receipt'
export const RECEIPT_EVENT_ACTION = 'received'

const INTAKE_COLUMNS = {
	id: receiptIntakes.id,
	workspaceId: receiptIntakes.workspaceId,
	loopObjectId: receiptIntakes.loopObjectId,
	createdBy: receiptIntakes.createdBy,
	emailEnabled: receiptIntakes.emailEnabled,
	allowedSenders: receiptIntakes.allowedSenders,
	ownerEmail: actors.email,
}

export async function findIntakeBy(
	db: Database,
	where: ReturnType<typeof eq>,
): Promise<IntakeRow | null> {
	const [row] = await db
		.select(INTAKE_COLUMNS)
		.from(receiptIntakes)
		.innerJoin(actors, eq(actors.id, receiptIntakes.createdBy))
		.where(where)
		.limit(1)
	return row ?? null
}

/** A name that is safe to store and ends in the extension of what the bytes really are. */
export function receiptFileName(raw: string, ext: string): string {
	const name = sanitizeAttachmentName(raw)
	const lower = name.toLowerCase()
	const has =
		ext === 'jpg' ? lower.endsWith('.jpg') || lower.endsWith('.jpeg') : lower.endsWith(`.${ext}`)
	return has ? name : `${name}.${ext}`
}

export type ResendIntakeConfig = { apiKey: string }

export function createPipelineDeps(
	db: Database,
	storage: StorageProvider,
	resend: ResendIntakeConfig | null,
): PipelineDeps {
	const resendGet = async (path: string): Promise<Response> => {
		if (!resend) throw new Error('receipt intake: Resend key is not configured')
		return fetch(`${RESEND_API}${path}`, {
			headers: { Authorization: `Bearer ${resend.apiKey}` },
			signal: AbortSignal.timeout(RESEND_TIMEOUT_MS),
		})
	}

	return {
		now: () => new Date(),

		findIntakeByEmailToken: (token) => findIntakeBy(db, eq(receiptIntakes.emailToken, token)),

		async claimDelivery(intake, emailId) {
			const rows = await db
				.insert(webhookDeliveries)
				.values({
					provider: DELIVERY_PROVIDER,
					externalId: emailId,
					workspaceId: intake.workspaceId,
					processedAt: new Date(),
				})
				.onConflictDoNothing({
					target: [
						webhookDeliveries.provider,
						webhookDeliveries.externalId,
						webhookDeliveries.workspaceId,
					],
				})
				.returning({ id: webhookDeliveries.id })
			return rows.length > 0
		},

		async releaseDelivery(intake, emailId) {
			await db
				.delete(webhookDeliveries)
				.where(
					and(
						eq(webhookDeliveries.provider, DELIVERY_PROVIDER),
						eq(webhookDeliveries.externalId, emailId),
						eq(webhookDeliveries.workspaceId, intake.workspaceId),
					),
				)
		},

		async fetchReceivedEmail(emailId): Promise<ReceivedEmail> {
			const res = await resendGet(`/emails/receiving/${encodeURIComponent(emailId)}`)
			if (!res.ok) throw new Error(`receipt intake: Resend returned ${res.status} for the email`)
			const body = (await res.json()) as {
				from?: string
				to?: string[]
				authentication?: { spf?: string; dkim?: string; dmarc?: string }
				attachments?: { id?: string; filename?: string; size?: number }[]
			}
			return {
				from: body.from,
				to: body.to,
				authentication: body.authentication ?? null,
				attachments: (body.attachments ?? [])
					.filter((a): a is { id: string; filename?: string; size?: number } => !!a.id)
					.map((a) => ({ id: a.id, filename: a.filename, size: a.size })),
			}
		},

		async downloadAttachment(emailId, attachmentId) {
			const meta = await resendGet(
				`/emails/receiving/${encodeURIComponent(emailId)}/attachments/${encodeURIComponent(attachmentId)}`,
			)
			if (!meta.ok)
				throw new Error(`receipt intake: Resend returned ${meta.status} for an attachment`)
			const { download_url: url } = (await meta.json()) as { download_url?: string }
			if (!url || !isTrustedDownloadUrl(url)) {
				throw new Error('receipt intake: attachment download link is not a Resend link')
			}
			const res = await fetch(url, { signal: AbortSignal.timeout(RESEND_TIMEOUT_MS * 2) })
			if (!res.ok) throw new Error(`receipt intake: attachment download returned ${res.status}`)
			const declared = Number(res.headers.get('content-length') ?? 0)
			// Too big to take: hand back nothing, which the pipeline counts as a held file.
			if (declared > RECEIPT_MAX_BYTES) return Buffer.alloc(0)
			return Buffer.from(await res.arrayBuffer())
		},

		async takeDailySlots(intake, n, today) {
			const day = utcDay(today)
			const rows = await db
				.update(receiptIntakes)
				.set({
					dayUtc: day,
					dayCount: sql`CASE WHEN ${receiptIntakes.dayUtc} = ${day} THEN ${receiptIntakes.dayCount} + ${n} ELSE ${n} END`,
				})
				.where(
					and(
						eq(receiptIntakes.id, intake.id),
						sql`(CASE WHEN ${receiptIntakes.dayUtc} = ${day} THEN ${receiptIntakes.dayCount} ELSE 0 END) + ${n} <= ${RECEIPT_DAILY_CAP}`,
					),
				)
				.returning({ id: receiptIntakes.id })
			return rows.length > 0
		},

		async countHeld(intake, n) {
			await db
				.update(receiptIntakes)
				.set({ heldCount: sql`${receiptIntakes.heldCount} + ${n}` })
				.where(eq(receiptIntakes.id, intake.id))
		},

		async saveReceipts(intake, input) {
			let saved = 0
			for (const file of input.files) {
				try {
					await saveOne(db, storage, intake, input.source, input.sender, input.at, file)
					saved++
				} catch (err) {
					logger.error('receipt_intake.save_failed', {
						intake_id: intake.id,
						source: input.source,
						error: err instanceof Error ? err.message : String(err),
					})
				}
			}
			if (saved > 0) {
				await db
					.update(receiptIntakes)
					.set({ acceptedCount: sql`${receiptIntakes.acceptedCount} + ${saved}` })
					.where(eq(receiptIntakes.id, intake.id))
			}
			return saved
		},
	}
}

/** Resend serves attachment bytes from its own CDN over https. Anything else is not followed. */
export function isTrustedDownloadUrl(raw: string): boolean {
	let url: URL
	try {
		url = new URL(raw)
	} catch {
		return false
	}
	if (url.protocol !== 'https:') return false
	const host = url.hostname.toLowerCase()
	return (
		host === 'resend.app' ||
		host.endsWith('.resend.app') ||
		host === 'resend.com' ||
		host.endsWith('.resend.com') ||
		host.endsWith('.cloudfront.net')
	)
}

async function saveOne(
	db: Database,
	storage: StorageProvider,
	intake: IntakeRow,
	source: Source,
	sender: string | null,
	at: Date,
	file: ReceiptFile,
): Promise<void> {
	const fileId = randomUUID()
	const storageKey = fileStorageKey(intake.workspaceId, fileId)
	const month = monthKey(at)
	const day = utcDay(at)
	const description =
		source === 'email'
			? `Receipt received by email from ${sender ?? 'an allowed sender'} on ${day}.`
			: `Receipt received by command on ${day}.`

	// Row first, then bytes, then undo the row if the bytes fail, like the plain file route.
	await db.insert(files).values({
		id: fileId,
		workspaceId: intake.workspaceId,
		name: receiptFileName(file.name, file.type.ext),
		description,
		kind: 'receipt',
		tags: ['receipt', `month:${month}`, `source:${source}`],
		mimeType: file.type.mime,
		sizeBytes: file.bytes.byteLength,
		storageKey,
		contentHash: sha256Hex(file.bytes),
		createdBy: intake.createdBy,
	})
	try {
		await storage.put(storageKey, file.bytes)
	} catch (err) {
		await db.delete(files).where(eq(files.id, fileId))
		throw err
	}

	await db
		.insert(relationships)
		.values({
			sourceType: 'object',
			sourceId: intake.loopObjectId,
			targetType: 'file',
			targetId: fileId,
			type: 'attached',
			createdBy: intake.createdBy,
		})
		.onConflictDoNothing({
			target: [relationships.sourceId, relationships.targetId, relationships.type],
		})

	// The one thing that wakes an agent. Ids and counts only: no sender, no name, no text.
	await recordEvent(db, {
		workspaceId: intake.workspaceId,
		actorId: intake.createdBy,
		action: RECEIPT_EVENT_ACTION,
		entityType: RECEIPT_EVENT_ENTITY_TYPE,
		entityId: fileId,
		data: {
			file_id: fileId,
			loop_id: intake.loopObjectId,
			intake_id: intake.id,
			source,
			month,
		},
	})
}
