/**
 * Reads a migration's SQL and says which rules it trips. It is a small scanner, not a full Postgres
 * parser: it splits statements (respecting comments, quoted strings, quoted identifiers and
 * dollar-quoted bodies) and matches the statement shapes the gate cares about. Anything it cannot
 * read comes back as an `unparseable` finding, never as "fine".
 */

export type SqlFindingKind = 'core_table' | 'always_gated' | 'unparseable'

export interface SqlFinding {
	kind: SqlFindingKind
	/** Short rule name, shown to the person reviewing: a table name or the statement kind. */
	rule: string
	detail: string
}

export interface AnalyzeOptions {
	coreTables: string[]
	/** A rollback script under drizzle/down/. The forward runner never executes it. */
	isDown?: boolean
}

interface Statement {
	/** Comments removed, string contents blanked. What the structural checks read. */
	code: string
	/** Comments removed, strings kept. Catches dynamic SQL built inside a string. */
	full: string
}

class SqlParseError extends Error {}

const STARTERS = new Set([
	'create',
	'alter',
	'insert',
	'update',
	'delete',
	'comment',
	'set',
	'reset',
	'begin',
	'start',
	'commit',
	'end',
	'select',
	'with',
	'values',
	'do',
	'call',
	'drop',
	'truncate',
	'grant',
	'revoke',
	'analyze',
	'lock',
	'refresh',
	'reindex',
])

const DOLLAR_TAG = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/

function splitStatements(sql: string): Statement[] {
	const out: Statement[] = []
	let code = ''
	let full = ''
	let parens = 0
	const dollarStack: string[] = []

	const flush = () => {
		if (parens !== 0) throw new SqlParseError('unbalanced parentheses')
		if (code.trim() !== '') out.push({ code, full })
		code = ''
		full = ''
	}

	let i = 0
	while (i < sql.length) {
		const c = sql[i] as string
		const next = sql[i + 1]

		if (c === '-' && next === '-') {
			const end = sql.indexOf('\n', i)
			i = end === -1 ? sql.length : end
			continue
		}
		if (c === '/' && next === '*') {
			let depth = 1
			i += 2
			while (i < sql.length && depth > 0) {
				if (sql[i] === '/' && sql[i + 1] === '*') {
					depth += 1
					i += 2
				} else if (sql[i] === '*' && sql[i + 1] === '/') {
					depth -= 1
					i += 2
				} else i += 1
			}
			if (depth > 0) throw new SqlParseError('unterminated block comment')
			code += ' '
			full += ' '
			continue
		}
		if (c === "'") {
			const escapes = /[eE]$/.test(code) && !/[\w$]$/.test(code.slice(0, -1))
			let j = i + 1
			let body = ''
			let closed = false
			while (j < sql.length) {
				if (escapes && sql[j] === '\\' && j + 1 < sql.length) {
					body += sql.slice(j, j + 2)
					j += 2
				} else if (sql[j] === "'" && sql[j + 1] === "'") {
					body += "''"
					j += 2
				} else if (sql[j] === "'") {
					closed = true
					j += 1
					break
				} else {
					body += sql[j]
					j += 1
				}
			}
			if (!closed) throw new SqlParseError('unterminated string literal')
			code += "''"
			full += `'${body}'`
			i = j
			continue
		}
		if (c === '"') {
			let j = i + 1
			let closed = false
			while (j < sql.length) {
				if (sql[j] === '"' && sql[j + 1] === '"') j += 2
				else if (sql[j] === '"') {
					closed = true
					j += 1
					break
				} else j += 1
			}
			if (!closed) throw new SqlParseError('unterminated quoted identifier')
			code += sql.slice(i, j)
			full += sql.slice(i, j)
			i = j
			continue
		}
		if (c === '$') {
			const tag = DOLLAR_TAG.exec(sql.slice(i, i + 64))?.[0]
			const prev = code.slice(-1)
			if (tag && !/[\w$]/.test(prev)) {
				if (dollarStack[dollarStack.length - 1] === tag) dollarStack.pop()
				else dollarStack.push(tag)
				code += ' '
				full += ' '
				i += tag.length
				continue
			}
		}
		if (c === ';' && dollarStack.length === 0) {
			flush()
			i += 1
			continue
		}
		if (c === '(') parens += 1
		if (c === ')') parens -= 1
		code += c
		full += c
		i += 1
	}
	if (dollarStack.length > 0) throw new SqlParseError('unterminated dollar-quoted body')
	flush()
	return out
}

function normalize(text: string): string {
	return text.replace(/"/g, '').replace(/\s+/g, ' ').trim().toLowerCase()
}

const ALWAYS_GATED: Array<{ rule: string; re: RegExp; useFull?: boolean }> = [
	{ rule: 'TRUNCATE', re: /\btruncate\b/ },
	{ rule: 'GRANT/REVOKE', re: /\b(grant|revoke)\b/ },
	{
		rule: 'ROLE',
		re: /\b(create|alter|drop)\s+(role|user|group)\b|\bset\s+(local\s+|session\s+)?role\b|\bsession\s+authorization\b|\balter\s+default\s+privileges\b|\bowner\s+to\b|\balter\s+system\b/,
	},
	// Matched on the string-preserving text too, so a migration that builds
	// "ALTER TABLE ... ENABLE ROW LEVEL SECURITY" inside format() is still caught.
	{ rule: 'ROW LEVEL SECURITY', re: /row\s+level\s+security/, useFull: true },
	{ rule: 'POLICY', re: /\b(create|alter|drop)\s+policy\b/, useFull: true },
]

// DROP NOT NULL and DROP DEFAULT loosen a column; they do not remove anything.
const DROP_RE = /\bdrop\s+(?!not\s+null\b|default\b)/

const CODE_BODY_RE =
	/^(create|alter)\s+(or\s+replace\s+)?(function|procedure|trigger|constraint\s+trigger)\b|^(do|call)\b/
const DYNAMIC_SQL_RE = /\bexecute\b(?!\s+(function|procedure)\b)/

function tableRef(table: string): string {
	return `(?<![\\w$.])(?:public\\.)?${table}(?![\\w$])`
}

function mentionsTable(text: string, table: string): boolean {
	return new RegExp(tableRef(table)).test(text)
}

function coreActions(code: string, table: string): string[] {
	const ref = tableRef(table)
	const actions: Array<[string, RegExp]> = [
		['ALTER', new RegExp(`\\balter\\s+table\\s+(?:if\\s+exists\\s+)?(?:only\\s+)?${ref}`)],
		['UPDATE', new RegExp(`\\bupdate\\s+(?:only\\s+)?${ref}`)],
		['DELETE', new RegExp(`\\bdelete\\s+from\\s+(?:only\\s+)?${ref}`)],
		['INSERT', new RegExp(`\\binsert\\s+into\\s+${ref}`)],
		[
			'CREATE INDEX',
			new RegExp(`\\bcreate\\s+(?:unique\\s+)?index\\b[\\s\\S]*?\\bon\\s+(?:only\\s+)?${ref}`),
		],
		['LOCK/REINDEX', new RegExp(`^(?:lock|reindex)\\b[\\s\\S]*${ref}`)],
	]
	return actions.filter(([, re]) => re.test(code)).map(([name]) => name)
}

export function analyzeSql(sql: string, opts: AnalyzeOptions): SqlFinding[] {
	let statements: Statement[]
	try {
		statements = splitStatements(sql)
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err)
		return [
			{
				kind: 'unparseable',
				rule: 'unparseable SQL',
				detail: `could not read the SQL (${reason})`,
			},
		]
	}

	const findings: SqlFinding[] = []
	const seen = new Set<string>()
	const add = (f: SqlFinding) => {
		const key = `${f.kind}|${f.rule}|${f.detail}`
		if (seen.has(key)) return
		seen.add(key)
		findings.push(f)
	}

	for (const stmt of statements) {
		const code = normalize(stmt.code)
		const full = normalize(stmt.full)
		const starter = code.split(/[^a-z]/, 1)[0] ?? ''
		const label = code.length > 60 ? `${code.slice(0, 57)}...` : code

		if (!STARTERS.has(starter)) {
			add({
				kind: 'unparseable',
				rule: 'unparseable SQL',
				detail: `statement not recognised, treated as gated: ${label}`,
			})
			continue
		}

		for (const { rule, re, useFull } of ALWAYS_GATED) {
			if (re.test(useFull ? full : code)) {
				add({ kind: 'always_gated', rule, detail: `${rule} statement: ${label}` })
			}
		}

		if (DROP_RE.test(code)) {
			// A rollback script is how a new table or column gets undone, so dropping non-core objects there
			// is expected. It is judged like any other statement as soon as it names a core table.
			const touchesCore = opts.coreTables.some((t) => mentionsTable(code, t))
			if (!opts.isDown || touchesCore) {
				add({ kind: 'always_gated', rule: 'DROP', detail: `DROP statement: ${label}` })
			}
		}

		const isCodeBody = CODE_BODY_RE.test(code)
		if (isCodeBody && DYNAMIC_SQL_RE.test(full)) {
			add({
				kind: 'always_gated',
				rule: 'dynamic SQL',
				detail: `function, trigger or DO block runs dynamic SQL, so the tables it touches cannot be checked: ${label}`,
			})
		}

		for (const table of opts.coreTables) {
			if (isCodeBody) {
				// Function and trigger bodies: any mention counts. Names inside strings count too, since
				// dynamic SQL hides there.
				if (mentionsTable(full, table)) {
					add({
						kind: 'core_table',
						rule: table,
						detail: `function, trigger or DO block touches core table ${table}: ${label}`,
					})
				}
				continue
			}
			for (const action of coreActions(code, table)) {
				add({
					kind: 'core_table',
					rule: table,
					detail: `${action} on core table ${table}: ${label}`,
				})
			}
		}
	}
	return findings
}
