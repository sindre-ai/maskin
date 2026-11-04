import type { Database } from '@maskin/db'
import { describe, expect, it, vi } from 'vitest'
import type { StartCard } from '../../services/voice-call-state'
import {
	canonicalizeId,
	repairToolIdArgs,
	resolveObjectId,
} from '../../services/voice-id-resolution'

const WORKSPACE = 'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f'
const TOP = 'be2b2931-c4a9-463c-a1ad-bfcab47b0b4e'
const LOWER = '756e1cbe-9933-4fe2-a3fd-d95ce6497044'

const card = (objectId: string | null, rank: number): StartCard => ({
	objectId,
	notificationId: null,
	source: 'curated',
	rank,
})

function dbReturning(rows: Array<{ id: string }>) {
	const limit = vi.fn().mockResolvedValue(rows)
	const select = vi.fn(() => ({ from: () => ({ where: () => ({ limit }) }) }))
	return { db: { select } as unknown as Database, select }
}

describe('canonicalizeId', () => {
	it.each([
		['a clean id', TOP, TOP],
		['an upper-case id', TOP.toUpperCase(), TOP],
		['an id in quotes with a full stop', `"${TOP}".`, TOP],
		['an id without dashes', TOP.replace(/-/g, ''), TOP],
		['an id inside a link', `https://maskin.io/ws/objects/${TOP}`, TOP],
		['an id with spaces around it', `  ${TOP}\n`, TOP],
	])('reads %s as the full id', (_label, raw, expected) => {
		expect(canonicalizeId(raw)).toEqual({ kind: 'uuid', id: expected })
	})

	it('reads the eight characters a receipt shows as a prefix', () => {
		expect(canonicalizeId('be2b2931')).toEqual({ kind: 'prefix', hex: 'be2b2931' })
		expect(canonicalizeId('BE2B2931-C4A9')).toEqual({ kind: 'prefix', hex: 'be2b2931c4a9' })
	})

	it.each([['nope'], [''], ['be2b'], [42], [null], ['be2b2931-zzzz-463c']])('refuses %s', (raw) => {
		expect(canonicalizeId(raw)).toEqual({ kind: 'bad' })
	})
})

describe('resolveObjectId', () => {
	it('repairs a full id without touching the database', async () => {
		const { db, select } = dbReturning([])
		const res = await resolveObjectId(db, WORKSPACE, TOP.replace(/-/g, ''))
		expect(res).toEqual({ ok: true, id: TOP, repaired: true })
		expect(select).not.toHaveBeenCalled()
	})

	it('resolves a prefix from the cards the call started with first', async () => {
		const { db, select } = dbReturning([])
		const res = await resolveObjectId(db, WORKSPACE, 'be2b2931', [card(LOWER, 2), card(TOP, 1)])
		expect(res).toEqual({ ok: true, id: TOP, repaired: true })
		expect(select).not.toHaveBeenCalled()
	})

	it('falls back to the workspace objects for a prefix and accepts one match', async () => {
		const { db } = dbReturning([{ id: LOWER }])
		expect(await resolveObjectId(db, WORKSPACE, '756e1cbe', [])).toEqual({
			ok: true,
			id: LOWER,
			repaired: true,
		})
	})

	it('does not guess between two objects that share a prefix', async () => {
		const { db } = dbReturning([{ id: TOP }, { id: LOWER }])
		expect(await resolveObjectId(db, WORKSPACE, 'be2b2931')).toEqual({
			ok: false,
			reason: 'ambiguous',
		})
	})

	it('reports an unknown prefix and a malformed id, never another card', async () => {
		const { db } = dbReturning([])
		expect(await resolveObjectId(db, WORKSPACE, 'deadbeef', [card(TOP, 1)])).toEqual({
			ok: false,
			reason: 'not_found',
		})
		expect(await resolveObjectId(db, WORKSPACE, 'top card')).toEqual({
			ok: false,
			reason: 'malformed',
		})
	})
})

describe('repairToolIdArgs', () => {
	it('repairs id-shaped arguments and leaves everything else alone', async () => {
		const { db } = dbReturning([])
		const out = await repairToolIdArgs(
			db,
			WORKSPACE,
			{ ids: [TOP.replace(/-/g, ''), LOWER], title: 'be2b2931', object_id: `"${TOP}"` },
			null,
		)
		expect(out).toEqual({ ids: [TOP, LOWER], title: 'be2b2931', object_id: TOP })
	})

	it('passes an unresolvable id through so the tool answers with its own error', async () => {
		const { db } = dbReturning([])
		const out = await repairToolIdArgs(db, WORKSPACE, { id: 'the top one' }, null)
		expect(out).toEqual({ id: 'the top one' })
	})
})
