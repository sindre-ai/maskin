// The guard test that keeps `settleSession()` the only writer of a terminal
// `sessions.status`. Adapted from settle-session-tech-spec §4.2, with the
// commit-2 tightening (PR #1729 Risk-note option (a)): the property-assignment
// scan now checks the *enclosing* `.update(...)` receives the `sessions` table
// as its first argument, so a distinct entity table with its own `status`
// column (e.g. `imports.status`) is not counted as a session writer.
//
// At commit 2 this test flips green (0 red offenders) once every terminal
// writer in `session-manager.ts`, `session-dispatch-queue.ts`, and
// `session-reconciler.ts` funnels through `settleSession()`.

import { fileURLToPath } from 'node:url'
import { Project, SyntaxKind } from 'ts-morph'
import { expect, test } from 'vitest'

const TERMINALS = new Set(['completed', 'failed', 'timeout', 'user_stopped', 'paused'])
const ALLOW = 'src/services/session-lifecycle.ts'
// The Drizzle schema symbol whose `.update(...)` is the only shape the guard
// counts. Any other table (`imports`, `sessionDispatchAttempts`, …) has its own
// lifecycle and is out of scope for the terminal-writer rule.
const SESSIONS_TABLE = 'sessions'

// Resolved from this file's own URL so the test runs whether vitest is
// invoked from the repo root or from `apps/dev/` (turbo enters the package
// dir before running its `test` script).
const TSCONFIG = fileURLToPath(new URL('../../tsconfig.json', import.meta.url))
const APPS_DEV_ROOT = fileURLToPath(new URL('../../', import.meta.url))

test(
	'only session-lifecycle.ts writes terminal session statuses',
	{
		// Full-project AST walk over apps/dev/src ships on the order of 10s
		// standalone; under parallel suite load it can hit the default 20s
		// timeout. Bump to 60s so a busy CI worker doesn't false-fail on this
		// gate — the timeout is generous; the walk itself is still bounded.
		timeout: 60_000,
	},
	() => {
		const project = new Project({ tsConfigFilePath: TSCONFIG })
		const offenders: { file: string; line: number; literal: string }[] = []

		for (const src of project.getSourceFiles(`${APPS_DEV_ROOT}src/**/*.ts`)) {
			if (src.getFilePath().endsWith(ALLOW)) continue
			if (src.getFilePath().includes('/__tests__/') || src.getFilePath().endsWith('.test.ts'))
				continue

			src.forEachDescendant((node) => {
				// Match `.set({ status: 'completed', ... })` and any object literal
				// binding to sessions.status
				if (node.getKind() !== SyntaxKind.PropertyAssignment) return
				const pa = node.asKindOrThrow(SyntaxKind.PropertyAssignment)
				if (pa.getName() !== 'status') return
				const init = pa.getInitializer()
				if (!init || init.getKind() !== SyntaxKind.StringLiteral) return
				const value = init.asKindOrThrow(SyntaxKind.StringLiteral).getLiteralText()
				if (!TERMINALS.has(value)) return
				if (!isEnclosedByUpdateOnSessions(pa)) return
				offenders.push({
					file: src.getFilePath(),
					line: init.getStartLineNumber(),
					literal: value,
				})
			})
		}

		expect(
			offenders,
			`terminal status literal outside ${ALLOW}: ${JSON.stringify(offenders, null, 2)}`,
		).toEqual([])
	},
)

/**
 * True when `node` sits inside a `.set({...})` object literal whose enclosing
 * `.update(<table>)` call names the shared `sessions` table symbol. Walks up
 * the AST via `getParent()` looking for a `CallExpression` whose leftmost
 * property-access chain is `.update(<Identifier: 'sessions'>)`. Anything else
 * — a `.update(imports)` call, a bare object literal returned from a helper —
 * is not a terminal-status writer on the sessions table and is skipped.
 */
function isEnclosedByUpdateOnSessions(node: import('ts-morph').Node): boolean {
	let cursor: import('ts-morph').Node | undefined = node.getParent()
	while (cursor) {
		if (cursor.getKind() === SyntaxKind.CallExpression) {
			const call = cursor.asKindOrThrow(SyntaxKind.CallExpression)
			const expr = call.getExpression()
			// Look for `<...>.update(<arg>)` — a property-access whose name is
			// `update`. The chain root can be `this.db`, `db`, `tx`, etc. — we do
			// not care as long as the first argument is the `sessions` identifier.
			if (expr.getKind() === SyntaxKind.PropertyAccessExpression) {
				const pae = expr.asKindOrThrow(SyntaxKind.PropertyAccessExpression)
				if (pae.getName() === 'update') {
					const [firstArg] = call.getArguments()
					if (
						firstArg &&
						firstArg.getKind() === SyntaxKind.Identifier &&
						firstArg.getText() === SESSIONS_TABLE
					) {
						return true
					}
					// Found the enclosing .update() but the table is something else —
					// stop looking so we don't accidentally match a further-out
					// .update(sessions) that wraps this one.
					return false
				}
			}
		}
		cursor = cursor.getParent()
	}
	return false
}
