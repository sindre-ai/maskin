import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Sebk 2026-09-07 locked: "No undo on send round. Send is final; no server-side
// cancel path, no client-side undo window, no toast undo affordance." This test
// pins that decision to the tree by asserting the send-flow files carry ZERO
// occurrences of `undo` / `cancel-round` / `cancelRound`. Anyone adding an
// affordance later has to explain why the spec changed and update this test
// deliberately — a slip of the reviewer's eye can't sneak it back in.
//
// Files considered "send-flow" are the ones that name the round-send action:
//   - use-file-comments.ts        (the hook that POSTs the round)
//   - review-panel.tsx            (the Send button + post-send lock)
//   - file-comments-context.tsx   (the client draft store + roundId lifecycle)
//   - $fileId.tsx                 (the route wiring)
// The list is deliberately narrow so this doesn't fail on unrelated words like
// "unresolve" or "cancel" elsewhere in the app.

const SEND_FLOW_FILES = [
	'apps/web/src/hooks/use-file-comments.ts',
	'apps/web/src/components/files/review-panel.tsx',
	'apps/web/src/lib/file-comments-context.tsx',
	'apps/web/src/routes/_authed/$workspaceId/files/$fileId.tsx',
]

// Forbidden tokens per spec §No-gos. Matched as substrings (case-insensitive).
const FORBIDDEN = ['undo', 'cancel-round', 'cancelRound', 'cancel_round']

function repoRoot(): string {
	// vitest runs from `apps/web`; the repo root is two levels up.
	return join(process.cwd(), '..', '..')
}

describe('Send-flow forbidden-tokens grep (Sebk 2026-09-07: send is final)', () => {
	for (const rel of SEND_FLOW_FILES) {
		it(`${rel} contains no undo / cancel-round tokens`, () => {
			const source = readFileSync(join(repoRoot(), rel), 'utf8')
			const lower = source.toLowerCase()
			for (const token of FORBIDDEN) {
				expect(
					lower.includes(token.toLowerCase()),
					`${rel} contains forbidden token "${token}"`,
				).toBe(false)
			}
		})
	}
})
