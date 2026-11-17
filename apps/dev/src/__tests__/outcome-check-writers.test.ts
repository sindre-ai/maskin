import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The route list for the outcome check, kept true. An agent's close of a job with an approved
 * done-when list must go through one decision function (requiresOutcomeCheck in
 * lib/outcome-check.ts). This lists every place the server code writes an object row in a way that
 * could change its status, and fails when a new one appears that is not on the list below. A new
 * writer has to be added here, either behind the decision function or with the reason it is not an
 * agent route.
 *
 * A writer is a `.update(objects).set(...)` whose set clause names status, spreads another object
 * or is not an object literal (so it could carry a status). Writes that only set other columns in
 * a literal, like metadata or driver, are not listed.
 */

const devSrc = new URL('..', import.meta.url).pathname

type Writer =
	| { via: 'decision-function'; note: string }
	| { via: 'not-an-agent-route'; note: string }

/** Key: file under apps/dev/src, then the set clause with whitespace collapsed. */
const WRITERS: Record<string, Writer> = {
	'lib/object-update.ts :: updateData': {
		via: 'decision-function',
		note: 'The shared write behind PATCH /objects/{id}, update_objects, update_loop and the card status tap. Refuses an agent close with no passed round.',
	},
	'routes/objects.ts :: plan.updateData': {
		via: 'decision-function',
		note: 'Bulk update. An agent request for a gated close is refused before it is planned.',
	},
	"lib/send-closure.ts :: { status: 'done', updatedAt: new Date() }": {
		via: 'decision-function',
		note: 'After a person-approved send. An agent send of a gated job leaves it open and stores a pending round.',
	},
	'routes/objects.ts :: { type: toType, status: newStatus, updatedAt: now }': {
		via: 'not-an-agent-route',
		note: 'Migrate type. Human workspace admins and owners only.',
	},
	'routes/objects.ts :: updateSet': {
		via: 'not-an-agent-route',
		note: 'Undo of a write. Human workspace admins and owners only.',
	},
	'lib/integrations/providers/slack/interactive.ts :: { status: selectedValue, updatedAt: new Date() }':
		{
			via: 'not-an-agent-route',
			note: 'A person pressing the status button in Slack.',
		},
	"lib/next-steps.ts :: { status: 'todo', updatedAt: now }": {
		via: 'not-an-agent-route',
		note: 'Moves a task to todo, which is not a closed status. Not a close.',
	},
	"lib/integrations/providers/skjald/meeting-sync.ts :: { title, content, status: 'done', metadata: metadata(existingMetadata), updatedAt: new Date(), }":
		{
			via: 'not-an-agent-route',
			note: 'Server sync of a meeting from Skjald. Not an agent call and not a task or bet.',
		},
	'services/import-processor.ts :: { ...next, updatedAt: new Date() }': {
		via: 'not-an-agent-route',
		note: 'A person-run import.',
	},
}

function sourceFiles(dir: string): string[] {
	const out: string[] = []
	for (const name of readdirSync(dir)) {
		const path = join(dir, name)
		if (name === '__tests__' || name === 'node_modules') continue
		if (statSync(path).isDirectory()) out.push(...sourceFiles(path))
		else if (/\.tsx?$/.test(path)) out.push(path)
	}
	return out
}

/** The text between the brackets that open at `open`, which must point at a "(". */
function balanced(source: string, open: number): string {
	let depth = 0
	for (let i = open; i < source.length; i++) {
		if (source[i] === '(') depth++
		else if (source[i] === ')' && --depth === 0) return source.slice(open + 1, i)
	}
	return source.slice(open + 1)
}

/** Every `.update(objects).set(...)` whose set clause could carry a status, as "file :: clause". */
function statusCapableWriters(): string[] {
	const found: string[] = []
	for (const file of sourceFiles(devSrc)) {
		const source = readFileSync(file, 'utf8')
		const call = /\.update\(\s*objects\s*\)\s*\.set\(/g
		for (let m = call.exec(source); m; m = call.exec(source)) {
			const clause = balanced(source, m.index + m[0].length - 1)
				.replace(/\s+/g, ' ')
				.trim()
			const couldCarryStatus =
				/\bstatus\b/.test(clause) || clause.includes('...') || !clause.startsWith('{')
			if (couldCarryStatus) found.push(`${relative(devSrc, file)} :: ${clause}`)
		}
	}
	return found
}

describe('every server write that could change a task status is accounted for', () => {
	const found = statusCapableWriters()

	it('has no status writer that is missing from the list', () => {
		const unknown = found.filter((key) => !(key in WRITERS))
		expect(
			unknown,
			'A new place writes an object status. Add it to WRITERS with the reason, and if an agent can reach it, call requiresOutcomeCheck first.',
		).toEqual([])
	})

	it('has no entry in the list that no longer exists', () => {
		expect(Object.keys(WRITERS).filter((key) => !found.includes(key))).toEqual([])
	})

	it('calls the decision function from every file that lists it as the way in', () => {
		const files = new Set(
			Object.entries(WRITERS)
				.filter(([, w]) => w.via === 'decision-function')
				.map(([key]) => key.split(' :: ')[0] as string),
		)
		// object-update.ts and send-closure.ts call it themselves; the bulk route calls it in
		// routes/objects.ts before it plans a write.
		for (const file of files) {
			expect(readFileSync(join(devSrc, file), 'utf8'), file).toContain('requiresOutcomeCheck')
		}
	})
})
