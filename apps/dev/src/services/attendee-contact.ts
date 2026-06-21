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

/**
 * Deterministically upsert a CRM contact for a meeting attendee.
 *
 * Matches on `lower(metadata->>'email')`. On first use in a workspace,
 * auto-enables the `crm` module and emits a `good_news` notification — D6
 * forbids silently mutating workspace modules. Idempotent across the contact,
 * the relationship, and module-enable: a duplicate call with the same email
 * (case-insensitive) and meeting_id returns the same ids without inserting.
 */
export async function upsertContactByEmail(
	input: UpsertContactInput,
): Promise<UpsertContactResult> {
	const { db, workspaceId, sourceActorId, meetingId } = input
	const email = input.email.trim().toLowerCase()
	if (!EMAIL_RE.test(email)) throw new InvalidEmailError(input.email)
	const name = input.name?.trim() || null

	// 1. Ensure CRM module enabled — emit notification on first enable.
	const enableResult = await ensureCrmEnabled({
		db,
		workspaceId,
		sourceActorId,
	})

	// 2. Find existing contact by lowercased email.
	const matches = await db
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

	let contactId: string
	let created = false
	const existingContact = matches[0]
	if (existingContact) {
		contactId = existingContact.id
	} else {
		const metadata: Record<string, string> = { email }
		if (name) metadata.name = name
		const [contact] = await db
			.insert(objects)
			.values({
				workspaceId,
				type: CONTACT_TYPE,
				status: 'new_lead',
				title: name || email,
				createdBy: sourceActorId,
				metadata,
			})
			.returning()
		if (!contact) throw new Error(`Failed to insert contact for ${email}`)
		contactId = contact.id
		created = true
		await db.insert(events).values({
			workspaceId,
			actorId: sourceActorId,
			action: 'created',
			entityType: 'object',
			entityId: contactId,
			data: contact,
		})
		logger.info('attendee-contact: created contact', {
			workspaceId,
			contactId,
			email,
		})
	}

	// 3. Optionally create meeting—attended_by→contact (idempotent on the
	//    (sourceId, targetId, type) unique constraint).
	let attendedByRelationshipId: string | null = null
	if (meetingId) {
		const existing = await db
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
		const existingRel = existing[0]
		if (existingRel) {
			attendedByRelationshipId = existingRel.id
		} else {
			const [rel] = await db
				.insert(relationships)
				.values({
					sourceType: MEETING_TYPE,
					sourceId: meetingId,
					targetType: CONTACT_TYPE,
					targetId: contactId,
					type: ATTENDED_BY,
					createdBy: sourceActorId,
				})
				.returning()
			if (rel) {
				attendedByRelationshipId = rel.id
				await db.insert(events).values({
					workspaceId,
					actorId: sourceActorId,
					action: 'created',
					entityType: 'relationship',
					entityId: rel.id,
					data: rel,
				})
			}
		}
	}

	return {
		contactId,
		created,
		crmAutoEnabled: enableResult.crmAutoEnabled,
		notificationId: enableResult.notificationId,
		attendedByRelationshipId,
	}
}

interface EnsureCrmInput {
	db: Database
	workspaceId: string
	sourceActorId: string
}

interface EnsureCrmResult {
	crmAutoEnabled: boolean
	notificationId: string | null
}

async function ensureCrmEnabled({
	db,
	workspaceId,
	sourceActorId,
}: EnsureCrmInput): Promise<EnsureCrmResult> {
	const [workspaceRow] = await db
		.select()
		.from(workspaces)
		.where(eq(workspaces.id, workspaceId))
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

	const [updatedWs] = await db
		.update(workspaces)
		.set({ settings: mergedSettings, updatedAt: new Date() })
		.where(eq(workspaces.id, workspaceId))
		.returning()
	if (!updatedWs) throw new Error(`Failed to update workspace ${workspaceId}`)

	await db.insert(events).values({
		workspaceId,
		actorId: sourceActorId,
		action: 'updated',
		entityType: 'workspace',
		entityId: workspaceId,
		data: { updated: updatedWs },
	})

	if (!crmAlreadyOn) {
		const [notif] = await db
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
