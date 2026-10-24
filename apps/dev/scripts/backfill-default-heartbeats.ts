// Give every existing agent its default daily Heartbeat trigger, and bring the prompt of
// untouched ones up to the current wording (HEARTBEAT_PROMPT). Safe to re-run: an agent that
// already has a Heartbeat is left alone, and a second run with no wording change does nothing.
//
// Run:
//   DATABASE_URL=... pnpm --filter @maskin/dev exec tsx scripts/backfill-default-heartbeats.ts \
//     [--workspace=<workspace id>] [--dry-run]
//
// --workspace limits the run to one workspace. Without it every workspace is covered, and each
// of its agents then runs one short session a day on that workspace's own credentials.
// --dry-run prints what would change and writes nothing.
//
// New agents made through POST /api/actors get their Heartbeat at creation; this script is for
// the agents that existed before that.

import { pathToFileURL } from 'node:url'
import { createDb } from '@maskin/db'
import { backfillDefaultHeartbeats } from '../src/services/default-heartbeat'

function readArgs(argv: string[]): { dryRun: boolean; workspaceId?: string } {
	const workspaceArg = argv.find((a) => a.startsWith('--workspace='))
	const workspaceId = workspaceArg?.slice('--workspace='.length)
	if (workspaceArg !== undefined && !/^[0-9a-f-]{36}$/i.test(workspaceId ?? '')) {
		throw new Error('--workspace must be a workspace id (uuid)')
	}
	return { dryRun: argv.includes('--dry-run'), workspaceId }
}

async function main() {
	const url = process.env.DATABASE_URL
	if (!url) throw new Error('DATABASE_URL is required')
	const args = readArgs(process.argv.slice(2))
	const db = createDb(url)
	try {
		const result = await backfillDefaultHeartbeats(db, args)
		console.log(
			`${args.dryRun ? '[dry run] ' : ''}${result.eligible} agent memberships eligible, ` +
				`${result.created} Heartbeats ${args.dryRun ? 'to create' : 'created'}, ` +
				`${result.reworded} prompts ${args.dryRun ? 'to update' : 'updated'}`,
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
