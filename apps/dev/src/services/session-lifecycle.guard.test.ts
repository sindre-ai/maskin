// The guard test that keeps `settleSession()` the only writer of a terminal
// `sessions.status`. Adapted from settle-session-tech-spec §4.2.
//
// It looks at every `.update(sessions).set(<arg>)` call outside
// session-lifecycle.ts and fails on any `status` it cannot prove is a
// non-terminal string literal: a terminal literal, a shorthand `status,`, a
// computed value (`status: finalStatus`), or a `set()` argument it cannot read.
// An earlier version walked UP from a `status: '<terminal>'` property looking
// for an enclosing `.update(sessions)` call, but in a drizzle chain
// (`db.update(sessions).set({...})`) the update call is the receiver of `set()`,
// not an ancestor of its argument, so that walk never matched and the guard
// passed without ever flagging anything. The detector is also exercised on
// synthetic sources below so that cannot happen silently again.

import { fileURLToPath } from 'node:url'
import { Node, Project, SyntaxKind } from 'ts-morph'
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

interface Offender {
	file: string
	line: number
	why: string
}

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
		const offenders: Offender[] = []

		for (const src of project.getSourceFiles(`${APPS_DEV_ROOT}src/**/*.ts`)) {
			if (src.getFilePath().endsWith(ALLOW)) continue
			if (src.getFilePath().includes('/__tests__/') || src.getFilePath().endsWith('.test.ts'))
				continue
			offenders.push(...findSessionStatusWriters(src))
		}

		expect(
			offenders,
			`status written to the sessions table outside ${ALLOW}: ${JSON.stringify(offenders, null, 2)}`,
		).toEqual([])
	},
)

test('the detector flags every way of writing a status it cannot prove non-terminal', () => {
	const flagged = (body: string) => findSessionStatusWriters(sourceOf(body)).length

	// Terminal literal.
	expect(flagged(`await db.update(sessions).set({ status: 'failed' }).where(w)`)).toBe(1)
	// Shorthand property: the shape the old writers in session-manager.ts used.
	expect(flagged('await db.update(sessions).set({ status, result }).where(w)')).toBe(1)
	// Computed from a variable.
	expect(flagged('await db.update(sessions).set({ status: finalStatus }).where(w)')).toBe(1)
	// Conditional between two literals: one branch is terminal.
	expect(
		flagged(`await db.update(sessions).set({ status: ok ? 'completed' : 'running' }).where(w)`),
	).toBe(1)
	// Inside a transaction handle, and behind a spread.
	expect(flagged('await tx.update(sessions).set({ ...(c ? { status } : {}) }).where(w)')).toBe(1)
	// A set() argument held in a variable that carries a status.
	expect(
		flagged('const patch = { status: next }\nawait db.update(sessions).set(patch).where(w)'),
	).toBe(1)
	// A set() argument the guard cannot read at all.
	expect(flagged('await db.update(sessions).set(buildPatch()).where(w)')).toBe(1)
})

test('the detector leaves non-terminal and unrelated writes alone', () => {
	const flagged = (body: string) => findSessionStatusWriters(sourceOf(body)).length

	expect(flagged(`await db.update(sessions).set({ status: 'running' }).where(w)`)).toBe(0)
	expect(flagged('await db.update(sessions).set({ currentActivity: null }).where(w)')).toBe(0)
	// A status nested inside another column's JSON value is not the status column.
	expect(flagged(`await db.update(sessions).set({ result: { status: 'failed' } }).where(w)`)).toBe(
		0,
	)
	// A different table with its own `status` column.
	expect(flagged(`await db.update(imports).set({ status: 'completed' }).where(w)`)).toBe(0)
	// A set() argument held in a variable with no status.
	expect(
		flagged('const patch = {}\npatch.config = c\nawait db.update(sessions).set(patch).where(w)'),
	).toBe(0)
})

function sourceOf(body: string): import('ts-morph').SourceFile {
	return new Project({ useInMemoryFileSystem: true }).createSourceFile('guard-sample.ts', body)
}

/**
 * Every `.update(sessions).set(<arg>)` in `src` whose argument may write a
 * terminal (or unprovable) `status`.
 */
function findSessionStatusWriters(src: import('ts-morph').SourceFile): Offender[] {
	const offenders: Offender[] = []
	for (const call of src.getDescendantsOfKind(SyntaxKind.CallExpression)) {
		if (!isSetOnSessionsUpdate(call)) continue
		const [arg] = call.getArguments()
		for (const why of statusProblems(arg, src, new Set())) {
			offenders.push({ file: src.getFilePath(), line: call.getStartLineNumber(), why })
		}
	}
	return offenders
}

/**
 * True for `<anything>.update(sessions).set(...)`. In a drizzle chain the
 * `update(sessions)` call is the receiver of `set`, so it is found by looking
 * down from the `set` call, not up from its argument.
 */
function isSetOnSessionsUpdate(call: import('ts-morph').CallExpression): boolean {
	const callee = call.getExpression()
	if (!Node.isPropertyAccessExpression(callee) || callee.getName() !== 'set') return false
	const receiver = callee.getExpression()
	if (!Node.isCallExpression(receiver)) return false
	const updateCallee = receiver.getExpression()
	if (!Node.isPropertyAccessExpression(updateCallee) || updateCallee.getName() !== 'update') {
		return false
	}
	const [table] = receiver.getArguments()
	return (
		table !== undefined &&
		(table.getText() === SESSIONS_TABLE || table.getText().endsWith(`.${SESSIONS_TABLE}`))
	)
}

/**
 * Reasons `node`, read as the argument of a `set()`, may write a terminal or
 * unprovable `status`. Follows spreads, conditionals and same-file variables,
 * but does not descend into another column's value (`result: { status }` is
 * JSON, not the status column).
 */
function statusProblems(
	node: import('ts-morph').Node | undefined,
	src: import('ts-morph').SourceFile,
	seen: Set<string>,
): string[] {
	if (!node) return []
	if (Node.isObjectLiteralExpression(node)) {
		return node.getProperties().flatMap((prop) => {
			if (Node.isSpreadAssignment(prop)) return statusProblems(prop.getExpression(), src, seen)
			if (Node.isShorthandPropertyAssignment(prop) && prop.getName() === 'status') {
				return ['shorthand status']
			}
			if (Node.isPropertyAssignment(prop) && prop.getName() === 'status') {
				return literalProblems(prop.getInitializer())
			}
			return []
		})
	}
	if (Node.isConditionalExpression(node)) {
		return [
			...statusProblems(node.getWhenTrue(), src, seen),
			...statusProblems(node.getWhenFalse(), src, seen),
		]
	}
	if (Node.isBinaryExpression(node)) {
		return [
			...statusProblems(node.getLeft(), src, seen),
			...statusProblems(node.getRight(), src, seen),
		]
	}
	if (
		Node.isParenthesizedExpression(node) ||
		Node.isAsExpression(node) ||
		Node.isSatisfiesExpression(node) ||
		Node.isNonNullExpression(node)
	) {
		return statusProblems(node.getExpression(), src, seen)
	}
	if (Node.isIdentifier(node)) {
		const name = node.getText()
		if (name === 'undefined') return []
		if (seen.has(name)) return []
		seen.add(name)
		const declarations = src
			.getDescendantsOfKind(SyntaxKind.VariableDeclaration)
			.filter((d) => d.getName() === name)
		if (declarations.length === 0) return [`set() argument ${name} is not declared in this file`]
		return declarations.flatMap((d) => statusProblems(d.getInitializer(), src, seen))
	}
	if (
		node.getKind() === SyntaxKind.NullKeyword ||
		node.getKind() === SyntaxKind.TrueKeyword ||
		node.getKind() === SyntaxKind.FalseKeyword
	) {
		return []
	}
	return [`set() argument is a ${node.getKindName()} the guard cannot read`]
}

/** A `status` value is fine only if it is a string literal outside the terminal set. */
function literalProblems(init: import('ts-morph').Node | undefined): string[] {
	if (!init) return ['status has no value']
	if (Node.isConditionalExpression(init)) {
		return [...literalProblems(init.getWhenTrue()), ...literalProblems(init.getWhenFalse())]
	}
	if (Node.isStringLiteral(init) || Node.isNoSubstitutionTemplateLiteral(init)) {
		const value = init.getLiteralText()
		return TERMINALS.has(value) ? [`terminal status '${value}'`] : []
	}
	return [`computed status (${init.getKindName()})`]
}
