// The guard test that keeps `settleSession()` the only writer of a terminal
// `sessions.status`. Verbatim from settle-session-tech-spec §4.2.
//
// At commit 1 this test is expected to FAIL with 13 red offenders, distributed
// as (10, 2, 1) across session-manager.ts, session-dispatch-queue.ts, and
// session-reconciler.ts (per CTO verdict-2's grounded count). Commit 2
// migrates every call site through `settleSession()` and drives it green.

import { fileURLToPath } from 'node:url'
import { Project, SyntaxKind } from 'ts-morph'
import { expect, test } from 'vitest'

const TERMINALS = new Set(['completed', 'failed', 'timeout', 'user_stopped', 'paused'])
const ALLOW = 'src/services/session-lifecycle.ts'

// Resolved from this file's own URL so the test runs whether vitest is
// invoked from the repo root or from `apps/dev/` (turbo enters the package
// dir before running its `test` script).
const TSCONFIG = fileURLToPath(new URL('../../tsconfig.json', import.meta.url))
const APPS_DEV_ROOT = fileURLToPath(new URL('../../', import.meta.url))

test('only session-lifecycle.ts writes terminal session statuses', () => {
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
})
