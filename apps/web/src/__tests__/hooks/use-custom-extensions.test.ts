import type { CustomExtensionInfo } from '@/hooks/use-custom-extensions'
import { useCustomExtensions } from '@/hooks/use-custom-extensions'
import { WorkspaceContext, type WorkspaceContextValue } from '@/lib/workspace-context'
import { renderHook } from '@testing-library/react'
import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

function createWrapper(settings: Record<string, unknown>) {
	const ctx: WorkspaceContextValue = {
		workspace: {
			id: 'ws-1',
			name: 'Test',
			settings,
			role: 'owner',
			createdBy: 'actor-1',
			createdAt: null,
			updatedAt: null,
		},
		workspaceId: 'ws-1',
		sseStatus: 'connected',
	}
	return ({ children }: { children: React.ReactNode }) =>
		React.createElement(WorkspaceContext.Provider, { value: ctx }, children)
}

describe('useCustomExtensions', () => {
	it('returns empty array when no custom_extensions in settings', () => {
		const { result } = renderHook(() => useCustomExtensions(), {
			wrapper: createWrapper({}),
		})

		expect(result.current).toEqual([])
	})

	it('returns empty array when custom_extensions is empty object', () => {
		const { result } = renderHook(() => useCustomExtensions(), {
			wrapper: createWrapper({ custom_extensions: {} }),
		})

		expect(result.current).toEqual([])
	})

	it('returns extension info with correct shape', () => {
		const settings = {
			custom_extensions: {
				'ext-crm': {
					name: 'CRM',
					types: ['lead', 'deal'],
				},
			},
			display_names: {
				lead: 'Leads',
				deal: 'Deals',
			},
		}

		const { result } = renderHook(() => useCustomExtensions(), {
			wrapper: createWrapper(settings),
		})

		expect(result.current).toEqual([
			{
				id: 'ext-crm',
				name: 'CRM',
				types: ['lead', 'deal'],
				tabs: [
					{ label: 'Leads', value: 'lead' },
					{ label: 'Deals', value: 'deal' },
				],
				enabled: true,
			},
		])
	})

	it('falls back to type name when no display_name exists', () => {
		const settings = {
			custom_extensions: {
				'ext-todo': {
					name: 'Todo',
					types: ['todo_item'],
				},
			},
		}

		const { result } = renderHook(() => useCustomExtensions(), {
			wrapper: createWrapper(settings),
		})

		expect(result.current[0].tabs).toEqual([{ label: 'todo_item', value: 'todo_item' }])
	})

	it('defaults enabled to true when field is missing', () => {
		const settings = {
			custom_extensions: {
				'ext-a': { name: 'A', types: ['type_a'] },
			},
		}

		const { result } = renderHook(() => useCustomExtensions(), {
			wrapper: createWrapper(settings),
		})

		expect(result.current[0].enabled).toBe(true)
	})

	it('returns enabled as false when explicitly set', () => {
		const settings = {
			custom_extensions: {
				'ext-a': { name: 'A', types: ['type_a'], enabled: false },
			},
		}

		const { result } = renderHook(() => useCustomExtensions(), {
			wrapper: createWrapper(settings),
		})

		expect(result.current[0].enabled).toBe(false)
	})

	it('returns enabled as true when explicitly set', () => {
		const settings = {
			custom_extensions: {
				'ext-a': { name: 'A', types: ['type_a'], enabled: true },
			},
		}

		const { result } = renderHook(() => useCustomExtensions(), {
			wrapper: createWrapper(settings),
		})

		expect(result.current[0].enabled).toBe(true)
	})

	it('returns multiple extensions', () => {
		const settings = {
			custom_extensions: {
				'ext-a': { name: 'A', types: ['type_a'] },
				'ext-b': { name: 'B', types: ['type_b'] },
			},
		}

		const { result } = renderHook(() => useCustomExtensions(), {
			wrapper: createWrapper(settings),
		})

		expect(result.current).toHaveLength(2)
		expect(result.current[0].id).toBe('ext-a')
		expect(result.current[1].id).toBe('ext-b')
	})
})
