import { renderHook } from '@testing-library/react'
import React from 'react'
import type { ReactNode } from 'react'
import { describe, expect, it } from 'vitest'
import type { WorkspaceContextValue } from '@/lib/workspace-context'
import { WorkspaceContext, useWorkspace } from '@/lib/workspace-context'

describe('useWorkspace', () => {
	it('throws when used outside a WorkspaceContext provider', () => {
		expect(() => {
			renderHook(() => useWorkspace())
		}).toThrow('useWorkspace must be used within a WorkspaceContext provider')
	})

	it('returns context value when inside a provider', () => {
		const value: WorkspaceContextValue = {
			workspace: {
				id: 'ws-1',
				name: 'Test Workspace',
				settings: {},
				role: 'owner',
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			} as WorkspaceContextValue['workspace'],
			workspaceId: 'ws-1',
			sseStatus: 'connected',
		}

		const wrapper = ({ children }: { children: ReactNode }) =>
			React.createElement(WorkspaceContext.Provider, { value }, children)

		const { result } = renderHook(() => useWorkspace(), { wrapper })

		expect(result.current.workspaceId).toBe('ws-1')
		expect(result.current.workspace.name).toBe('Test Workspace')
		expect(result.current.sseStatus).toBe('connected')
	})
})
