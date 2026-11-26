// Puts the known-wrong set through the outcome check against a real model and stores the counts.
//
// Ten pieces of work, each with one line its own text contradicts. The checker must send at least
// 8 of the 10 back (src/lib/outcome-known-wrong.ts). The counts are written as one event on the
// workspace; the pieces themselves are deleted again, so nothing is left behind.
//
// Run (needs a model the workspace can reach: its own key, or MASKIN_FALLBACK_OPENROUTER_KEY):
//   DATABASE_URL=... WORKSPACE_ID=<uuid> PERSON_ID=<human actor uuid> \
//     pnpm --filter @maskin/dev exec tsx scripts/outcome-known-wrong.ts
//
// A piece the checker could not judge (no model, a failed call) counts as not sent back, so a
// missing model cannot make the set look good.

import { createDb } from '@maskin/db'
import { events, doneWhenLines, objects, outcomeChecks } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { runOutcomeCheck } from '../src/lib/outcome-check'
import { KNOWN_WRONG_PASS_MARK, KNOWN_WRONG_SET } from '../src/lib/outcome-known-wrong'

const databaseUrl = process.env.DATABASE_URL
const workspaceId = process.env.WORKSPACE_ID
const personId = process.env.PERSON_ID
if (!databaseUrl || !workspaceId || !personId) {
	console.error('DATABASE_URL, WORKSPACE_ID and PERSON_ID are required')
	process.exit(1)
}

const db = createDb(databaseUrl)
const results: Array<{ title: string; sent_back: boolean; false_line_marked_no: boolean }> = []
let model: string | null = null

for (const piece of KNOWN_WRONG_SET) {
	const [job] = await db
		.insert(objects)
		.values({
			workspaceId,
			type: 'task',
			status: 'in_review',
			title: `[known-wrong] ${piece.title}`,
			content: piece.content,
			createdBy: personId,
		})
		.returning()
	if (!job) throw new Error('could not create a piece')
	try {
		const lines = await db
			.insert(doneWhenLines)
			.values(
				piece.lines.map((text, position) => ({
					workspaceId,
					objectId: job.id,
					position,
					text,
					checkedBy: 'checker',
					listStatus: 'approved',
					approvedBy: personId,
					approvedAt: new Date(),
					createdBy: personId,
				})),
			)
			.returning()
		const result = await runOutcomeCheck(db, {
			object: job,
			toStatus: 'done',
			actorId: personId,
		})
		const falseLine = lines.find((l) => l.position === piece.falseIndex)
		results.push({
			title: piece.title,
			sent_back: result.verdict === 'sent_back' || result.verdict === 'round_limit_reached',
			false_line_marked_no: result.lines.find((l) => l.line_id === falseLine?.id)?.mark === 'no',
		})
		if (result.checkId) {
			const [row] = await db
				.select({ model: outcomeChecks.checkerModel })
				.from(outcomeChecks)
				.where(eq(outcomeChecks.id, result.checkId))
			model = row?.model ?? model
		}
	} finally {
		await db.delete(objects).where(eq(objects.id, job.id))
	}
}

const sentBack = results.filter((r) => r.sent_back).length
const named = results.filter((r) => r.false_line_marked_no).length
await db.insert(events).values({
	workspaceId,
	actorId: personId,
	action: 'outcome_known_wrong_run',
	entityType: 'workspace',
	entityId: workspaceId,
	data: {
		total: results.length,
		sent_back: sentBack,
		false_line_named: named,
		pass_mark: KNOWN_WRONG_PASS_MARK,
		passed: sentBack >= KNOWN_WRONG_PASS_MARK,
		checker_model: model,
	},
})
console.log(JSON.stringify({ total: results.length, sentBack, named, results }, null, 2))
process.exit(sentBack >= KNOWN_WRONG_PASS_MARK ? 0 : 2)
