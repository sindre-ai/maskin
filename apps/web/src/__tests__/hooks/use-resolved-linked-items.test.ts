import type { LinkedItem } from '@/hooks/use-conversation-linked'
import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const getObject = vi.fn()
const files = vi.fn()

vi.mock('@/lib/api', () => ({ api: { objects: { get: (id: string) => getObject(id) } } }))
vi.mock('@/hooks/use-files', () => ({ useFiles: () => files() }))

import { useResolvedLinkedItems } from '@/hooks/use-conversation-linked'
import { TestWrapper } from '../setup'

const item = (kind: LinkedItem['kind'], id: string): LinkedItem => ({
	kind,
	id,
	messageId: 1,
	actorId: 'a',
	actorName: 'A',
	actorType: 'agent',
	createdAt: null,
})

const items = [
	item('object', 'draft'),
	item('object', 'plain'),
	item('object', 'missing'),
	item('object', 'foreign'),
	item('object', 'broken'),
	item('file', 'f-ok'),
	item('file', 'f-gone'),
]

describe('useResolvedLinkedItems', () => {
	beforeEach(() => {
		getObject.mockReset()
		files.mockReset()
		files.mockReturnValue({ data: [{ id: 'f-ok' }], isError: false })
	})

	it('hides what does not resolve and counts only what shows', async () => {
		getObject.mockImplementation(async (id: string) => {
			if (id === 'draft') return { id, workspaceId: 'ws', preview: { body: 'x' } }
			if (id === 'plain') return { id, workspaceId: 'ws', preview: null }
			if (id === 'foreign') return { id, workspaceId: 'other' }
			if (id === 'broken') throw new Error('boom')
			throw new Error('not found')
		})
		const { result } = renderHook(() => useResolvedLinkedItems(items, 'ws'), {
			wrapper: TestWrapper,
		})
		await waitFor(() => expect(result.current.count).toBe(3))
		expect(result.current.items.map((i) => i.id)).toEqual(['draft', 'plain', 'f-ok'])
	})

	it('keeps still-loading items as pending without counting them', () => {
		getObject.mockReturnValue(new Promise(() => {}))
		files.mockReturnValue({ data: undefined, isError: false })
		const { result } = renderHook(() => useResolvedLinkedItems(items, 'ws'), {
			wrapper: TestWrapper,
		})
		expect(result.current.items).toHaveLength(items.length)
		expect(result.current.count).toBe(0)
	})
})
