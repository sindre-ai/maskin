// One-shot backfill for the SDR agent on existing pilot workspaces.
//
// The SDR agent template ships as a default seed inside the workspace-create
// tx (see `seedDefaultAgentActors` / `bootstrapDefaultAgents` in
// `apps/dev/src/services/workspace-bootstrap.ts`), so every NEW workspace
// spins up with an SDR agent whose `tools.capabilities` includes `'linkedin'`
// — that's what unlocks the LinkedIn hero pill, Channels row, and Connect CTA
// on the agent detail page. Workspaces that existed before the seed landed
// don't have one, and the shipped LinkedIn UI never opens on them until they
// do.
//
// This script closes that gap. It calls `ensureSdrAgentActor(tx, wsId, createdBy)`
// — the same helper the bootstrap path uses — so the actor shape stays
// identical to fresh-workspace seeding. Idempotency lands via the existing
// `actors.name = 'SDR agent'` check inside `ensureSdrAgentActor`.
//
// Run:
//   DATABASE_URL=... pnpm --filter @maskin/dev exec tsx scripts/backfill-sdr-agent.ts --workspace-id=<uuid>
//   DATABASE_URL=... pnpm --filter @maskin/dev exec tsx scripts/backfill-sdr-agent.ts --all
//   WORKSPACE_ID=<uuid> DATABASE_URL=... pnpm --filter @maskin/dev exec tsx scripts/backfill-sdr-agent.ts
//
// Idempotency: a workspace whose SDR agent already exists is a no-op. The
// audit event (`workspace.updated { field: 'sdr_agent_actor_id' }`) is only
// emitted on the run that actually creates the actor.

import { pathToFileURL } from 'node:url'
import { type Database, createDb } from '@maskin/db'
import { events, actors, workspaceMembers, workspaces } from '@maskin/db/schema'
import { SDR_AGENT_DEFAULT } from '@maskin/shared'
import { and, eq } from 'drizzle-orm'
import { ensureSdrAgentActor } from '../src/services/workspace-bootstrap'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type ParsedArgs = { workspaceId: string | null; all: boolean }

/**
 * Argv/env parser split out for unit tests. Either `--all` or a single-workspace
 * target (via `--workspace-id=<uuid>` flag or `WORKSPACE_ID` env var) must be
 * given — there is no implicit default, so the operator has to name what they
 * mean. Throws on invalid UUID, missing target, or the two flags combined.
 */
export function parseArgs(argv: readonly string[], env: NodeJS.ProcessEnv): ParsedArgs {
	const flag = argv.find((a) => a.startsWith('--workspace-id='))
	const all = argv.includes('--all')
	if (all && flag) {
		throw new Error('--all cannot be combined with --workspace-id')
	}
	if (all) return { workspaceId: null, all: true }
	const raw = flag?.split('=')[1] ?? env.WORKSPACE_ID
	if (!raw) {
		throw new Error(
			'Provide --workspace-id=<uuid>, WORKSPACE_ID env var, or --all to backfill every workspace.',
		)
	}
	if (!UUID_RE.test(raw)) {
		throw new Error(`Invalid workspace id: ${raw}`)
	}
	return { workspaceId: raw, all: false }
}

export type BackfillOutcome = 'created' | 'alreadyExisted' | 'skippedNoOwner'

export type BackfillOne = {
	workspaceId: string
	outcome: BackfillOutcome
	sdrActorId: string | null
}

/**
 * Ensures the SDR agent exists in a single workspace. Wraps the pre-check +
 * ensureSdrAgentActor call + audit event insert in one transaction so a
 * partial failure never leaves a member row without its audit trail.
 * Returns the outcome so callers (single-workspace CLI or `backfillAll`) can
 * account for it in their summary.
 */
export async function backfillOne(db: Database, workspaceId: string): Promise<BackfillOne> {
	const [ws] = await db
		.select({ id: workspaces.id, createdBy: workspaces.createdBy })
		.from(workspaces)
		.where(eq(workspaces.id, workspaceId))
		.limit(1)
	if (!ws) {
		throw new Error(`Workspace ${workspaceId} not found.`)
	}
	if (!ws.createdBy) {
		return { workspaceId, outcome: 'skippedNoOwner', sdrActorId: null }
	}
	const createdBy = ws.createdBy

	return await db.transaction(async (tx) => {
		const [existing] = await tx
			.select({ actorId: workspaceMembers.actorId })
			.from(workspaceMembers)
			.innerJoin(actors, eq(workspaceMembers.actorId, actors.id))
			.where(
				and(eq(workspaceMembers.workspaceId, workspaceId), eq(actors.name, SDR_AGENT_DEFAULT.name)),
			)
			.limit(1)

		if (existing) {
			return {
				workspaceId,
				outcome: 'alreadyExisted' as const,
				sdrActorId: existing.actorId,
			}
		}

		const sdrId = await ensureSdrAgentActor(tx, workspaceId, createdBy)

		await tx.insert(events).values({
			workspaceId,
			actorId: createdBy,
			action: 'updated',
			entityType: 'workspace',
			entityId: workspaceId,
			data: { field: 'sdr_agent_actor_id', previous: null, next: sdrId },
		})

		return { workspaceId, outcome: 'created' as const, sdrActorId: sdrId }
	})
}

/**
 * Sweeps every workspace in the database. Never overwrites, never rolls the
 * whole run back on a single-workspace failure — logs the offender and moves
 * on so a bad row in one workspace can't block the rest of the pilot cohort.
 */
export async function backfillAll(db: Database): Promise<{
	created: number
	alreadyExisted: number
	skippedNoOwner: number
	failed: number
}> {
	const rows = await db.select({ id: workspaces.id }).from(workspaces)

	let created = 0
	let alreadyExisted = 0
	let skippedNoOwner = 0
	let failed = 0

	for (const ws of rows) {
		try {
			const result = await backfillOne(db, ws.id)
			if (result.outcome === 'created') created++
			else if (result.outcome === 'alreadyExisted') alreadyExisted++
			else skippedNoOwner++
		} catch (err) {
			failed++
			console.error(`Workspace ${ws.id} failed:`, err instanceof Error ? err.message : String(err))
		}
	}

	console.log(
		`Backfill complete: ${created} SDR agent(s) created, ${alreadyExisted} already existed, ${skippedNoOwner} skipped (no created_by), ${failed} failed.`,
	)
	return { created, alreadyExisted, skippedNoOwner, failed }
}

async function main(): Promise<void> {
	const url = process.env.POSTGRES_URL || process.env.DATABASE_URL
	if (!url) {
		console.error('POSTGRES_URL or DATABASE_URL is required.')
		process.exit(1)
	}

	let parsed: ParsedArgs
	try {
		parsed = parseArgs(process.argv, process.env)
	} catch (err) {
		console.error(err instanceof Error ? err.message : String(err))
		process.exit(1)
	}

	const db = createDb(url)

	if (parsed.all) {
		const summary = await backfillAll(db)
		process.exit(summary.failed > 0 ? 1 : 0)
	}

	const workspaceId = parsed.workspaceId as string
	try {
		const result = await backfillOne(db, workspaceId)
		if (result.outcome === 'created') {
			console.log(`Created SDR agent ${result.sdrActorId} in workspace ${workspaceId}.`)
			process.exit(0)
		}
		if (result.outcome === 'alreadyExisted') {
			console.log(`Workspace ${workspaceId} already has SDR agent ${result.sdrActorId} — no-op.`)
			process.exit(0)
		}
		console.error(
			`Workspace ${workspaceId} has no created_by actor — cannot attribute the audit event. Refusing to write.`,
		)
		process.exit(1)
	} catch (err) {
		console.error(err instanceof Error ? err.message : String(err))
		process.exit(1)
	}
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
