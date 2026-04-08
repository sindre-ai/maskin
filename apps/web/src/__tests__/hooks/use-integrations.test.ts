import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({
	api: {
		integrations: {
			list: vi.fn(),
			providers: vi.fn(),
			disconnect: vi.fn(),
		},
	},
}))

vi.mock('sonner', () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}))

import { useDisconnectIntegration, useIntegrations, useProviders } from '@/hooks/use-integrations'
import type { IntegrationResponse, ProviderInfo } from '@/lib/api'
import { api } from '@/lib/api'
import { toast } from 'sonner'
import { TestWrapper } from '../setup'

function buildIntegration(
	overrides: Partial<IntegrationResponse> & { id: string },
): IntegrationResponse {
	return {
		workspaceId: 'ws-1',
		provider: 'github',
		status: 'connected',
		externalId: null,
		config: {},
		createdBy: 'actor-1',
		createdAt: null,
		updatedAt: null,
		...overrides,
	}
}

describe('useIntegrations', () => {
	beforeEach(() => vi.clearAllMocks())

	describe('useIntegrations', () => {
		it('returns integrations for workspace', async () => {
			const integrations = [
				buildIntegration({ id: 'int-1', provider: 'github' }),
				buildIntegration({ id: 'int-2', provider: 'slack' }),
			]
			vi.mocked(api.integrations.list).mockResolvedValue(integrations)

			const { result } = renderHook(() => useIntegrations('ws-1'), {
				wrapper: TestWrapper,
			})

			await waitFor(() => expect(result.current.isSuccess).toBe(true))
			expect(result.current.data).toEqual(integrations)
			expect(api.integrations.list).toHaveBeenCalledWith('ws-1')
		})

		it('handles error', async () => {
			vi.mocked(api.integrations.list).mockRejectedValue(new Error('Failed to fetch'))

			const { result } = renderHook(() => useIntegrations('ws-1'), {
				wrapper: TestWrapper,
			})

			await waitFor(() => expect(result.current.isError).toBe(true))
			expect(result.current.error?.message).toBe('Failed to fetch')
		})
	})

	describe('useProviders', () => {
		it('returns available providers', async () => {
			const providers: ProviderInfo[] = [
				{ name: 'github', displayName: 'GitHub', authType: 'oauth2_custom', events: [] },
				{ name: 'slack', displayName: 'Slack', authType: 'oauth2', events: [] },
			]
			vi.mocked(api.integrations.providers).mockResolvedValue(providers)

			const { result } = renderHook(() => useProviders(), {
				wrapper: TestWrapper,
			})

			await waitFor(() => expect(result.current.isSuccess).toBe(true))
			expect(result.current.data).toEqual(providers)
			expect(api.integrations.providers).toHaveBeenCalled()
		})

		it('handles error', async () => {
			vi.mocked(api.integrations.providers).mockRejectedValue(new Error('Failed to fetch'))

			const { result } = renderHook(() => useProviders(), {
				wrapper: TestWrapper,
			})

			await waitFor(() => expect(result.current.isError).toBe(true))
			expect(result.current.error?.message).toBe('Failed to fetch')
		})
	})

	describe('useDisconnectIntegration', () => {
		it('disconnects an integration and shows toast', async () => {
			vi.mocked(api.integrations.disconnect).mockResolvedValue({ deleted: true })

			const { result } = renderHook(() => useDisconnectIntegration('ws-1'), {
				wrapper: TestWrapper,
			})

			result.current.mutate('int-1')

			await waitFor(() => expect(result.current.isSuccess).toBe(true))
			expect(api.integrations.disconnect).toHaveBeenCalledWith('int-1', 'ws-1')
			expect(toast.success).toHaveBeenCalledWith('Integration disconnected')
		})

		it('handles disconnect error', async () => {
			vi.mocked(api.integrations.disconnect).mockRejectedValue(new Error('Disconnect failed'))

			const { result } = renderHook(() => useDisconnectIntegration('ws-1'), {
				wrapper: TestWrapper,
			})

			result.current.mutate('int-1')

			await waitFor(() => expect(result.current.isError).toBe(true))
			expect(result.current.error?.message).toBe('Disconnect failed')
		})
	})
})
