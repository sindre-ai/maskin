import { QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({
	api: {
		marketplaceItems: {
			install: vi.fn(),
			uninstall: vi.fn(),
		},
	},
}))

import {
	useInstallMarketplaceItem,
	useUninstallMarketplaceItem,
} from '@/hooks/use-marketplace-loops'
import { api } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
import { createTestQueryClient } from '../setup'

const workspaceId = 'ws-1'

function makeWrapper() {
	const queryClient = createTestQueryClient()
	vi.spyOn(queryClient, 'invalidateQueries')
	const wrapper = ({ children }: { children: React.ReactNode }) =>
		React.createElement(QueryClientProvider, { client: queryClient }, children)
	return { queryClient, wrapper }
}

beforeEach(() => {
	vi.clearAllMocks()
})

describe('useInstallMarketplaceItem', () => {
	it('invalidates workspaceSkills and integrations caches on success', async () => {
		vi.mocked(api.marketplaceItems.install).mockResolvedValue({
			id: 'item-1',
			item_type: 'actor',
			name: 'Test Actor',
		})
		const { queryClient, wrapper } = makeWrapper()
		const { result } = renderHook(() => useInstallMarketplaceItem(workspaceId), { wrapper })

		result.current.mutate('item-1')
		await waitFor(() => expect(result.current.isSuccess).toBe(true))

		expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
			queryKey: queryKeys.workspaceSkills.all(workspaceId),
		})
		expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
			queryKey: queryKeys.integrations.all(workspaceId),
		})
	})

	it('also invalidates actors, triggers, and marketplaceItems on success', async () => {
		vi.mocked(api.marketplaceItems.install).mockResolvedValue({
			id: 'item-1',
			item_type: 'actor',
			name: 'Test Actor',
		})
		const { queryClient, wrapper } = makeWrapper()
		const { result } = renderHook(() => useInstallMarketplaceItem(workspaceId), { wrapper })

		result.current.mutate('item-1')
		await waitFor(() => expect(result.current.isSuccess).toBe(true))

		expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
			queryKey: queryKeys.actors.all(workspaceId),
		})
		expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
			queryKey: queryKeys.triggers.all(workspaceId),
		})
		expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
			queryKey: queryKeys.marketplaceItems.installed(workspaceId),
		})
	})
})

describe('useUninstallMarketplaceItem', () => {
	it('invalidates workspaceSkills and integrations caches on success', async () => {
		vi.mocked(api.marketplaceItems.uninstall).mockResolvedValue({ deleted: true })
		const { queryClient, wrapper } = makeWrapper()
		const { result } = renderHook(() => useUninstallMarketplaceItem(workspaceId), { wrapper })

		result.current.mutate({ itemId: 'item-1', keepProvisionedItems: false })
		await waitFor(() => expect(result.current.isSuccess).toBe(true))

		expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
			queryKey: queryKeys.workspaceSkills.all(workspaceId),
		})
		expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
			queryKey: queryKeys.integrations.all(workspaceId),
		})
	})

	it('also invalidates actors, triggers, and marketplaceItems on success', async () => {
		vi.mocked(api.marketplaceItems.uninstall).mockResolvedValue({ deleted: true })
		const { queryClient, wrapper } = makeWrapper()
		const { result } = renderHook(() => useUninstallMarketplaceItem(workspaceId), { wrapper })

		result.current.mutate({ itemId: 'item-1', keepProvisionedItems: true })
		await waitFor(() => expect(result.current.isSuccess).toBe(true))

		expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
			queryKey: queryKeys.actors.all(workspaceId),
		})
		expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
			queryKey: queryKeys.triggers.all(workspaceId),
		})
		expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
			queryKey: queryKeys.marketplaceItems.installed(workspaceId),
		})
	})
})
