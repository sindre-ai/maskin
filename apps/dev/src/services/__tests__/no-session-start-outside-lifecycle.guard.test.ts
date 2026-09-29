/**
 * Guard test — no session-start writer outside session-lifecycle.ts.
 *
 * Pins the invariant introduced by Bet 12cedabc §14 / §20: the only apps/dev
 * module allowed to invoke a session-start primitive is
 * apps/dev/src/services/session-lifecycle.ts. Every wrapper that used to call
 * sessionManager.createSession() migrated to startSession() at Commit 5;
 * this test fails the CI build the moment a new wrapper re-introduces the
 * direct path.
 *
 * Symbol scope (spec §20):
 *   - sessionManager.createSession / .startSession — the wrapper offenders.
 *   - SessionDispatchQueue.enqueue — internal dispatch primitive.
 *   - SessionDispatcher.dispatch / .markDispatched — internal primitives.
 *   - AgentServerClient.startSession — remote start RPC.
 *   - ContainerManager.create + .start pair — local Docker launch primitives.
 *
 * Allow-list:
 *   - services/session-lifecycle.ts — canonical writer.
 *   - services/session-manager.ts, services/session-dispatch-queue.ts,
 *     services/session-dispatcher.ts — legacy internal owners of the primitives
 *     above. This first pass moves the wrapper surface into
 *     session-lifecycle.ts and leaves the underlying machinery in place; a
 *     follow-on commit (§14.3) collapses these three files into
 *     session-lifecycle.ts's _driveToRunning, at which point this allow-list
 *     shrinks to the canonical file alone.
 *   - __tests__ trees — test doubles may need to reference the symbols for
 *     mocking.
 *   - services/session-cleanup.ts — instantiates AgentServerClient for the
 *     stop path, not the start path; the guard here targets .startSession only.
 *
 * Comment/string-literal handling: the check strips // line comments and
 * / * ... * / block comments before matching so a docstring naming a banned
 * symbol does not trip the guard. Grep-based rather than ts-morph AST to keep
 * the guard cheap (no additional workspace dependency); a symbol-resolving
 * ts-morph pass lands with the fuller §20 wire-up in the reaper redesign
 * (§16).
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const APPS_DEV_SRC = join(HERE, '..', '..')

const CANONICAL_WRITER = join('services', 'session-lifecycle.ts')

const LEGACY_INTERNAL_OWNERS = new Set(
	[
		join('services', 'session-manager.ts'),
		join('services', 'session-dispatch-queue.ts'),
		join('services', 'session-dispatcher.ts'),
	].map((p) => p.split('/').join(sep)),
)

const AGENT_SERVER_CLIENT_STOP_PATH_OWNER = join('services', 'session-cleanup.ts')
	.split('/')
	.join(sep)

interface BannedRule {
	label: string
	pattern: RegExp
	skipFiles?: (relPath: string) => boolean
}

const BANNED: BannedRule[] = [
	{
		label: 'sessionManager.createSession(...)',
		pattern: /\bsessionManager\.createSession\s*\(/,
	},
	{
		label: 'sessionManager.startSession(...)',
		pattern: /\bsessionManager\.startSession\s*\(/,
	},
	{
		label: 'SessionDispatchQueue.enqueue(...)',
		pattern: /\.enqueue\s*\(/,
		// The bare `.enqueue(` pattern is generic; only enforce it against
		// files that also import SessionDispatchQueue, checked inline below.
	},
	{
		label: 'SessionDispatcher.dispatch(...) or .markDispatched(...)',
		pattern: /\.(dispatch|markDispatched)\s*\(/,
	},
	{
		label: 'AgentServerClient.startSession(...)',
		pattern: /\.startSession\s*\(/,
		// Only enforce on files that touch AgentServerClient — the wrapper-side
		// guard for `sessionManager.startSession` is a separate rule above.
	},
	{
		label: 'ContainerManager.create+start pair',
		pattern: /\.containers?\s*\.\s*(create|start)\s*\(/,
	},
]

const ALLOWLIST_DIRS = new Set(['__tests__'])

/**
 * Skip the packages/mcp tree entirely (spec §20 exemption) by staying inside
 * apps/dev/src/. Skip apps/dev/src/__tests__/ because the guard tests
 * themselves reference the banned symbols as string literals.
 */
function walkTs(root: string, acc: string[] = []): string[] {
	for (const entry of readdirSync(root)) {
		if (ALLOWLIST_DIRS.has(entry)) continue
		const full = join(root, entry)
		const stat = statSync(full)
		if (stat.isDirectory()) {
			walkTs(full, acc)
		} else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
			acc.push(full)
		}
	}
	return acc
}

function stripComments(source: string): string {
	// Remove block comments first, then single-line comments. Sloppy enough
	// that it treats // inside string literals as a comment start; the guard
	// only cares about member-access patterns, and no banned symbol is a
	// standalone URL segment.
	return source
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.split('\n')
		.map((line) => line.replace(/\/\/.*$/, ''))
		.join('\n')
}

function fileMentionsIdentifier(source: string, id: string): boolean {
	return new RegExp(`\\b${id}\\b`).test(source)
}

describe('start-side lifecycle guard', () => {
	const files = walkTs(APPS_DEV_SRC)

	for (const abs of files) {
		const rel = relative(APPS_DEV_SRC, abs)
		if (rel === CANONICAL_WRITER) continue

		const isLegacyInternalOwner = LEGACY_INTERNAL_OWNERS.has(rel)
		const isAgentServerStopOwner = rel === AGENT_SERVER_CLIENT_STOP_PATH_OWNER

		it(`no banned session-start primitive in ${rel}`, () => {
			const raw = readFileSync(abs, 'utf8')
			const stripped = stripComments(raw)

			const hits: string[] = []
			for (const rule of BANNED) {
				// Legacy internal owners keep their machinery until the §14.3
				// collapse commit lands.
				if (isLegacyInternalOwner) continue

				// SessionDispatchQueue.enqueue: only fires on files that
				// actually reference SessionDispatchQueue.
				if (rule.label.startsWith('SessionDispatchQueue')) {
					if (!fileMentionsIdentifier(raw, 'SessionDispatchQueue')) continue
				}
				// AgentServerClient.startSession: only enforce when the file
				// references AgentServerClient. session-cleanup.ts uses the
				// stop RPC (not startSession), so a false hit for it is filtered
				// below by shape.
				if (rule.label.startsWith('AgentServerClient')) {
					if (!fileMentionsIdentifier(raw, 'AgentServerClient')) continue
					if (isAgentServerStopOwner) continue
				}
				// ContainerManager.create+start pair: only fires on files that
				// reference ContainerManager.
				if (rule.label.startsWith('ContainerManager')) {
					if (!fileMentionsIdentifier(raw, 'ContainerManager')) continue
				}
				// SessionDispatcher.dispatch or .markDispatched: only fires on
				// files that reference SessionDispatcher explicitly.
				if (rule.label.startsWith('SessionDispatcher')) {
					if (!fileMentionsIdentifier(raw, 'SessionDispatcher')) continue
				}
				if (rule.pattern.test(stripped)) hits.push(rule.label)
			}

			const message = [
				`${rel} contains banned session-start primitive(s): ${hits.join(', ')}.`,
				'Route this through apps/dev/src/services/session-lifecycle.ts / startSession() instead.',
				'See spec §14 / §20 (settle-session-tech-spec.md).',
			].join(' ')
			expect(hits, message).toEqual([])
		})
	}

	it('the canonical writer exists at services/session-lifecycle.ts', () => {
		const found = files.some((abs) => relative(APPS_DEV_SRC, abs) === CANONICAL_WRITER)
		expect(found).toBe(true)
	})
})
