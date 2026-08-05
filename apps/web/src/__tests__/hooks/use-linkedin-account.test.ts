import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({
	api: {
		linkedin: {
			account: vi.fn(),
			connect: vi.fn(),
		},
	},
}))

vi.mock('sonner', () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}))

import { useConnectLinkedin, useLinkedinAccount } from '@/hooks/use-linkedin-account'
import { api } from '@/lib/api'
import { TestWrapper } from '../setup'

const workspaceId = '00000000-0000-0000-0000-000000000001'
const agentId = '11111111-1111-1111-1111-111111111111'

beforeEach(() => {
	vi.clearAllMocks()
})

describe('useLinkedinAccount', () => {
	it('returns null when no account is connected', async () => {
		vi.mocked(api.linkedin.account).mockResolvedValueOnce(null)
		const { result } = renderHook(() => useLinkedinAccount(workspaceId), { wrapper: TestWrapper })
		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(result.current.data).toBeNull()
	})

	it('returns the account when one is connected', async () => {
		vi.mocked(api.linkedin.account).mockResolvedValueOnce({
			id: 'acc-1',
			workspaceId,
			state: 'syncing',
			unipileAccountId: 'unipile-1',
			sendingAsName: 'sindre',
			sendingAsProviderId: 'urn:li:1',
			connectedAt: null,
			createdAt: null,
			updatedAt: null,
			pacing: {
				dailyCap: 0,
				dailySent: 0,
				weeklyCap: 0,
				weeklySent: 0,
				warmup: null,
			},
			acceptanceRate: null,
		})
		const { result } = renderHook(() => useLinkedinAccount(workspaceId), { wrapper: TestWrapper })
		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(result.current.data?.state).toBe('syncing')
		expect(result.current.data?.sendingAsName).toBe('sindre')
	})

	it('exposes the pacing snapshot for a healthy account', async () => {
		vi.mocked(api.linkedin.account).mockResolvedValueOnce({
			id: 'acc-1',
			workspaceId,
			state: 'healthy',
			unipileAccountId: 'unipile-1',
			sendingAsName: 'Sebastian Bakke',
			sendingAsProviderId: 'urn:li:1',
			connectedAt: '2026-07-10T12:00:00.000Z',
			createdAt: null,
			updatedAt: null,
			pacing: {
				dailyCap: 20,
				dailySent: 4,
				weeklyCap: 80,
				weeklySent: 18,
				warmup: null,
			},
			acceptanceRate: 0.62,
		})
		const { result } = renderHook(() => useLinkedinAccount(workspaceId), { wrapper: TestWrapper })
		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(result.current.data?.pacing.dailyCap).toBe(20)
		expect(result.current.data?.pacing.weeklyCap).toBe(80)
		expect(result.current.data?.acceptanceRate).toBe(0.62)
	})
})

describe('useConnectLinkedin', () => {
	function stubWindowLocation() {
		const original = window.location
		const assignHref = vi.fn()
		Object.defineProperty(window, 'location', {
			writable: true,
			value: {
				...original,
				set href(v: string) {
					assignHref(v)
				},
			},
		})
		return {
			assignHref,
			restore: () => Object.defineProperty(window, 'location', { writable: true, value: original }),
		}
	}

	it('redirects to the Unipile URL and forwards agentId on the agent-page connect flow', async () => {
		vi.mocked(api.linkedin.connect).mockResolvedValueOnce({
			url: 'https://account.unipile.com/link/abc',
		})
		const { assignHref, restore } = stubWindowLocation()

		const { result } = renderHook(() => useConnectLinkedin(workspaceId), { wrapper: TestWrapper })
		result.current.mutate({ agentId })

		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(assignHref).toHaveBeenCalledWith('https://account.unipile.com/link/abc')
		expect(api.linkedin.connect).toHaveBeenCalledWith(workspaceId, { agentId })

		restore()
	})

	it('forwards returnPath when called from Settings › Integrations (T5 round-trip)', async () => {
		vi.mocked(api.linkedin.connect).mockResolvedValueOnce({
			url: 'https://account.unipile.com/link/xyz',
		})
		const { assignHref, restore } = stubWindowLocation()

		const { result } = renderHook(() => useConnectLinkedin(workspaceId), { wrapper: TestWrapper })
		result.current.mutate({ returnPath: `/${workspaceId}/settings/integrations` })

		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(assignHref).toHaveBeenCalledWith('https://account.unipile.com/link/xyz')
		expect(api.linkedin.connect).toHaveBeenCalledWith(workspaceId, {
			returnPath: `/${workspaceId}/settings/integrations`,
		})

		restore()
	})
})
