import { buildWebAppHref, stripTrailingSlash } from '@maskin/shared'
import type { StorageProvider } from '@maskin/storage'
import { logger } from '../lib/logger'

const LEDGER_MAX_LINES = 1000

/**
 * Briefing block prepended to every session's ACTION_PROMPT. Describes the
 * workspace terrain rather than prescribing steps — agentic models do better
 * with outcome-oriented context than with imperative checklists.
 *
 * Parameterised on the live `workspaceId` + `frontendUrl` so the agent sees
 * the exact host + workspace-scoped path it should emit when referencing an
 * object. Without this, agents hallucinate hosts like `app.maskin.ai`.
 */
export function buildWorkspaceStartupBlock(args: {
	workspaceId: string
	frontendUrl: string
}): string {
	const exampleUrl = buildWebAppHref(stripTrailingSlash(args.frontendUrl), args.workspaceId, {
		kind: 'object',
		id: '<id>',
	})
	return `## This workspace

This workspace works through bets — shaped, time-boxed outcomes.

- Active bets are where in-flight work lives; closed bets carry verdicts that teach the next cycle.
- Dig deeper with \`get_objects\`, \`search_objects\`, \`list_relationships\`.
- Status updates and \`metadata.verdict\` are how bets stay legible to future sessions.
- A one-line note in \`/agent/workspace/SESSION_LEARNING.md\` rolls up into the next session's briefing.

When you reference an object in a comment, notification, or description, emit a markdown link with this exact format — do not guess the host or drop the workspace segment:

\`[title](${exampleUrl})\`

You decide how to achieve the goal. This is just the terrain.

---

`
}

export function workspaceLedgerKey(workspaceId: string): string {
	return `agents/${workspaceId}/_workspace/learnings.md`
}

/**
 * Read the last `maxLines` entries from the workspace-scoped learnings ledger.
 * Returns an empty array if the ledger does not exist or cannot be read.
 */
export async function readLedgerTail(
	storage: StorageProvider,
	workspaceId: string,
	maxLines: number,
): Promise<string[]> {
	const key = workspaceLedgerKey(workspaceId)
	try {
		if (!(await storage.exists(key))) return []
		const buf = await storage.get(key)
		const lines = buf
			.toString('utf-8')
			.split('\n')
			.filter((l) => l.length > 0)
		return lines.slice(-maxLines)
	} catch (err) {
		logger.warn('Failed to read workspace ledger', { workspaceId, error: String(err) })
		return []
	}
}

/**
 * Append a single-line entry to the workspace ledger. Caps the ledger at
 * LEDGER_MAX_LINES (oldest entries drop). No-op if `line` is empty after trim.
 *
 * Skips the append (rather than proceeding with an empty baseline) if the
 * current ledger cannot be read. Without this guard, a transient S3 error
 * followed by a successful `put` would silently wipe all prior entries.
 *
 * Note: read-modify-write is not atomic. If two sessions in the same workspace
 * complete within milliseconds of each other, one entry may be lost. V2 should
 * move to per-session files concatenated at read time to eliminate this race.
 */
export async function appendToLedger(
	storage: StorageProvider,
	workspaceId: string,
	line: string,
): Promise<void> {
	const trimmed = line.replace(/[\r\n]+/g, ' ').trim()
	if (!trimmed) return
	const key = workspaceLedgerKey(workspaceId)

	let exists: boolean
	try {
		exists = await storage.exists(key)
	} catch (err) {
		logger.warn('Failed to check ledger existence — skipping append', {
			workspaceId,
			error: String(err),
		})
		return
	}

	let existing = ''
	if (exists) {
		try {
			existing = (await storage.get(key)).toString('utf-8')
		} catch (err) {
			logger.warn('Failed to read ledger before append — skipping to avoid wipe', {
				workspaceId,
				error: String(err),
			})
			return
		}
	}

	const existingLines = existing.split('\n').filter((l) => l.length > 0)
	const nextLines = [...existingLines, trimmed].slice(-LEDGER_MAX_LINES)
	await storage.put(key, Buffer.from(`${nextLines.join('\n')}\n`, 'utf-8'))
}
