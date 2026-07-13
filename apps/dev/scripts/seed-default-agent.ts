// One-shot seeder for a workspace's default chat agent.
//
// Sets `workspaces.settings.default_agent_id` to the Chief of Staff actor id
// scoped to the target workspace. Reversible in one command via `--unset`.
//
// Default target is Maskin's own workspace — the parent bet
// ("Chief of Staff stub — do owner chats route through it without domain
// output?") scopes the prototype to that workspace only. Override with
// `--workspace-id=<uuid>` or `WORKSPACE_ID=<uuid>` if needed for e.g. staging.
//
// Run:
//   DATABASE_URL=... pnpm --filter @maskin/dev exec tsx scripts/seed-default-agent.ts
//   DATABASE_URL=... pnpm --filter @maskin/dev exec tsx scripts/seed-default-agent.ts --unset
//   DATABASE_URL=... pnpm --filter @maskin/dev exec tsx scripts/seed-default-agent.ts --workspace-id=<uuid>
//
// Idempotency: re-running with no flag is a no-op if the field is already set
// to the same actor id. Re-running `--unset` on an already-null field is also
// a no-op. Each mutation emits a `workspace.updated` audit event.

import { pathToFileURL } from 'node:url'
import { createDb } from '@maskin/db'
import { events, actors, workspaceMembers, workspaces } from '@maskin/db/schema'
import { CHIEF_OF_STAFF_DEFAULT } from '@maskin/shared'
import { and, eq, sql } from 'drizzle-orm'

export const MASKIN_SELF_WORKSPACE_ID = 'fe944fe6-7b45-478c-afc7-b889cea63c08'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type ParsedArgs = { workspaceId: string; unset: boolean }

/**
 * Argv/env parser split out for unit tests. Precedence: `--workspace-id=<uuid>`
 * flag → `WORKSPACE_ID` env var → Maskin's own workspace id. Throws on invalid
 * UUID so the caller can decide between exit(1) and rethrow.
 */
export function parseArgs(argv: readonly string[], env: NodeJS.ProcessEnv): ParsedArgs {
	const flag = argv.find((a) => a.startsWith('--workspace-id='))
	const raw = flag?.split('=')[1] ?? env.WORKSPACE_ID ?? MASKIN_SELF_WORKSPACE_ID
	if (!UUID_RE.test(raw)) {
		throw new Error(`Invalid workspace id: ${raw}`)
	}
	return { workspaceId: raw, unset: argv.includes('--unset') }
}

async function main(): Promise<void> {
	const url = process.env.POSTGRES_URL || process.env.DATABASE_URL
	if (!url) {
		console.error('POSTGRES_URL or DATABASE_URL is required.')
		process.exit(1)
	}

	let workspaceId: string
	let unset: boolean
	try {
		;({ workspaceId, unset } = parseArgs(process.argv, process.env))
	} catch (err) {
		console.error(err instanceof Error ? err.message : String(err))
		process.exit(1)
	}

	const db = createDb(url)

	const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1)
	if (!ws) {
		console.error(`Workspace ${workspaceId} not found.`)
		process.exit(1)
	}
	if (!ws.createdBy) {
		console.error(
			`Workspace ${workspaceId} has no created_by actor — cannot attribute the audit event. Refusing to write.`,
		)
		process.exit(1)
	}
	const eventActorId = ws.createdBy

	const currentSettings = (ws.settings ?? {}) as Record<string, unknown>
	const currentDefault =
		typeof currentSettings.default_agent_id === 'string'
			? (currentSettings.default_agent_id as string)
			: null

	if (unset) {
		if (currentDefault === null) {
			console.log(`Workspace ${workspaceId} already has no default_agent_id — no-op.`)
			process.exit(0)
		}

		await db.transaction(async (tx) => {
			await tx
				.update(workspaces)
				.set({
					settings: sql`COALESCE(${workspaces.settings}, '{}'::jsonb) - 'default_agent_id'`,
				})
				.where(eq(workspaces.id, workspaceId))

			await tx.insert(events).values({
				workspaceId,
				actorId: eventActorId,
				action: 'updated',
				entityType: 'workspace',
				entityId: workspaceId,
				data: { field: 'default_agent_id', previous: currentDefault, next: null },
			})
		})

		console.log(
			`Cleared workspace ${workspaceId} default_agent_id (was ${currentDefault}). Prototype rolling-kill fast-path complete.`,
		)
		process.exit(0)
	}

	const [chief] = await db
		.select({ id: actors.id })
		.from(workspaceMembers)
		.innerJoin(actors, eq(workspaceMembers.actorId, actors.id))
		.where(
			and(
				eq(workspaceMembers.workspaceId, workspaceId),
				eq(actors.name, CHIEF_OF_STAFF_DEFAULT.name),
			),
		)
		.limit(1)

	if (!chief) {
		console.error(
			`Chief of Staff actor not found in workspace ${workspaceId}. Run workspace bootstrap first so the actor is seeded.`,
		)
		process.exit(1)
	}

	if (currentDefault === chief.id) {
		console.log(
			`Workspace ${workspaceId} default_agent_id is already ${chief.id} (Chief of Staff) — no-op.`,
		)
		process.exit(0)
	}

	await db.transaction(async (tx) => {
		const nextJson = JSON.stringify({ default_agent_id: chief.id })
		await tx
			.update(workspaces)
			.set({
				settings: sql`COALESCE(${workspaces.settings}, '{}'::jsonb) || ${nextJson}::jsonb`,
			})
			.where(eq(workspaces.id, workspaceId))

		await tx.insert(events).values({
			workspaceId,
			actorId: eventActorId,
			action: 'updated',
			entityType: 'workspace',
			entityId: workspaceId,
			data: { field: 'default_agent_id', previous: currentDefault, next: chief.id },
		})
	})

	console.log(
		`Set workspace ${workspaceId} default_agent_id to ${chief.id} (Chief of Staff). Was ${currentDefault ?? 'unset'}.`,
	)
	process.exit(0)
}

// Guard against running when imported by tests. Argv[1] is undefined under
// vitest workers, and truthy under direct `tsx` execution.
const invokedDirectly =
	typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
	main().catch((err) => {
		console.error(err instanceof Error ? err.stack || err.message : err)
		process.exit(1)
	})
}
