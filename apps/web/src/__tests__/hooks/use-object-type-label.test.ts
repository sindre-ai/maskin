import { useObjectTypeLabel } from '@/hooks/use-object-type-label'
import { WorkspaceContext, type WorkspaceContextValue } from '@/lib/workspace-context'
import { renderHook } from '@testing-library/react'
import React from 'react'
import { describe, expect, it } from 'vitest'

function createWrapper(settings: Record<string, unknown>) {
	const ctx: WorkspaceContextValue = {
		workspace: {
			id: 'ws-1',
			name: 'Test',
			settings,
			enterprise: false,
			billingOwnerId: 'actor-1',
			role: 'owner',
			isDefault: false,
			isTeam: false,
			internal: false,
			paying: false,
			memberCount: 1,
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

describe('useObjectTypeLabel', () => {
	it('uses the workspace display name when there is one', () => {
		const { result } = renderHook(() => useObjectTypeLabel(), {
			wrapper: createWrapper({ display_names: { knowledge: 'Article' } }),
		})
		expect(result.current('knowledge')).toBe('Article')
	})

	it('labels the loop type Flow when the workspace has no display name for it', () => {
		const { result } = renderHook(() => useObjectTypeLabel(), {
			wrapper: createWrapper({ display_names: {} }),
		})
		expect(result.current('loop')).toBe('Flow')
	})

	it('title-cases a type nothing else names', () => {
		const { result } = renderHook(() => useObjectTypeLabel(), {
			wrapper: createWrapper({}),
		})
		expect(result.current('knowledge_base')).toBe('Knowledge base')
	})
})
