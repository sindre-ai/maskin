// One-off sweep: remove the computers of agents that were deleted before PR 2971 made
// deleting an agent remove its computer. Lists the computers in every workspace from the
// agent-servers and compares them with the agents that still exist.
//
// Run (dry run is the default and deletes nothing):
//   DATABASE_URL=... pnpm --filter @maskin/dev exec tsx scripts/sweep-orphan-desktops.ts \
//     [--workspace=<workspace id>] [--apply]
//
// DATABASE_URL must be the database whose agent_servers table points at the real servers
// (the script reads their addresses and secrets from there).
//
// A computer is an orphan only when its agent id is gone from the actors table entirely.
// A computer whose agent still exists, including one whose agent exists but is not a member
// of this workspace, is left alone and printed as skipped. Matching is on the full id, never
// a prefix. --apply removes the orphans through WorkspaceDesktopService.remove, the same call
// the delete paths use; without it nothing is removed.
//
// The agent-server's list does not report disk use, so no size is printed. Computers in a
// workspace that no longer exists are not found, because the list is per workspace.

import { pathToFileURL } from 'node:url'
import { createDb } from '@maskin/db'
import { actors, workspaceMembers, workspaces } from '@maskin/db/schema'
import { and, eq, inArray } from 'drizzle-orm'
import { createWorkspaceDesktopService } from '../src/services/workspace-desktop'

function readArgs(argv: string[]): { apply: boolean; workspaceId?: string } {
	const workspaceArg = argv.find((a) => a.startsWith('--workspace='))
	const workspaceId = workspaceArg?.slice('--workspace='.length).toLowerCase()
	if (workspaceArg !== undefined && !/^[0-9a-f-]{36}$/.test(workspaceId ?? '')) {
		throw new Error('--workspace must be a workspace id (uuid)')
	}
	return { apply: argv.includes('--apply'), workspaceId }
}

async function main() {
	const url = process.env.DATABASE_URL
	if (!url) throw new Error('DATABASE_URL is required')
	const args = readArgs(process.argv.slice(2))
	const db = createDb(url)
	const service = createWorkspaceDesktopService(db)
	const mode = args.apply ? '' : '[dry run] '
	let orphans = 0
	let removed = 0
	let failed = 0
	let skipped = 0
	try {
		const rows = await db
			.select({ id: workspaces.id })
			.from(workspaces)
			.where(args.workspaceId ? eq(workspaces.id, args.workspaceId) : undefined)
		for (const { id: workspaceId } of rows) {
			const desktops = await service.list(workspaceId)
			if (desktops.length === 0) continue
			const agentIds = desktops.map((d) => d.agentId)
			const existing = new Set(
				(await db.select({ id: actors.id }).from(actors).where(inArray(actors.id, agentIds))).map(
					(r) => r.id,
				),
			)
			const members = new Set(
				(
					await db
						.select({ id: workspaceMembers.actorId })
						.from(workspaceMembers)
						.where(
							and(
								eq(workspaceMembers.workspaceId, workspaceId),
								inArray(workspaceMembers.actorId, agentIds),
							),
						)
				).map((r) => r.id),
			)
			for (const d of desktops) {
				if (members.has(d.agentId)) continue
				if (existing.has(d.agentId)) {
					skipped++
					const reason = 'agent exists but is not a member of this workspace'
					console.log(
						`${mode}SKIP workspace=${workspaceId} agent=${d.agentId} status=${d.status} (${reason})`,
					)
					continue
				}
				orphans++
				console.log(`${mode}ORPHAN workspace=${workspaceId} agent=${d.agentId} status=${d.status}`)
				if (!args.apply) continue
				try {
					const didRemove = await service.remove(workspaceId, d.agentId)
					if (didRemove) removed++
					console.log(`  removed=${didRemove}`)
				} catch (err) {
					failed++
					console.error(`  FAILED: ${err instanceof Error ? err.message : String(err)}`)
				}
			}
		}
		console.log(
			`${mode}${rows.length} workspaces checked, ${orphans} orphan computers found, ` +
				`${removed} removed, ${failed} failed, ${skipped} skipped`,
		)
	} finally {
		await db.$client.end()
	}
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
	main().catch((err) => {
		console.error(err)
		process.exit(1)
	})
}
