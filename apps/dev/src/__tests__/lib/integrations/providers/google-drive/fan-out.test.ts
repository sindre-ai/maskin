import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../../../lib/logger', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import {
	classifyChange,
	matchWatchedAncestors,
} from '../../../../../lib/integrations/providers/google-drive/fan-out'

const T = '2026-10-12T10:00:00.000Z'

describe('classifyChange', () => {
	it('reads a change within a minute of the file creation as created', () => {
		expect(
			classifyChange({
				fileId: 'f1',
				time: T,
				file: {
					id: 'f1',
					name: 'a.pdf',
					mimeType: 'application/pdf',
					createdTime: '2026-10-12T09:59:30.000Z',
				},
			}),
		).toEqual({
			fileId: 'f1',
			eventType: 'created',
			changeTime: T,
			name: 'a.pdf',
			mimeType: 'application/pdf',
		})
	})

	it('reads a change long after creation as updated', () => {
		expect(
			classifyChange({
				fileId: 'f1',
				time: T,
				file: { id: 'f1', name: 'a', mimeType: 'text/plain', createdTime: '2026-01-01T00:00:00Z' },
			})?.eventType,
		).toBe('updated')
	})

	it('reads a trashed file as trashed, whatever its age', () => {
		expect(
			classifyChange({
				fileId: 'f1',
				time: T,
				file: { id: 'f1', name: 'a', mimeType: 'text/plain', trashed: true, createdTime: T },
			})?.eventType,
		).toBe('trashed')
	})

	it('reads a removal as deleted and carries the file id only', () => {
		expect(classifyChange({ fileId: 'f1', removed: true, time: T })).toEqual({
			fileId: 'f1',
			eventType: 'deleted',
			changeTime: T,
		})
	})

	it('skips a change that names no file (shared-drive metadata)', () => {
		expect(classifyChange({ changeType: 'drive', time: T })).toBeNull()
	})

	it('skips a non-removal change that carries no file body', () => {
		expect(classifyChange({ fileId: 'f1', time: T })).toBeNull()
	})
})

describe('matchWatchedAncestors', () => {
	const tree: Record<string, string[]> = {
		leaf: ['mid'],
		mid: ['top'],
		top: ['root'],
		root: [],
	}
	const parentsOf = async (id: string) => tree[id] ?? []

	it('matches a watched direct parent', async () => {
		expect([...(await matchWatchedAncestors(['mid'], new Set(['mid']), parentsOf))]).toEqual([
			'mid',
		])
	})

	it('matches a watched ancestor several levels up', async () => {
		expect([...(await matchWatchedAncestors(['mid'], new Set(['root']), parentsOf))]).toEqual([
			'root',
		])
	})

	it('returns every watched folder on the chain, so nested watches each match', async () => {
		const out = await matchWatchedAncestors(['mid'], new Set(['mid', 'root']), parentsOf)
		expect([...out].sort()).toEqual(['mid', 'root'])
	})

	it('returns nothing when no ancestor is watched', async () => {
		expect((await matchWatchedAncestors(['mid'], new Set(['other']), parentsOf)).size).toBe(0)
	})

	it('ends on a parent loop instead of walking forever', async () => {
		const loop: Record<string, string[]> = { a: ['b'], b: ['a'] }
		const out = await matchWatchedAncestors(['a'], new Set(['zzz']), async (id) => loop[id] ?? [])
		expect(out.size).toBe(0)
	})

	it('covers a file with two parents', async () => {
		const out = await matchWatchedAncestors(['p1', 'p2'], new Set(['p2']), async () => [])
		expect([...out]).toEqual(['p2'])
	})

	it('stops at the depth cap', async () => {
		const calls = vi.fn(async (id: string) => [`${id}x`])
		await matchWatchedAncestors(['a'], new Set(['never']), calls)
		expect(calls.mock.calls.length).toBeLessThanOrEqual(25)
	})
})
