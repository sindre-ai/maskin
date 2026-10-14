/**
 * Guard test — pins session-lifecycle.ts as the only module in apps/dev/src/**
 * allowed to call the session-start dispatch primitives.
 *
 * Bans (spec §14.6 + §20):
 *   - sessionManager.createSession(...)
 *   - sessionManager.startSession(...)          // the wrapper form
 *   - dispatchQueue.enqueue(...)                // SessionDispatchQueue
 *   - dispatcher.dispatch(...), .markDispatched(...)
 *   - agentServerClient.startSession(...)       // AgentServerClient
 *
 * Allowlist (files that DEFINE or OWN the primitives):
 *   - services/session-lifecycle.ts        (the entry point + exempt spec file)
 *   - services/session-manager.ts          (holds createSession + drive-to-running impl)
 *   - services/session-dispatch-queue.ts   (defines enqueue)
 *   - services/session-dispatcher.ts       (defines dispatch/markDispatched)
 *   - services/agent-server-client.ts      (defines AgentServerClient methods)
 *   - services/container-manager.ts        (defines create/start)
 *   - packages/mcp/**                      (HTTP consumer, not part of this scan)
 *
 * On task start (Commit 5, before this task's own migration), this test would
 * fail with 11 offenders — the wrappers listed in tech spec §19. At the end of
 * this task the count is zero.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, join, relative, sep } from 'node:path'

import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const APPS_DEV_SRC_DIR = join(__dirname, '..', '..')
const SERVICES_DIR = join(APPS_DEV_SRC_DIR, 'services')

const ALLOWLISTED_FILES = new Set(
	[
		join(SERVICES_DIR, 'session-lifecycle.ts'),
		join(SERVICES_DIR, 'session-manager.ts'),
		join(SERVICES_DIR, 'session-dispatch-queue.ts'),
		join(SERVICES_DIR, 'session-dispatcher.ts'),
		join(SERVICES_DIR, 'agent-server-client.ts'),
		join(SERVICES_DIR, 'container-manager.ts'),
	].map((p) => p.replace(/\\/g, '/')),
)

interface BanRule {
	method: string
	receiverNames: readonly string[]
	label: string
}

const BAN_RULES: readonly BanRule[] = [
	{
		method: 'createSession',
		receiverNames: ['sessionManager'],
		label: 'sessionManager.createSession',
	},
	{
		method: 'startSession',
		receiverNames: ['sessionManager'],
		label: 'sessionManager.startSession',
	},
	{
		method: 'enqueue',
		receiverNames: ['dispatchQueue', 'sessionDispatchQueue', 'queue'],
		label: 'SessionDispatchQueue.enqueue',
	},
	{
		method: 'dispatch',
		receiverNames: ['dispatcher', 'sessionDispatcher'],
		label: 'SessionDispatcher.dispatch',
	},
	{
		method: 'markDispatched',
		receiverNames: ['dispatcher', 'sessionDispatcher'],
		label: 'SessionDispatcher.markDispatched',
	},
	{
		method: 'startSession',
		receiverNames: ['agentServerClient', 'client'],
		label: 'AgentServerClient.startSession',
	},
]

interface Offender {
	file: string
	line: number
	label: string
	snippet: string
}

function listTypeScriptFiles(root: string): string[] {
	const out: string[] = []
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir)) {
			if (entry === 'node_modules' || entry === 'dist' || entry === '.turbo') continue
			const full = join(dir, entry)
			const st = statSync(full)
			if (st.isDirectory()) {
				walk(full)
				continue
			}
			if (!full.endsWith('.ts') || full.endsWith('.d.ts')) continue
			// Test files are exempt — they intentionally exercise the primitives.
			if (full.includes(`${sep}__tests__${sep}`)) continue
			if (basename(full).endsWith('.test.ts')) continue
			out.push(full)
		}
	}
	walk(root)
	return out
}

function isReceiverBanned(
	node: ts.PropertyAccessExpression,
	receiverNames: readonly string[],
): boolean {
	// Match  X.method  where X (or the tail of a longer chain) is an identifier
	// whose text matches one of receiverNames. E.g. sessionManager.createSession
	// AND this.sessionManager.createSession both trip a receiver named
	// 'sessionManager'. Chains rooted at `this` alone (this.createSession)
	// don't match — that's the internal impl on the defining class itself,
	// which the allowlist already covers.
	const receiver = node.expression
	if (ts.isIdentifier(receiver)) {
		return receiverNames.includes(receiver.text)
	}
	if (ts.isPropertyAccessExpression(receiver)) {
		return receiverNames.includes(receiver.name.text)
	}
	return false
}

function scanFileForOffenders(filePath: string): Offender[] {
	const source = readFileSync(filePath, 'utf-8')
	const sf = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true)
	const offenders: Offender[] = []
	const visit = (node: ts.Node): void => {
		if (ts.isCallExpression(node)) {
			const target = node.expression
			if (ts.isPropertyAccessExpression(target)) {
				for (const rule of BAN_RULES) {
					if (target.name.text !== rule.method) continue
					if (!isReceiverBanned(target, rule.receiverNames)) continue
					const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf))
					offenders.push({
						file: filePath,
						line: line + 1,
						label: rule.label,
						snippet: node.getText(sf).split('\n')[0].slice(0, 160),
					})
				}
			}
		}
		ts.forEachChild(node, visit)
	}
	visit(sf)
	return offenders
}

describe('no session start outside session-lifecycle.ts', () => {
	it('every start-side wrapper routes through startSession()', () => {
		const files = listTypeScriptFiles(APPS_DEV_SRC_DIR)
		const offenders: Offender[] = []
		for (const file of files) {
			const normalized = file.replace(/\\/g, '/')
			if (ALLOWLISTED_FILES.has(normalized)) continue
			offenders.push(...scanFileForOffenders(file))
		}

		if (offenders.length > 0) {
			const relRoot = join(APPS_DEV_SRC_DIR, '..', '..')
			const rendered = offenders
				.map((o) => `  - ${relative(relRoot, o.file)}:${o.line}  [${o.label}]  ${o.snippet}`)
				.join('\n')
			throw new Error(
				`Session-start primitive called from ${offenders.length} site(s) outside session-lifecycle.ts. ` +
					`Every wrapper must route through startSession(). Offenders:\n${rendered}`,
			)
		}

		expect(offenders).toEqual([])
	})
})
