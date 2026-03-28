import { renderHook } from '@testing-library/react'
import React from 'react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceContextValue } from '@/lib/workspace-context'
import { WorkspaceContext } from '@/lib/workspace-context'
import { useEnabledModules } from '@/hooks/use-enabled-modules'

let currentSettings: Record<string, unknown> = {}

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

/** Wrapper that reads from mutable `currentSettings`, so rerenders pick up new object references */
function MutableSettingsWrapper({ children }: { children: ReactNode }) {
	const value: WorkspaceContextValue = {
		workspace: {
			id: 'ws-1',
			name: 'Test',
			settings: currentSettings,
			role: 'owner',
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		} as WorkspaceContextValue['workspace'],
		workspaceId: 'ws-1',
		sseStatus: 'connected',
	}
	return React.createElement(WorkspaceContext.Provider, { value }, children)
}

beforeEach(() => {
	vi.clearAllMocks()
	currentSettings = {}
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

	it('returns empty array when enabled_modules is an empty array', () => {
		const { result } = renderHook(() => useEnabledModules(), {
			wrapper: createWorkspaceWrapper({ enabled_modules: [] }),
		})
		expect(result.current).toEqual([])
	})

	it('returns stable reference when values have not changed', () => {
		currentSettings = { enabled_modules: ['work', 'pulse'] }
		const { result, rerender } = renderHook(() => useEnabledModules(), {
			wrapper: MutableSettingsWrapper,
		})

		const first = result.current
		// Create a new settings object with identical values — different reference, same content
		currentSettings = { enabled_modules: ['work', 'pulse'] }
		rerender()
		expect(result.current).toBe(first)
	})

	it('returns new reference when values change', () => {
		currentSettings = { enabled_modules: ['work'] }
		const { result, rerender } = renderHook(() => useEnabledModules(), {
			wrapper: MutableSettingsWrapper,
		})

		const first = result.current
		currentSettings = { enabled_modules: ['work', 'pulse'] }
		rerender()
		expect(result.current).not.toBe(first)
		expect(result.current).toEqual(['work', 'pulse'])
	})
})
