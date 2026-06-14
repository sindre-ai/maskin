import type { Database } from '@maskin/db'
import { events, notifications, objects, relationships, workspaces } from '@maskin/db/schema'
import {
	CONTACT_FIELDS,
	MODULE_ID as CRM_MODULE_ID,
	CRM_RELATIONSHIP_TYPES,
} from '@maskin/ext-crm/shared'
import { and, eq, sql } from 'drizzle-orm'
import { logger } from '../lib/logger'

const CONTACT_TYPE = 'contact'
const MEETING_TYPE = 'meeting'
const ATTENDED_BY = 'attended_by'

// Lightweight shape check — the route layer already rejects invalid emails via
// Zod, but the service guards too so internal callers can't sneak `''` past.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export interface UpsertContactInput {
	db: Database
	workspaceId: string
	sourceActorId: string
	email: string
	name?: string | null
	meetingId?: string | null
}

export interface UpsertContactResult {
	contactId: string
	created: boolean
	crmAutoEnabled: boolean
	notificationId: string | null
	attendedByRelationshipId: string | null
}

export class InvalidEmailError extends Error {
	readonly code = 'INVALID_EMAIL'
	constructor(email: string) {
		super(`Invalid email: ${email}`)
	}
}

export class WorkspaceNotFoundError extends Error {
	readonly code = 'WORKSPACE_NOT_FOUND'
	constructor(workspaceId: string) {
		super(`Workspace not found: ${workspaceId}`)
	}
}

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0]

/**
 * Deterministically upsert a CRM contact for a meeting attendee.
 *
 * Matches on `lower(metadata->>'email')`. On first use in a workspace,
 * auto-enables the `crm` module and emits a `good_news` notification — D6
 * forbids silently mutating workspace modules. Idempotent across the contact,
 * the relationship, and module-enable: a duplicate call with the same email
 * (case-insensitive) and meeting_id returns the same ids without inserting.
 *
 * Two parallel Summarization Agent runs cannot race-create duplicate contacts
 * or duplicate notifications. The whole body runs in one transaction; the
 * contact + relationship inserts use `ON CONFLICT DO NOTHING` (relying on
 * `objects_contact_email_lower_uniq` and `relationships_src_tgt_type_uniq`);
 * the workspace row is `SELECT … FOR UPDATE`-locked so concurrent first-time
 * CRM enables serialize and emit the notification exactly once.
 */
export async function upsertContactByEmail(
	input: UpsertContactInput,
): Promise<UpsertContactResult> {
	const { db, workspaceId, sourceActorId, meetingId } = input
	const email = input.email.trim().toLowerCase()
	if (!EMAIL_RE.test(email)) throw new InvalidEmailError(input.email)
	const name = input.name?.trim() || null

	return await db.transaction(async (tx) => {
		// 1. Lock the workspace row so concurrent runs serialize on the
		//    first-enable check. Without this, two parallel runs both see crm
		//    disabled and both insert the `good_news` notification.
		const enableResult = await ensureCrmEnabled(tx, workspaceId, sourceActorId)

		// 2. Insert-or-match contact via the partial unique index. Drizzle's
		//    onConflictDoNothing target is column-only and can't express
		//    `(workspace_id, (lower((metadata->>'email')))) WHERE type='contact'`,
		//    so the insert is raw SQL parameterized through drizzle's `sql`.
		const metadata: Record<string, string> = { email }
		if (name) metadata.name = name
		const metadataJson = JSON.stringify(metadata)
		const insertedIds = (await tx.execute(sql`
			INSERT INTO objects (workspace_id, type, status, title, created_by, metadata)
			VALUES (
				${workspaceId}::uuid,
				${CONTACT_TYPE},
				'new',
				${name || email},
				${sourceActorId}::uuid,
				${metadataJson}::jsonb
			)
			ON CONFLICT (workspace_id, (lower((metadata->>'email')))) WHERE type = 'contact'
			DO NOTHING
			RETURNING id
		`)) as unknown as Array<{ id: string }>

		let contactId: string
		let created = false
		if (insertedIds[0]) {
			contactId = insertedIds[0].id
			created = true
			const [contactRow] = await tx.select().from(objects).where(eq(objects.id, contactId)).limit(1)
			await tx.insert(events).values({
				workspaceId,
				actorId: sourceActorId,
				action: 'created',
				entityType: 'object',
				entityId: contactId,
				data: contactRow,
			})
			logger.info('attendee-contact: created contact', {
				workspaceId,
				contactId,
				email,
			})
		} else {
			const matches = await tx
				.select({ id: objects.id })
				.from(objects)
				.where(
					and(
						eq(objects.workspaceId, workspaceId),
						eq(objects.type, CONTACT_TYPE),
						sql`lower(${objects.metadata}->>'email') = ${email}`,
					),
				)
				.limit(1)
			const existing = matches[0]
			if (!existing) throw new Error(`Failed to upsert contact for ${email}`)
			contactId = existing.id
		}

		// 3. Optionally create meeting—attended_by→contact (idempotent on the
		//    (sourceId, targetId, type) unique constraint).
		let attendedByRelationshipId: string | null = null
		if (meetingId) {
			const insertedRels = await tx
				.insert(relationships)
				.values({
					sourceType: MEETING_TYPE,
					sourceId: meetingId,
					targetType: CONTACT_TYPE,
					targetId: contactId,
					type: ATTENDED_BY,
					createdBy: sourceActorId,
				})
				.onConflictDoNothing({
					target: [relationships.sourceId, relationships.targetId, relationships.type],
				})
				.returning()
			const newRel = insertedRels[0]
			if (newRel) {
				attendedByRelationshipId = newRel.id
				await tx.insert(events).values({
					workspaceId,
					actorId: sourceActorId,
					action: 'created',
					entityType: 'relationship',
					entityId: newRel.id,
					data: newRel,
				})
			} else {
				const existingRels = await tx
					.select({ id: relationships.id })
					.from(relationships)
					.where(
						and(
							eq(relationships.sourceId, meetingId),
							eq(relationships.targetId, contactId),
							eq(relationships.type, ATTENDED_BY),
						),
					)
					.limit(1)
				const existingRel = existingRels[0]
				if (existingRel) attendedByRelationshipId = existingRel.id
			}
		}

		return {
			contactId,
			created,
			crmAutoEnabled: enableResult.crmAutoEnabled,
			notificationId: enableResult.notificationId,
			attendedByRelationshipId,
		}
	})
}

interface EnsureCrmResult {
	crmAutoEnabled: boolean
	notificationId: string | null
}

async function ensureCrmEnabled(
	tx: Tx,
	workspaceId: string,
	sourceActorId: string,
): Promise<EnsureCrmResult> {
	// FOR UPDATE row-lock the workspace so two concurrent first-enables
	// can't both observe `crm disabled` and both emit a notification.
	const [workspaceRow] = await tx
		.select()
		.from(workspaces)
		.where(eq(workspaces.id, workspaceId))
		.for('update')
		.limit(1)
	if (!workspaceRow) throw new WorkspaceNotFoundError(workspaceId)

	const currentSettings = (workspaceRow.settings ?? {}) as Record<string, unknown>
	const enabledModules = Array.isArray(currentSettings.enabled_modules)
		? (currentSettings.enabled_modules as string[])
		: []
	const existingRelTypes = Array.isArray(currentSettings.relationship_types)
		? (currentSettings.relationship_types as string[])
		: []

	const crmAlreadyOn = enabledModules.includes(CRM_MODULE_ID)
	const relTypesMissing = !existingRelTypes.includes(ATTENDED_BY)
	if (crmAlreadyOn && !relTypesMissing) {
		return { crmAutoEnabled: false, notificationId: null }
	}

	const mergedSettings: Record<string, unknown> = { ...currentSettings }
	if (!crmAlreadyOn) {
		mergedSettings.enabled_modules = [...enabledModules, CRM_MODULE_ID]
		const fieldDefs = (currentSettings.field_definitions ?? {}) as Record<string, unknown>
		if (!fieldDefs.contact) {
			mergedSettings.field_definitions = { ...fieldDefs, contact: CONTACT_FIELDS }
		}
	}
	const relTypesToAdd: string[] = []
	if (!crmAlreadyOn) {
		for (const t of CRM_RELATIONSHIP_TYPES) {
			if (!existingRelTypes.includes(t) && !relTypesToAdd.includes(t)) relTypesToAdd.push(t)
		}
	}
	if (relTypesMissing && !relTypesToAdd.includes(ATTENDED_BY)) {
		relTypesToAdd.push(ATTENDED_BY)
	}
	if (relTypesToAdd.length) {
		mergedSettings.relationship_types = [...existingRelTypes, ...relTypesToAdd]
	}

	const [updatedWs] = await tx
		.update(workspaces)
		.set({ settings: mergedSettings, updatedAt: new Date() })
		.where(eq(workspaces.id, workspaceId))
		.returning()
	if (!updatedWs) throw new Error(`Failed to update workspace ${workspaceId}`)

	await tx.insert(events).values({
		workspaceId,
		actorId: sourceActorId,
		action: 'updated',
		entityType: 'workspace',
		entityId: workspaceId,
		data: { updated: updatedWs },
	})

	if (!crmAlreadyOn) {
		const [notif] = await tx
			.insert(notifications)
			.values({
				workspaceId,
				sourceActorId,
				type: 'good_news',
				title: 'CRM module enabled',
				content: 'Enabling CRM module to track meeting attendees as contacts.',
				status: 'pending',
			})
			.returning()
		logger.info('attendee-contact: auto-enabled crm module', {
			workspaceId,
			notificationId: notif?.id ?? null,
		})
		return { crmAutoEnabled: true, notificationId: notif?.id ?? null }
	}
	return { crmAutoEnabled: false, notificationId: null }
}
