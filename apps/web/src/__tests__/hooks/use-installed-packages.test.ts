import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({
	api: {
		installedPackages: {
			list: vi.fn(),
			install: vi.fn(),
			fork: vi.fn(),
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
} from '@/hooks/use-installed-packages'
import { api } from '@/lib/api'
import { toast } from 'sonner'
import { TestWrapper } from '../setup'

const workspaceId = 'ws-1'

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
