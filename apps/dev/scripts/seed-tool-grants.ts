// Give each agent a grant for every outside tool server it uses, so that setting an integration's
// default agent access to none later takes nothing away. Adds grants only, at the access the
// agent has today, so a session attaches the same tools before and after. Safe to re-run.
//
// Run:
//   DATABASE_URL=... pnpm --filter @maskin/dev exec tsx scripts/seed-tool-grants.ts \
//     [--workspace=<workspace id>] [--days=30] [--event-usage=<file.json>] [--dry-run]
//
// --event-usage is an optional JSON file { "<actor id>": ["gmail", "slack"] } read from the
// PostHog event integration_tool_called (never sampled, outside integrations only).
// Prints one line per agent: tools attached today, tools its grants keep once defaults are none,
// grants added, and servers it named that this script does not seed (Maskin's own, extensions).

import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { createDb } from '@maskin/db'
import { DEFAULT_USAGE_DAYS, seedToolGrants } from '../src/lib/integrations/tool-use-seed'

function readArgs(argv: string[]) {
	const value = (name: string) =>
		argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)
	const workspaceId = value('workspace')
	if (workspaceId !== undefined && !/^[0-9a-f-]{36}$/i.test(workspaceId)) {
		throw new Error('--workspace must be a workspace id (uuid)')
	}
	const days = value('days') === undefined ? DEFAULT_USAGE_DAYS : Number(value('days'))
	if (!Number.isInteger(days) || days < 1) throw new Error('--days must be a whole number')
	const eventFile = value('event-usage')
	const eventUsage = eventFile
		? (JSON.parse(readFileSync(eventFile, 'utf8')) as Record<string, string[]>)
		: undefined
	return { workspaceId, days, eventUsage, dryRun: argv.includes('--dry-run') }
}

async function main() {
	const url = process.env.DATABASE_URL
	if (!url) throw new Error('DATABASE_URL is required')
	const args = readArgs(process.argv.slice(2))
	const db = createDb(url)
	try {
		const reports = await seedToolGrants(db, args)
		for (const r of reports) {
			console.log(
				JSON.stringify({
					workspace: r.workspaceId,
					agent: r.name,
					before: r.attachedToday,
					after_defaults_none: r.attachedAfterDefaultsNone,
					grants_added: r.grantsAdded,
					not_seeded: r.skippedServers,
				}),
			)
		}
		const added = reports.reduce((n, r) => n + r.grantsAdded.length, 0)
		console.log(
			`${args.dryRun ? '[dry run] ' : ''}${reports.length} agents, ${added} grants ${args.dryRun ? 'to add' : 'added'}`,
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
