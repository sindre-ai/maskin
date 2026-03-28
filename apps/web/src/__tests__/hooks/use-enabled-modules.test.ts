import { renderHook } from '@testing-library/react'
import React from 'react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceContextValue } from '@/lib/workspace-context'
import { WorkspaceContext } from '@/lib/workspace-context'
import { useEnabledModules } from '@/hooks/use-enabled-modules'

function createWorkspaceWrapper(settings: Record<string, unknown> = {}) {
	const value: WorkspaceContextValue = {
		workspace: {
			id: 'ws-1',
			name: 'Test',
			settings,
			role: 'owner',
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		} as WorkspaceContextValue['workspace'],
		workspaceId: 'ws-1',
		sseStatus: 'connected',
	}
	return ({ children }: { children: ReactNode }) =>
		React.createElement(WorkspaceContext.Provider, { value }, children)
}

beforeEach(() => {
	vi.clearAllMocks()
})

describe('useEnabledModules', () => {
	it('returns ["work"] when no enabled_modules in settings', () => {
		const { result } = renderHook(() => useEnabledModules(), {
			wrapper: createWorkspaceWrapper({}),
		})
		expect(result.current).toEqual(['work'])
	})

	it('returns enabled_modules from workspace settings', () => {
		const { result } = renderHook(() => useEnabledModules(), {
			wrapper: createWorkspaceWrapper({ enabled_modules: ['work', 'pulse'] }),
		})
		expect(result.current).toEqual(['work', 'pulse'])
	})

	it('returns ["work"] when enabled_modules is not an array', () => {
		const { result } = renderHook(() => useEnabledModules(), {
			wrapper: createWorkspaceWrapper({ enabled_modules: 'invalid' }),
		})
		expect(result.current).toEqual(['work'])
	})

	it('returns stable reference when values have not changed', () => {
		const { result, rerender } = renderHook(() => useEnabledModules(), {
			wrapper: createWorkspaceWrapper({ enabled_modules: ['work', 'pulse'] }),
		})

		const first = result.current
		rerender()
		expect(result.current).toBe(first)
	})
})
