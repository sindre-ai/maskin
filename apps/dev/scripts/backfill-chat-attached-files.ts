// One-off: link every chat to the files attached in it, for messages stored before the live
// writer existed (`conversation -> file` `has_file` edges, see services/chat-files-backfill.ts).
// Run it after the deploy that ships the writer, a dry run first.
//
// Run (dry run is the default and writes nothing):
//   DATABASE_URL=... pnpm --filter @maskin/dev exec tsx scripts/backfill-chat-attached-files.ts \
//     [--workspace=<workspace id>] [--apply]
//
// Insert only and safe to re-run: a second run adds zero links. Prints the counts the rollout
// check reads: messages scanned, links added, already linked, skipped (file missing, file in
// another workspace, id not a UUID).

import { pathToFileURL } from 'node:url'
import { createDb } from '@maskin/db'
import { backfillChatAttachedFiles } from '../src/services/chat-files-backfill'

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
	const label = args.apply ? '' : '[dry run] '
	try {
		const c = await backfillChatAttachedFiles(db, {
			...args,
			onBatch: (n) =>
				console.log(`${label}scanned ${n.messagesScanned} messages, links ${n.linksAdded}`),
		})
		console.log(
			`${label}messages scanned: ${c.messagesScanned}\n` +
				`${label}links ${args.apply ? 'added' : 'to add'}: ${c.linksAdded}\n` +
				`${label}already linked: ${c.alreadyLinked}\n` +
				`${label}skipped, file missing: ${c.skippedMissing}\n` +
				`${label}skipped, file in another workspace: ${c.skippedOtherWorkspace}\n` +
				`${label}skipped, id not a UUID: ${c.skippedBadId}`,
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
