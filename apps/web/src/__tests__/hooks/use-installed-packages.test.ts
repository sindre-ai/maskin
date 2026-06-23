import { QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({
	api: {
		installedPackages: {
			list: vi.fn(),
			install: vi.fn(),
			fork: vi.fn(),
			uninstall: vi.fn(),
		},
	},
}))

vi.mock('sonner', () => ({
	toast: {
		success: vi.fn(),
		error: vi.fn(),
	},
}))

import {
	useForkInstalledPackage,
	useInstallPackage,
	useInstalledPackages,
	useUninstallPackage,
} from '@/hooks/use-installed-packages'
import { api } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
import { toast } from 'sonner'
import { TestWrapper, createTestQueryClient } from '../setup'

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

describe('useInstalledPackages', () => {
	it('fetches installs for the workspace', async () => {
		vi.mocked(api.installedPackages.list).mockResolvedValue({ installs: [] })
		const { result } = renderHook(() => useInstalledPackages(workspaceId), {
			wrapper: TestWrapper,
		})
		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(api.installedPackages.list).toHaveBeenCalledWith(workspaceId)
	})

	it('is disabled when workspaceId is empty', () => {
		const { result } = renderHook(() => useInstalledPackages(''), { wrapper: TestWrapper })
		expect(result.current.isFetching).toBe(false)
		expect(api.installedPackages.list).not.toHaveBeenCalled()
	})
})

describe('useInstallPackage', () => {
	it('calls api.installedPackages.install and toasts on success', async () => {
		vi.mocked(api.installedPackages.install).mockResolvedValue({
			id: 'inst-1',
			workspaceId,
			sourcePackageId: 'pkg-1',
			installedVersion: '1.0.0',
			isLocked: true,
			forkedAt: null,
			installedAt: null,
			updatedAt: null,
			provisioned: { actors: 0, triggers: 0, skills: 0, integrations: 0 },
		})
		const { result } = renderHook(() => useInstallPackage(workspaceId), { wrapper: TestWrapper })
		result.current.mutate({ packageId: 'pkg-1' })
		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(api.installedPackages.install).toHaveBeenCalledWith(workspaceId, 'pkg-1')
		expect(toast.success).toHaveBeenCalledWith('Package installed')
	})

	it('surfaces an error when install fails', async () => {
		vi.mocked(api.installedPackages.install).mockRejectedValue(new Error('Already installed'))
		const { result } = renderHook(() => useInstallPackage(workspaceId), { wrapper: TestWrapper })
		result.current.mutate({ packageId: 'pkg-1' })
		await waitFor(() => expect(result.current.isError).toBe(true))
		expect(result.current.error?.message).toBe('Already installed')
	})
})

describe('useForkInstalledPackage', () => {
	it('calls api.installedPackages.fork and toasts on success', async () => {
		vi.mocked(api.installedPackages.fork).mockResolvedValue({
			id: 'inst-1',
			workspaceId,
			sourcePackageId: 'pkg-1',
			installedVersion: '1.0.0',
			isLocked: false,
			forkedAt: '2026-06-13T00:00:00.000Z',
			installedAt: null,
			updatedAt: null,
			detached: { actors: 0, triggers: 0, skills: 0, integrations: 0 },
		})
		const { result } = renderHook(() => useForkInstalledPackage(workspaceId), {
			wrapper: TestWrapper,
		})
		result.current.mutate({ installedPackageId: 'inst-1' })
		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(api.installedPackages.fork).toHaveBeenCalledWith(workspaceId, 'inst-1')
		expect(toast.success).toHaveBeenCalledWith('Package forked')
	})
})

describe('cache invalidation after package mutations', () => {
	const forkResponse = {
		id: 'inst-1',
		workspaceId,
		sourcePackageId: 'pkg-1',
		installedVersion: '1.0.0',
		isLocked: false,
		forkedAt: '2026-06-13T00:00:00.000Z',
		installedAt: null,
		updatedAt: null,
		detached: { actors: 0, triggers: 0, skills: 0, integrations: 0 },
	}

	it('useInstallPackage invalidates workspaceSkills and integrations', async () => {
		vi.mocked(api.installedPackages.install).mockResolvedValue({
			id: 'inst-1',
			workspaceId,
			sourcePackageId: 'pkg-1',
			installedVersion: '1.0.0',
			isLocked: true,
			forkedAt: null,
			installedAt: null,
			updatedAt: null,
			provisioned: { actors: 0, triggers: 0, skills: 0, integrations: 0 },
		})
		const { queryClient, wrapper } = makeWrapper()
		const { result } = renderHook(() => useInstallPackage(workspaceId), { wrapper })

		result.current.mutate({ packageId: 'pkg-1' })
		await waitFor(() => expect(result.current.isSuccess).toBe(true))

		expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
			queryKey: queryKeys.workspaceSkills.all(workspaceId),
		})
		expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
			queryKey: queryKeys.integrations.all(workspaceId),
		})
	})

	it('useForkInstalledPackage invalidates workspaceSkills and integrations', async () => {
		vi.mocked(api.installedPackages.fork).mockResolvedValue(forkResponse)
		const { queryClient, wrapper } = makeWrapper()
		const { result } = renderHook(() => useForkInstalledPackage(workspaceId), { wrapper })

		result.current.mutate({ installedPackageId: 'inst-1' })
		await waitFor(() => expect(result.current.isSuccess).toBe(true))

		expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
			queryKey: queryKeys.workspaceSkills.all(workspaceId),
		})
		expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
			queryKey: queryKeys.integrations.all(workspaceId),
		})
	})

	it('useUninstallPackage invalidates workspaceSkills and integrations', async () => {
		vi.mocked(api.installedPackages.uninstall).mockResolvedValue({ deleted: true })
		const { queryClient, wrapper } = makeWrapper()
		const { result } = renderHook(() => useUninstallPackage(workspaceId), { wrapper })

		result.current.mutate({ installedPackageId: 'inst-1', keepProvisionedItems: false })
		await waitFor(() => expect(result.current.isSuccess).toBe(true))

		expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
			queryKey: queryKeys.workspaceSkills.all(workspaceId),
		})
		expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
			queryKey: queryKeys.integrations.all(workspaceId),
		})
	})
})
