// Seal the LLM keys that workspaces saved before they were stored encrypted:
// every settings.llm_keys.* value and settings.custom_llm.api_key still in plain text.
// Idempotent: a value that is already sealed is left alone, so a second run does nothing.
//
// Run (dry run by default; it counts and never prints a value):
//   DATABASE_URL=... INTEGRATION_ENCRYPTION_KEY=... \
//     pnpm --filter @maskin/dev exec tsx scripts/encrypt-workspace-llm-secrets.ts [--apply] [--revert]
//
// --apply   write the change. Each workspace row is locked, rewritten and committed on its own.
//           Writes no events and leaves updated_at alone.
// --revert  go the other way: open the sealed values back to plain text. This is the way back
//           if the sealing code is rolled back, because code from before it would otherwise
//           send the sealed text to the provider as the API key. Combine with --apply to write.
//
// Order for the first run: deploy the sealing code, take a database backup, dry run, --apply,
// dry run again and expect 0 to seal.

import { pathToFileURL } from 'node:url'
import { createDb } from '@maskin/db'
import { workspaces } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import {
	SecretUnreadableError,
	countWorkspaceLlmSecrets,
	rewriteWorkspaceLlmSecrets,
} from '../src/lib/workspace-secrets'

function readArgs(argv: string[]): { apply: boolean; revert: boolean } {
	const known = new Set(['--apply', '--revert'])
	const unknown = argv.filter((a) => !known.has(a))
	if (unknown.length > 0) throw new Error(`Unknown argument: ${unknown.join(' ')}`)
	return { apply: argv.includes('--apply'), revert: argv.includes('--revert') }
}

async function main() {
	const url = process.env.DATABASE_URL
	if (!url) throw new Error('DATABASE_URL is required')
	const { apply, revert } = readArgs(process.argv.slice(2))
	const mode = revert ? 'open' : 'seal'
	const db = createDb(url)

	let scanned = 0
	let workspacesChanged = 0
	let valuesChanged = 0
	let unreadable = 0
	try {
		const rows = await db.select({ id: workspaces.id }).from(workspaces)
		for (const { id } of rows) {
			scanned++
			try {
				const result = await db.transaction(async (tx) => {
					const [row] = await tx
						.select({ settings: workspaces.settings })
						.from(workspaces)
						.where(eq(workspaces.id, id))
						.for('update')
					if (!row) return 0
					if (!apply) {
						const { sealed, plain } = countWorkspaceLlmSecrets(row.settings)
						return mode === 'seal' ? plain : sealed
					}
					const { settings, rewritten } = rewriteWorkspaceLlmSecrets(row.settings, mode)
					if (rewritten > 0) {
						await tx.update(workspaces).set({ settings }).where(eq(workspaces.id, id))
					}
					return rewritten
				})
				if (result > 0) {
					workspacesChanged++
					valuesChanged += result
				}
			} catch (err) {
				if (!(err instanceof SecretUnreadableError)) throw err
				// Name the workspace and field so it can be looked at; never the value.
				unreadable++
				console.error(`Workspace ${id}: ${err.field} cannot be decrypted, left as is`)
			}
		}
		const verb = mode === 'seal' ? 'seal' : 'open'
		const done = apply ? `${verb === 'seal' ? 'sealed' : 'opened'}` : `to ${verb}`
		console.log(
			`${apply ? '' : '[dry run] '}${scanned} workspaces scanned, ` +
				`${valuesChanged} values ${done} in ${workspacesChanged} workspaces, ` +
				`${unreadable} unreadable`,
		)
		if (unreadable > 0) process.exitCode = 1
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
