/**
 * Static check behind session-serializer-pin.test.ts: finds route code that sends a
 * sessions row, or its config column, to a client without going through serializeSession.
 *
 * It follows variables, not types: a variable bound from a read of the sessions table that
 * returns whole rows, or the config column, is "raw". Passing a raw variable to c.json,
 * JSON.stringify or writeSSE fails the scan unless it is wrapped in serializeSession (or
 * .map(serializeSession)). Reading a plain column off it (session.id, session.status) is fine; .config is not.
 * Limit: a row that reaches a response through a helper function or a differently named
 * variable the scan did not bind is not seen.
 */

export interface RawSessionLeak {
	line: number
	identifier: string
	sink: string
}

// Reads off a raw row that still hand the row, or its config, to the client. Any other
// property (session.id, session.status) is a single column and is allowed.
const ROW_LEAKING_ACCESS = 'config|map|filter|slice|find|flatMap|concat|reverse|sort|at|reduce'

const SINKS = ['c.json(', 'JSON.stringify(', 'writeSSE(']

const STATEMENT_END = /\n[ \t]*(?:const|let|if|return|for|await|throw|try)\b/

function stripComments(source: string): string {
	return source
		.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
		.replace(/(^|\s)\/\/.*$/gm, (_m, lead: string) => lead)
}

/** Text of the call starting at the "(" at openIndex, up to its matching ")". */
function balancedArgs(source: string, openIndex: number): string {
	let depth = 0
	let quote: string | null = null
	for (let i = openIndex; i < source.length; i++) {
		const ch = source[i]
		if (quote) {
			if (ch === '\\') i++
			else if (ch === quote) quote = null
			continue
		}
		if (ch === "'" || ch === '"' || ch === '`') quote = ch
		else if (ch === '(') depth++
		else if (ch === ')' && --depth === 0) return source.slice(openIndex + 1, i)
	}
	return source.slice(openIndex + 1)
}

/** Drops quoted text so a word inside a message is not mistaken for a variable. */
function withoutStrings(code: string): string {
	return code
		.replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g, "''")
		.replace(/`(?:\\.|[^`\\])*`/g, (t) => (t.match(/\$\{[^}]*\}/g) ?? []).join(' '))
}

function lineOf(source: string, index: number): number {
	return source.slice(0, index).split('\n').length
}

interface RawBinding {
	name: string
	/** Where the name is in scope: from the end of its statement to the end of the enclosing block. */
	from: number
	to: number
}

/** End of the block that contains index: the first "}" that closes more than was opened. */
function blockEnd(code: string, index: number): number {
	let depth = 0
	let quote: string | null = null
	for (let i = index; i < code.length; i++) {
		const ch = code[i]
		if (quote) {
			if (ch === '\\') i++
			else if (ch === quote) quote = null
			continue
		}
		if (ch === "'" || ch === '"' || ch === '`') quote = ch
		else if (ch === '{') depth++
		else if (ch === '}' && --depth < 0) return i
	}
	return code.length
}

/** Names bound from a read that returns whole sessions rows or the config column. */
function rawBindings(code: string): RawBinding[] {
	const found: RawBinding[] = []
	const binding = /(?:const|let)\s+(?:\[\s*(\w+)\s*\]|(\w+))\s*=\s*(?:await\s+)?(?=\S)/g
	for (const m of code.matchAll(binding)) {
		const start = m.index + m[0].length
		const rest = code.slice(start)
		const end = rest.search(STATEMENT_END)
		const statement = end === -1 ? rest : rest.slice(0, end)
		const name = m[1] ?? m[2]
		if (!name) continue
		let raw = /loadSessionWithAuth\(/.test(statement)
		// A subquery or alias built from sessions rows (the conversation-fenced list) is the
		// same table for this purpose.
		const sources = ['sessions', ...found.map((b) => b.name)].join('|')
		if (
			!raw &&
			new RegExp(`\\.(?:from|update|insert)\\(\\s*(?:${sources})\\s*\\)`).test(statement)
		) {
			const wholeRows = /\.select\(\s*\)|\.returning\(\s*\)|getTableColumns\(\s*sessions\s*\)/
			const wholeTable = /:\s*sessions\s*[,}]/
			const configColumn = /\bconfig\s*:\s*sessions\.config\b/
			raw = wholeRows.test(statement) || wholeTable.test(statement) || configColumn.test(statement)
		}
		if (raw) {
			const from = start + statement.length
			found.push({ name, from, to: blockEnd(code, from) })
		}
	}
	return found
}

/** Names bound from a read that returns whole sessions rows or the config column. */
export function rawSessionBindings(source: string): string[] {
	return [...new Set(rawBindings(stripComments(source)).map((b) => b.name))]
}

export function findRawSessionLeaks(source: string): RawSessionLeak[] {
	const code = stripComments(source)
	const bindings = rawBindings(code)
	const leaks: RawSessionLeak[] = []

	for (const sink of SINKS) {
		let from = 0
		for (let at = code.indexOf(sink, from); at !== -1; at = code.indexOf(sink, from)) {
			from = at + sink.length
			let args = balancedArgs(code, at + sink.length - 1)
			// Wrapped rows are the allowed path.
			for (let guard = 0; guard < 20 && /serializeSession\(/.test(args); guard++) {
				const open = args.indexOf('serializeSession(') + 'serializeSession'.length
				const inner = balancedArgs(args, open)
				args = args.slice(0, open - 'serializeSession'.length) + args.slice(open + inner.length + 2)
			}
			args = withoutStrings(args)
				.replace(/\.\.\./g, '... ')
				.replace(/[\w.]+\.map\(\s*serializeSession\s*\)/g, '')
			for (const { name, from: scopeFrom, to: scopeTo } of bindings) {
				if (at < scopeFrom || at > scopeTo) continue
				const leaking = `(?:(?!\\s*\\??\\.)|\\s*\\??\\.\\s*(?:${ROW_LEAKING_ACCESS})\\b)`
				if (new RegExp(`(?<![\\w.])${name}\\b${leaking}`).test(args)) {
					leaks.push({ line: lineOf(code, at), identifier: name, sink: sink.slice(0, -1) })
				}
			}
		}
	}
	return leaks.sort((a, b) => a.line - b.line)
}
