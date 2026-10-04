/**
 * Guard test: every read of a linkedin-unipile or google-meet credential goes
 * through getCredential, so it is scope-checked and audited.
 *
 * Pins four things in apps/dev/src (test files excluded):
 *   1. The no-ctx form of getIntegrationCredential has zero callers. A call is
 *      the no-ctx form unless its options argument is an object literal with a
 *      ctx property. (The overload stays, marked deprecated, for the lookup
 *      semantics tests; nothing in shipped code may use it.)
 *   2. findIntegrationRow (the row resolver that reads no value) is called only
 *      from lookup.ts and the LinkedIn preamble, which follows it with getCredential.
 *   3. The two provider directories do not decrypt a stored credential
 *      themselves.
 *   4. A file in those directories that asks TokenManager for a token also
 *      gates and audits the read first through getIntegrationCredential or
 *      getCredential. This is what keeps resolveHostToken and
 *      getGoogleMeetAccessToken honest, since TokenManager decrypts on its own.
 *
 * Accepted gaps, named in the task and the PR body, not hidden: the files in
 * the allowlists below still read a credential outside the audit log. Shrink
 * the lists as they are fixed; never add to them without the Architect.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const SRC = join(__dirname, '..', '..', '..')
const LINKEDIN_DIR = join(SRC, 'lib', 'integrations', 'providers', 'linkedin-unipile')
const MEET_DIR = join(SRC, 'lib', 'integrations', 'providers', 'google-meet')

const rel = (p: string) => relative(SRC, p).split(sep).join('/')

/** Only these may resolve a row without reading its value. */
const FIND_ROW_ALLOWLIST = new Set([
	'lib/integrations/lookup.ts',
	'lib/integrations/providers/linkedin-unipile/operations.ts',
])

/** Accepted gap: LinkedIn webhook (account.reconnect) decrypts account_id; it is a system caller with no actor. */
const DECRYPT_ALLOWLIST = new Set(['lib/integrations/providers/linkedin-unipile/webhook.ts'])

/** Accepted gap: Meet renewer, Pub/Sub fan-out and reconciler read the OAuth token through TokenManager with no actor. */
const TOKEN_MANAGER_ALLOWLIST = new Set(['lib/integrations/providers/google-meet/watch.ts'])

function walk(dir: string, out: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		if (name === 'node_modules' || name === '__tests__' || name === '__mocks__') continue
		const full = join(dir, name)
		if (statSync(full).isDirectory()) walk(full, out)
		else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full)
	}
	return out
}

function parse(text: string): ts.SourceFile {
	return ts.createSourceFile('x.ts', text, ts.ScriptTarget.Latest, true)
}

function calls(sf: ts.SourceFile): Array<{ name: string; node: ts.CallExpression }> {
	const found: Array<{ name: string; node: ts.CallExpression }> = []
	const visit = (node: ts.Node) => {
		if (ts.isCallExpression(node)) {
			const callee = node.expression
			const name = ts.isIdentifier(callee)
				? callee.text
				: ts.isPropertyAccessExpression(callee)
					? callee.name.text
					: null
			if (name) found.push({ name, node })
		}
		ts.forEachChild(node, visit)
	}
	visit(sf)
	return found
}

/** getIntegrationCredential calls whose options argument is not an object literal carrying ctx. */
function findNoCtxCalls(text: string): number[] {
	const sf = parse(text)
	return calls(sf)
		.filter(({ name }) => name === 'getIntegrationCredential')
		.filter(({ node }) => {
			const options = node.arguments[4]
			if (!options || !ts.isObjectLiteralExpression(options)) return true
			return !options.properties.some(
				(p) =>
					(ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
					ts.isIdentifier(p.name) &&
					p.name.text === 'ctx',
			)
		})
		.map(({ node }) => sf.getLineAndCharacterOfPosition(node.getStart()).line + 1)
}

const sourceFiles = walk(SRC)
const textOf = (file: string) => readFileSync(file, 'utf-8')

describe('credential reader guard', () => {
	it('the scanner flags the no-ctx form and accepts the ctx form', () => {
		const noCtx = "await getIntegrationCredential(db, ws, 'p', null)"
		const emptyOptions =
			"await getIntegrationCredential(db, ws, 'p', null, { fallbackToAnyActor: true })"
		const viaVariable = "await getIntegrationCredential(db, ws, 'p', null, options)"
		const withCtx =
			"await getIntegrationCredential(db, ws, 'p', null, { fallbackToAnyActor: true, ctx })"
		const shorthand =
			"await getIntegrationCredential(db, ws, 'p', null, { ctx: readContextFor(a) })"
		expect(findNoCtxCalls(noCtx)).toHaveLength(1)
		expect(findNoCtxCalls(emptyOptions)).toHaveLength(1)
		expect(findNoCtxCalls(viaVariable)).toHaveLength(1)
		expect(findNoCtxCalls(withCtx)).toHaveLength(0)
		expect(findNoCtxCalls(shorthand)).toHaveLength(0)
	})

	it('the no-ctx form of getIntegrationCredential has zero callers', () => {
		const offenders = sourceFiles.flatMap((file) =>
			findNoCtxCalls(textOf(file)).map((line) => `${rel(file)}:${line}`),
		)
		expect(offenders).toEqual([])
	})

	it('findIntegrationRow is called only from lookup.ts and the LinkedIn preamble', () => {
		const offenders = sourceFiles
			.filter((file) => !FIND_ROW_ALLOWLIST.has(rel(file)))
			.filter((file) =>
				calls(parse(textOf(file))).some(({ name }) => name === 'findIntegrationRow'),
			)
			.map(rel)
		expect(offenders).toEqual([])
	})

	it('the linkedin-unipile and google-meet directories do not decrypt a credential themselves', () => {
		const offenders = [...walk(LINKEDIN_DIR), ...walk(MEET_DIR)]
			.filter((file) => !DECRYPT_ALLOWLIST.has(rel(file)))
			.filter((file) =>
				calls(parse(textOf(file))).some(
					({ name }) => name === 'decrypt' || name === 'decryptStoredCredential',
				),
			)
			.map(rel)
		expect(offenders).toEqual([])
	})

	it('a file that asks TokenManager for a token gates and audits the read first', () => {
		const offenders = [...walk(LINKEDIN_DIR), ...walk(MEET_DIR)]
			.filter((file) => !TOKEN_MANAGER_ALLOWLIST.has(rel(file)))
			.filter((file) => {
				const names = new Set(calls(parse(textOf(file))).map(({ name }) => name))
				const readsToken = names.has('getValidToken')
				const gated = names.has('getIntegrationCredential') || names.has('getCredential')
				return readsToken && !gated
			})
			.map(rel)
		expect(offenders).toEqual([])
	})

	it('the allowlists name files that still exist, so a rename cannot silently widen them', () => {
		const existing = new Set(sourceFiles.map(rel))
		for (const file of [...FIND_ROW_ALLOWLIST, ...DECRYPT_ALLOWLIST, ...TOKEN_MANAGER_ALLOWLIST]) {
			expect(existing.has(file), file).toBe(true)
		}
	})
})
