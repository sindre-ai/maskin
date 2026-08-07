import { QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({
	api: {
		installedLoops: {
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
	useForkInstalledLoop,
	useInstallLoop,
	useInstalledLoops,
	useUninstallLoop,
} from '@/hooks/use-installed-loops'
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

describe('useInstalledLoops', () => {
	it('fetches installs for the workspace', async () => {
		vi.mocked(api.installedLoops.list).mockResolvedValue({ installs: [] })
		const { result } = renderHook(() => useInstalledLoops(workspaceId), {
			wrapper: TestWrapper,
		})
		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(api.installedLoops.list).toHaveBeenCalledWith(workspaceId)
	})

	it('is disabled when workspaceId is empty', () => {
		const { result } = renderHook(() => useInstalledLoops(''), { wrapper: TestWrapper })
		expect(result.current.isFetching).toBe(false)
		expect(api.installedLoops.list).not.toHaveBeenCalled()
	})
})

describe('useInstallLoop', () => {
	it('calls api.installedLoops.install and toasts on success', async () => {
		vi.mocked(api.installedLoops.install).mockResolvedValue({
			id: 'inst-1',
			workspaceId,
			sourceLoopId: 'loop-1',
			objectId: 'obj-1',
			installedVersion: '1.0.0',
			isLocked: true,
			forkedAt: null,
			installedAt: null,
			updatedAt: null,
			provisioned: { actors: 0, triggers: 0, skills: 0, integrations: 0 },
		})
		const { result } = renderHook(() => useInstallLoop(workspaceId), { wrapper: TestWrapper })
		result.current.mutate({ loopId: 'loop-1' })
		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(api.installedLoops.install).toHaveBeenCalledWith(workspaceId, 'loop-1')
		expect(toast.success).toHaveBeenCalledWith('Loop installed')
	})

	it('surfaces an error when install fails', async () => {
		vi.mocked(api.installedLoops.install).mockRejectedValue(new Error('Already installed'))
		const { result } = renderHook(() => useInstallLoop(workspaceId), { wrapper: TestWrapper })
		result.current.mutate({ loopId: 'loop-1' })
		await waitFor(() => expect(result.current.isError).toBe(true))
		expect(result.current.error?.message).toBe('Already installed')
	})

	it('invalidates the objects cache since install creates a Loop object', async () => {
		vi.mocked(api.installedLoops.install).mockResolvedValue({
			id: 'inst-1',
			workspaceId,
			sourceLoopId: 'loop-1',
			objectId: 'obj-1',
			installedVersion: '1.0.0',
			isLocked: true,
			forkedAt: null,
			installedAt: null,
			updatedAt: null,
			provisioned: { actors: 0, triggers: 0, skills: 0, integrations: 0 },
		})
		const { queryClient, wrapper } = makeWrapper()
		const { result } = renderHook(() => useInstallLoop(workspaceId), { wrapper })

		result.current.mutate({ loopId: 'loop-1' })
		await waitFor(() => expect(result.current.isSuccess).toBe(true))

		expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
			queryKey: queryKeys.objects.all(workspaceId),
		})
	})
})

describe('useForkInstalledLoop', () => {
	it('calls api.installedLoops.fork and toasts on success', async () => {
		vi.mocked(api.installedLoops.fork).mockResolvedValue({
			id: 'inst-1',
			workspaceId,
			sourceLoopId: 'loop-1',
			objectId: 'obj-1',
			installedVersion: '1.0.0',
			isLocked: false,
			forkedAt: '2026-06-13T00:00:00.000Z',
			installedAt: null,
			updatedAt: null,
			detached: { actors: 0, triggers: 0, skills: 0, integrations: 0 },
		})
		const { result } = renderHook(() => useForkInstalledLoop(workspaceId), {
			wrapper: TestWrapper,
		})
		result.current.mutate({ installedLoopId: 'inst-1' })
		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(api.installedLoops.fork).toHaveBeenCalledWith(workspaceId, 'inst-1')
		expect(toast.success).toHaveBeenCalledWith('Loop forked')
	})
})

describe('cache invalidation after loop mutations', () => {
	const forkResponse = {
		id: 'inst-1',
		workspaceId,
		sourceLoopId: 'loop-1',
		objectId: 'obj-1',
		installedVersion: '1.0.0',
		isLocked: false,
		forkedAt: '2026-06-13T00:00:00.000Z',
		installedAt: null,
		updatedAt: null,
		detached: { actors: 0, triggers: 0, skills: 0, integrations: 0 },
	}

	it('useInstallLoop invalidates workspaceSkills and integrations', async () => {
		vi.mocked(api.installedLoops.install).mockResolvedValue({
			id: 'inst-1',
			workspaceId,
			sourceLoopId: 'loop-1',
			objectId: 'obj-1',
			installedVersion: '1.0.0',
			isLocked: true,
			forkedAt: null,
			installedAt: null,
			updatedAt: null,
			provisioned: { actors: 0, triggers: 0, skills: 0, integrations: 0 },
		})
		const { queryClient, wrapper } = makeWrapper()
		const { result } = renderHook(() => useInstallLoop(workspaceId), { wrapper })

		result.current.mutate({ loopId: 'loop-1' })
		await waitFor(() => expect(result.current.isSuccess).toBe(true))

		expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
			queryKey: queryKeys.workspaceSkills.all(workspaceId),
		})
		expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
			queryKey: queryKeys.integrations.all(workspaceId),
		})
	})

	it('useForkInstalledLoop invalidates workspaceSkills and integrations', async () => {
		vi.mocked(api.installedLoops.fork).mockResolvedValue(forkResponse)
		const { queryClient, wrapper } = makeWrapper()
		const { result } = renderHook(() => useForkInstalledLoop(workspaceId), { wrapper })

		result.current.mutate({ installedLoopId: 'inst-1' })
		await waitFor(() => expect(result.current.isSuccess).toBe(true))

		expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
			queryKey: queryKeys.workspaceSkills.all(workspaceId),
		})
		expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
			queryKey: queryKeys.integrations.all(workspaceId),
		})
	})

	it('useUninstallLoop invalidates workspaceSkills and integrations', async () => {
		vi.mocked(api.installedLoops.uninstall).mockResolvedValue({ deleted: true })
		const { queryClient, wrapper } = makeWrapper()
		const { result } = renderHook(() => useUninstallLoop(workspaceId), { wrapper })

		result.current.mutate({ installedLoopId: 'inst-1', keepProvisionedItems: false })
		await waitFor(() => expect(result.current.isSuccess).toBe(true))

		expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
			queryKey: queryKeys.workspaceSkills.all(workspaceId),
		})
		expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
			queryKey: queryKeys.integrations.all(workspaceId),
		})
	})
})
