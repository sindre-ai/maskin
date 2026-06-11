import { useAvailableObjectTypes } from '@/hooks/use-available-object-types'
import { WorkspaceContext, type WorkspaceContextValue } from '@/lib/workspace-context'
import { type ModuleWebDefinition, clearWebModules, registerWebModule } from '@maskin/module-sdk'
import { renderHook } from '@testing-library/react'
import React from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

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

const workModule: ModuleWebDefinition = {
	id: 'work',
	name: 'Work',
	navItems: [],
	objectTypeTabs: [
		{ label: 'Bets', value: 'bet' },
		{ label: 'Insights', value: 'insight' },
		{ label: 'Tasks', value: 'task' },
	],
}

beforeEach(() => {
	clearWebModules()
	registerWebModule(workModule)
})

afterEach(() => {
	clearWebModules()
})

describe('useAvailableObjectTypes', () => {
	it('returns module tabs when no custom extensions exist', () => {
		const { result } = renderHook(() => useAvailableObjectTypes(), {
			wrapper: createWrapper({ enabled_modules: ['work'] }),
		})

		expect(result.current.map((t) => t.value)).toEqual(['bet', 'insight', 'task'])
	})

	it('appends enabled custom extension types', () => {
		const settings = {
			enabled_modules: ['work'],
			custom_extensions: {
				crm: { name: 'CRM', types: ['lead', 'deal'], enabled: true },
			},
			display_names: { lead: 'Leads', deal: 'Deals' },
		}
		const { result } = renderHook(() => useAvailableObjectTypes(), {
			wrapper: createWrapper(settings),
		})

		expect(result.current.map((t) => t.value)).toEqual(['bet', 'insight', 'task', 'lead', 'deal'])
		expect(result.current.find((t) => t.value === 'lead')?.label).toBe('Leads')
	})

	it('skips disabled custom extensions', () => {
		const settings = {
			enabled_modules: ['work'],
			custom_extensions: {
				crm: { name: 'CRM', types: ['lead'], enabled: false },
			},
		}
		const { result } = renderHook(() => useAvailableObjectTypes(), {
			wrapper: createWrapper(settings),
		})

		expect(result.current.map((t) => t.value)).toEqual(['bet', 'insight', 'task'])
	})

	it('lets module tabs win when a custom extension shadows a built-in type', () => {
		const settings = {
			enabled_modules: ['work'],
			custom_extensions: {
				dup: { name: 'Dup', types: ['bet'], enabled: true },
			},
			display_names: { bet: 'Custom Bet' },
		}
		const { result } = renderHook(() => useAvailableObjectTypes(), {
			wrapper: createWrapper(settings),
		})

		const bets = result.current.filter((t) => t.value === 'bet')
		expect(bets).toHaveLength(1)
		expect(bets[0].label).toBe('Bets')
	})
})
