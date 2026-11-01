import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { findRawSessionLeaks, rawSessionBindings } from './session-serializer-scan'

const ROUTES_DIR = join(dirname(fileURLToPath(import.meta.url)), '../routes')
const routeFiles = readdirSync(ROUTES_DIR).filter((name) => name.endsWith('.ts'))

// Fake route code. The values are made up; nothing here is a real secret.
const BAD_SELECT = `
app.openapi(route, async (c) => {
	const [session] = await db.select().from(sessions).where(eq(sessions.id, id)).limit(1)
	return c.json(session)
})`

const BAD_SPREAD = `
app.openapi(route, async (c) => {
	const [updated] = await db.update(sessions).set({ status: 'paused' }).where(eq(sessions.id, id)).returning()
	return c.json({ ...updated, note: 'paused' })
})`

const BAD_LIST_MAP = `
app.openapi(route, async (c) => {
	const results = await db.select().from(sessions).where(eq(sessions.workspaceId, ws))
	return c.json(results.map((row) => ({ id: row.id, config: row.config })))
})`

const BAD_CONFIG_COLUMN = `
app.openapi(route, async (c) => {
	const [row] = await db.select({ id: sessions.id, config: sessions.config }).from(sessions)
	return c.json({ id: row.id, config: row.config })
})`

const BAD_FENCED_SUBQUERY = `
app.openapi(route, async (c) => {
	const filtered = db.select().from(sessions).where(eq(sessions.conversationId, cid)).as('f')
	const fenced = await db.select().from(filtered).limit(10)
	return c.json(fenced)
})`

const BAD_SSE = `
app.get('/stream', (c) => streamSSE(c, async (stream) => {
	const [session] = await db.select().from(sessions).where(eq(sessions.id, id)).limit(1)
	await stream.writeSSE({ data: JSON.stringify(session) })
}))`

const BAD_LOAD_HELPER = `
app.openapi(route, async (c) => {
	const session = await loadSessionWithAuth(db, id, workspaceId)
	return c.json({ ...session, extra: true })
})`

const GOOD_SERIALIZED = `
app.openapi(route, async (c) => {
	const [session] = await db.select().from(sessions).where(eq(sessions.id, id)).limit(1)
	if (!session) return c.json(createApiError('NOT_FOUND', 'Session not found'), 404)
	if (session.actorId !== actorId) return c.json(createApiError('FORBIDDEN', 'not your session'), 403)
	const rows = await db.select().from(sessions).where(eq(sessions.workspaceId, ws))
	const [updated] = await db.update(sessions).set({ status: 'paused' }).returning()
	return c.json({ one: serializeSession(session), many: rows.map(serializeSession), ...serializeSession(updated), id: session.id })
})`

const GOOD_PLAIN_COLUMNS = `
app.openapi(route, async (c) => {
	const rows = await db.select({ id: sessions.id, status: sessions.status }).from(sessions)
	return c.json(rows)
})`

describe('a route that returns a sessions row goes through serializeSession', () => {
	it('scans every route file', () => {
		expect(routeFiles).toContain('sessions.ts')
		expect(routeFiles.length).toBeGreaterThan(40)
	})

	it('sees the raw session reads in sessions.ts, so a pass is not vacuous', () => {
		const names = rawSessionBindings(readFileSync(join(ROUTES_DIR, 'sessions.ts'), 'utf8'))
		expect(names).toEqual(expect.arrayContaining(['session', 'updated', 'results', 'fenced']))
	})

	for (const name of routeFiles) {
		it(`${name} never sends a raw sessions row or config column to a client`, () => {
			const leaks = findRawSessionLeaks(readFileSync(join(ROUTES_DIR, name), 'utf8'))
			expect(leaks).toEqual([])
		})
	}
})

describe('the scan itself', () => {
	it.each([
		['a full row from select', BAD_SELECT, 'session'],
		['a spread of a returning() row', BAD_SPREAD, 'updated'],
		['a list mapped without the serializer', BAD_LIST_MAP, 'results'],
		['the config column on its own', BAD_CONFIG_COLUMN, 'row'],
		['rows read through a subquery of sessions', BAD_FENCED_SUBQUERY, 'fenced'],
		['a row written to an event stream', BAD_SSE, 'session'],
		['a row from loadSessionWithAuth', BAD_LOAD_HELPER, 'session'],
	])('fails on %s', (_label, source, identifier) => {
		const leaks = findRawSessionLeaks(source)
		expect(leaks.map((leak) => leak.identifier)).toContain(identifier)
	})

	it('passes on wrapped rows, single plain columns and a projection without config', () => {
		expect(findRawSessionLeaks(GOOD_SERIALIZED)).toEqual([])
		expect(findRawSessionLeaks(GOOD_PLAIN_COLUMNS)).toEqual([])
	})

	it('does not mistake a word inside a message for a variable', () => {
		const source = `
app.openapi(route, async (c) => {
	const [session] = await db.select().from(sessions).limit(1)
	return c.json(createApiError('CONFLICT', 'Session is not interactive, so no card'), 409)
})`
		expect(findRawSessionLeaks(source)).toEqual([])
	})

	it('only judges a name inside the handler that read it', () => {
		const source = `
app.openapi(a, async (c) => {
	const [session] = await db.select().from(sessions).limit(1)
	return c.json({ id: session.id })
})
app.openapi(b, async (c) => {
	const session = await somethingElse()
	return c.json(session)
})`
		expect(findRawSessionLeaks(source)).toEqual([])
	})
})
