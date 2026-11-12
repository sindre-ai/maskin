// One-off move of the target rows inside flows (metadata.targets) into target objects, plus
// one company target for "10 paying customers". Prints what it would create, then writes it.
// The old rows stay in place, so the flows list keeps working if the move is rolled back
// (delete the target objects it created). Safe to re-run: a second run creates nothing.
//
// Run:
//   DATABASE_URL=... pnpm --filter @maskin/dev exec tsx scripts/move-targets-to-objects.ts \
//     [--workspace=<workspace id>] [--deadline=YYYY-MM-DD] [--dry-run]
//
// --dry-run prints the list and writes nothing; run it first. --workspace limits the run to
// one workspace. --deadline sets the deadline of the company target (default: 31 Jan 2027,
// set by Sebastian on 5 Nov). Only workspaces with the targets extension enabled are touched.

import { pathToFileURL } from 'node:url'
import { createDb } from '@maskin/db'
import {
	COMPANY_TARGET_DEADLINE,
	COMPANY_TARGET_TITLE,
	moveTargetsToObjects,
} from '../src/services/move-targets-to-objects'

function readArgs(argv: string[]) {
	const value = (name: string) =>
		argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)
	const workspaceId = value('workspace')
	if (workspaceId !== undefined && !/^[0-9a-f-]{36}$/i.test(workspaceId)) {
		throw new Error('--workspace must be a workspace id (uuid)')
	}
	const companyDeadline = value('deadline')
	if (companyDeadline !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(companyDeadline)) {
		throw new Error('--deadline must be a date like 2027-01-31')
	}
	return { dryRun: argv.includes('--dry-run'), workspaceId, companyDeadline }
}

async function main() {
	const url = process.env.DATABASE_URL
	if (!url) throw new Error('DATABASE_URL is required')
	const args = readArgs(process.argv.slice(2))
	const db = createDb(url)
	try {
		// Always list first: the dry run is the same plan with the write switched off.
		const plan = await moveTargetsToObjects(db, { ...args, dryRun: true })
		for (const t of plan.flowTargetsToCreate) {
			console.log(
				`  target "${t.label}" -> flow "${t.loopTitle}" (actual ${t.row.actual}, target ${t.row.target}, owner ${t.row.ownerActorId ?? 'none'})${t.servesCompanyTarget ? `  [serves "${COMPANY_TARGET_TITLE}"]` : ''}`,
			)
		}
		for (const r of plan.invalidRows) {
			console.log(`  skipped (fails the row shape check): "${r.label}" in flow ${r.loopId}`)
		}
		for (const id of plan.skippedWorkspaceIds) {
			console.log(`  skipped workspace ${id}: the targets extension is not enabled`)
		}
		console.log(
			`${plan.flowTargetsToCreate.length} flow targets to create (${plan.flowTargetsExisting} already exist), ` +
				`${plan.companyTargetsToCreate} company target "${COMPANY_TARGET_TITLE}" to create (deadline ${args.companyDeadline ?? COMPANY_TARGET_DEADLINE}), ` +
				`${plan.companyLinksToCreate} links up to it`,
		)
		if (args.dryRun) {
			console.log('[dry run] nothing written')
			return
		}
		const done = await moveTargetsToObjects(db, { ...args, dryRun: false })
		console.log(
			`written: ${done.flowTargetsToCreate.length} flow targets, ${done.companyTargetsToCreate} company target, ${done.companyLinksToCreate} links`,
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
