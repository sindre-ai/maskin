import { generateApiKey } from '@maskin/auth'
import type { Database, Transaction } from '@maskin/db'
import {
	INTEGRATION_STATUS_ACTIVE,
	actors,
	integrations,
	workspaceMembers,
} from '@maskin/db/schema'
import { and, eq, isNull } from 'drizzle-orm'
import { decrypt, encrypt } from '../crypto'
import { extensionProvider } from './extensions'

const EXTENSION_SYSTEM_ACTOR_NAME = 'Custom extension'

/**
 * Events need an actor, and the generic webhook route has no human behind a
 * delivery. Same shape as the Skjald system actor: one shared system actor,
 * added to each workspace as a member with the 'system' role.
 */
export async function ensureExtensionSystemActor(
	db: Database | Transaction,
	workspaceId: string,
	createdBy: string | null,
): Promise<string> {
	let [systemActor] = await db
		.select({ id: actors.id })
		.from(actors)
		.where(and(eq(actors.type, 'system'), eq(actors.name, EXTENSION_SYSTEM_ACTOR_NAME)))
		.limit(1)
	if (!systemActor) {
		;[systemActor] = await db
			.insert(actors)
			.values({
				type: 'system',
				name: EXTENSION_SYSTEM_ACTOR_NAME,
				apiKey: generateApiKey().key,
				createdBy,
			})
			.returning({ id: actors.id })
	}
	if (!systemActor) throw new Error('Failed to create system actor for extensions')

	const [member] = await db
		.select({ actorId: workspaceMembers.actorId })
		.from(workspaceMembers)
		.where(
			and(
				eq(workspaceMembers.workspaceId, workspaceId),
				eq(workspaceMembers.actorId, systemActor.id),
			),
		)
		.limit(1)
	if (!member) {
		await db.insert(workspaceMembers).values({ workspaceId, actorId: systemActor.id, role: 'system' })
	}
	return systemActor.id
}

function secretRowWhere(workspaceId: string, slug: string) {
	return and(
		eq(integrations.workspaceId, workspaceId),
		eq(integrations.provider, extensionProvider(slug)),
		isNull(integrations.actorId),
	)
}

/**
 * Store (or replace) an extension's signing secret, encrypted, in the same
 * table and path Skjald uses: provider 'extension:{slug}', actor_id null.
 * The unique index on (workspace, actor, provider) does not dedupe a NULL
 * actor, so this selects first rather than relying on ON CONFLICT.
 */
export async function upsertExtensionSecret(
	db: Database | Transaction,
	args: { workspaceId: string; slug: string; secret: string; createdBy: string },
): Promise<void> {
	const credentials = encrypt(args.secret)
	const [existing] = await db
		.select({ id: integrations.id })
		.from(integrations)
		.where(secretRowWhere(args.workspaceId, args.slug))
		.limit(1)
	if (existing) {
		await db
			.update(integrations)
			.set({ credentials, status: INTEGRATION_STATUS_ACTIVE, updatedAt: new Date() })
			.where(eq(integrations.id, existing.id))
		return
	}
	await db.insert(integrations).values({
		workspaceId: args.workspaceId,
		provider: extensionProvider(args.slug),
		status: INTEGRATION_STATUS_ACTIVE,
		credentials,
		config: {},
		actorId: null,
		createdBy: args.createdBy,
	})
}

export async function hasExtensionSecret(
	db: Database | Transaction,
	workspaceId: string,
	slug: string,
): Promise<boolean> {
	const [row] = await db
		.select({ id: integrations.id })
		.from(integrations)
		.where(secretRowWhere(workspaceId, slug))
		.limit(1)
	return !!row
}

/** Decrypted signing secret, or null when none is stored. Never return this from a read API. */
export async function readExtensionSecret(
	db: Database | Transaction,
	workspaceId: string,
	slug: string,
): Promise<string | null> {
	const [row] = await db
		.select({ credentials: integrations.credentials })
		.from(integrations)
		.where(secretRowWhere(workspaceId, slug))
		.limit(1)
	if (!row?.credentials) return null
	return decrypt(row.credentials)
}
