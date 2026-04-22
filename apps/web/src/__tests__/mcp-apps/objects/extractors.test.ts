import {
	extractCreateObjectsList,
	extractFirstUpdatedObject,
	extractGetObjectsList,
	extractUpdateObjectsList,
} from '@/mcp-apps/objects/extractors'
import type { ObjectResponse } from '@/mcp-apps/shared/types'
import { describe, expect, it } from 'vitest'

const obj = (overrides: Partial<ObjectResponse> = {}): ObjectResponse => ({
	id: 'obj-1',
	workspaceId: 'ws-1',
	type: 'task',
	title: 'Test',
	content: null,
	status: 'todo',
	metadata: null,
	owner: null,
	activeSessionId: null,
	createdBy: 'actor-1',
	createdAt: '2026-04-22T00:00:00.000Z',
	updatedAt: '2026-04-22T00:00:00.000Z',
	...overrides,
})

const textEnvelope = (payload: unknown) => ({
	content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
})

describe('extractFirstUpdatedObject', () => {
	it('returns the first successful object update', () => {
		const first = obj({ id: 'a' })
		const second = obj({ id: 'b' })
		const result = extractFirstUpdatedObject(
			textEnvelope([
				{ type: 'object', id: 'a', success: true, result: first },
				{ type: 'object', id: 'b', success: true, result: second },
			]),
		)
		expect(result).toEqual(first)
	})

	it('skips relationship items', () => {
		const target = obj({ id: 'x' })
		const result = extractFirstUpdatedObject(
			textEnvelope([
				{ type: 'relationship', id: 'r', success: true, result: { some: 'rel' } },
				{ type: 'object', id: 'x', success: true, result: target },
			]),
		)
		expect(result).toEqual(target)
	})

	it('skips failed updates', () => {
		const ok = obj({ id: 'ok' })
		const result = extractFirstUpdatedObject(
			textEnvelope([
				{ type: 'object', id: 'fail', success: false, error: 'boom' },
				{ type: 'object', id: 'ok', success: true, result: ok },
			]),
		)
		expect(result).toEqual(ok)
	})

	it('returns null when no text content is present', () => {
		expect(extractFirstUpdatedObject({ content: [] })).toBeNull()
		expect(extractFirstUpdatedObject({})).toBeNull()
	})

	it('returns null on malformed JSON', () => {
		expect(extractFirstUpdatedObject({ content: [{ type: 'text', text: 'not json' }] })).toBeNull()
	})

	it('returns null when no object matches', () => {
		const result = extractFirstUpdatedObject(
			textEnvelope([{ type: 'relationship', id: 'r', success: true, result: {} }]),
		)
		expect(result).toBeNull()
	})
})

describe('extractGetObjectsList', () => {
	it('returns objects from successful results', () => {
		const a = obj({ id: 'a' })
		const b = obj({ id: 'b' })
		expect(
			extractGetObjectsList([
				{ success: true, result: { object: a } },
				{ success: true, result: { object: b } },
			]),
		).toEqual([a, b])
	})

	it('skips failed entries', () => {
		const a = obj({ id: 'a' })
		expect(
			extractGetObjectsList([{ success: true, result: { object: a } }, { success: false }]),
		).toEqual([a])
	})

	it('returns [] for non-array input', () => {
		expect(extractGetObjectsList(null as unknown as never)).toEqual([])
		expect(extractGetObjectsList({} as unknown as never)).toEqual([])
	})

	it('returns [] for empty array', () => {
		expect(extractGetObjectsList([])).toEqual([])
	})
})

describe('extractUpdateObjectsList', () => {
	it('returns successfully updated objects only', () => {
		const a = obj({ id: 'a' })
		const b = obj({ id: 'b' })
		expect(
			extractUpdateObjectsList([
				{ type: 'object', id: 'a', success: true, result: a },
				{ type: 'object', id: 'b', success: true, result: b },
			]),
		).toEqual([a, b])
	})

	it('filters out relationship items', () => {
		const a = obj({ id: 'a' })
		expect(
			extractUpdateObjectsList([
				{ type: 'object', id: 'a', success: true, result: a },
				{ type: 'relationship', id: 'r', success: true, result: {} as ObjectResponse },
			]),
		).toEqual([a])
	})

	it('filters out failed updates', () => {
		const a = obj({ id: 'a' })
		expect(
			extractUpdateObjectsList([
				{ type: 'object', id: 'a', success: true, result: a },
				{ type: 'object', id: 'b', success: false },
			]),
		).toEqual([a])
	})

	it('returns [] for non-array input', () => {
		expect(extractUpdateObjectsList(null as unknown as never)).toEqual([])
	})
})

describe('extractCreateObjectsList', () => {
	it('returns nodes from the envelope', () => {
		const nodes = [obj({ id: 'a' }), obj({ id: 'b' })]
		expect(extractCreateObjectsList({ nodes })).toEqual(nodes)
	})

	it('returns [] when nodes is missing', () => {
		expect(extractCreateObjectsList({})).toEqual([])
	})

	it('tolerates a bare array payload', () => {
		const nodes = [obj({ id: 'a' })]
		expect(extractCreateObjectsList(nodes)).toEqual(nodes)
	})

	it('returns [] for null/undefined', () => {
		expect(extractCreateObjectsList(null)).toEqual([])
		expect(extractCreateObjectsList(undefined)).toEqual([])
	})
})
