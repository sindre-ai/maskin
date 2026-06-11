import { renderHook, waitFor } from '@testing-library/react'
import { vi } from 'vitest'

vi.mock('@/lib/api', () => ({
	api: {
		integrations: {
			slackConversations: vi.fn(),
			slackUsers: vi.fn(),
		},
	},
}))

import { useSlackConversations, useSlackUsers } from '@/hooks/use-integrations'
import { api } from '@/lib/api'
import { TestWrapper } from '../setup'

describe('useSlackConversations', () => {
	beforeEach(() => {
		vi.mocked(api.integrations.slackConversations).mockReset()
	})

	it('is disabled when integrationId is undefined', () => {
		const { result } = renderHook(() => useSlackConversations(undefined, 'ws-1'), {
			wrapper: TestWrapper,
		})
		expect(result.current.isFetching).toBe(false)
		expect(api.integrations.slackConversations).not.toHaveBeenCalled()
	})

	it('fetches and returns conversations', async () => {
		vi.mocked(api.integrations.slackConversations).mockResolvedValue([
			{
				id: 'C1',
				name: 'general',
				is_private: false,
				is_im: false,
				is_mpim: false,
				is_channel: true,
			},
		])
		const { result } = renderHook(() => useSlackConversations('int-1', 'ws-1'), {
			wrapper: TestWrapper,
		})
		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(result.current.data).toHaveLength(1)
		expect(api.integrations.slackConversations).toHaveBeenCalledWith('int-1', 'ws-1', [
			'public_channel',
			'private_channel',
			'im',
			'mpim',
		])
	})

	it('forwards a custom types list', async () => {
		vi.mocked(api.integrations.slackConversations).mockResolvedValue([])
		const { result } = renderHook(
			() => useSlackConversations('int-1', 'ws-1', ['public_channel']),
			{ wrapper: TestWrapper },
		)
		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(api.integrations.slackConversations).toHaveBeenCalledWith('int-1', 'ws-1', [
			'public_channel',
		])
	})
})

describe('useSlackUsers', () => {
	beforeEach(() => {
		vi.mocked(api.integrations.slackUsers).mockReset()
	})

	it('is disabled when integrationId is undefined', () => {
		const { result } = renderHook(() => useSlackUsers(undefined, 'ws-1'), {
			wrapper: TestWrapper,
		})
		expect(result.current.isFetching).toBe(false)
		expect(api.integrations.slackUsers).not.toHaveBeenCalled()
	})

	it('fetches and returns users', async () => {
		vi.mocked(api.integrations.slackUsers).mockResolvedValue([
			{ id: 'U1', name: 'alice', real_name: 'Alice', is_bot: false },
		])
		const { result } = renderHook(() => useSlackUsers('int-1', 'ws-1'), {
			wrapper: TestWrapper,
		})
		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(result.current.data).toHaveLength(1)
	})
})
