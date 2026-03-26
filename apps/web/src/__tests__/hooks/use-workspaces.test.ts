import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({
	api: {
		workspaces: {
			list: vi.fn(),
			update: vi.fn(),
			members: {
				list: vi.fn(),
				add: vi.fn(),
			},
		},
	},
}))

import { api } from '@/lib/api'
import {
	useAddWorkspaceMember,
	useUpdateWorkspace,
	useWorkspaceMembers,
	useWorkspaces,
} from '@/hooks/use-workspaces'
import { TestWrapper } from '../setup'

const workspaceId = 'ws-1'

beforeEach(() => {
	vi.clearAllMocks()
})

describe('useWorkspaces', () => {
	it('exposes error when API rejects', async () => {
		vi.mocked(api.workspaces.list).mockRejectedValue(new Error('Unauthorized'))

		const { result } = renderHook(() => useWorkspaces(), { wrapper: TestWrapper })

		await waitFor(() => expect(result.current.isError).toBe(true))
		expect(result.current.error).toBeInstanceOf(Error)
		expect(result.current.error!.message).toBe('Unauthorized')
	})

	it('fetches workspaces', async () => {
		const mockWorkspaces = [
			{ id: 'ws-1', name: 'Workspace 1' },
			{ id: 'ws-2', name: 'Workspace 2' },
		]
		vi.mocked(api.workspaces.list).mockResolvedValue(mockWorkspaces)

		const { result } = renderHook(() => useWorkspaces(), { wrapper: TestWrapper })

		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(result.current.data).toEqual(mockWorkspaces)
		expect(api.workspaces.list).toHaveBeenCalled()
	})
})

describe('useUpdateWorkspace', () => {
	it('exposes error when update fails', async () => {
		vi.mocked(api.workspaces.update).mockRejectedValue(new Error('Bad request'))

		const { result } = renderHook(() => useUpdateWorkspace(workspaceId), { wrapper: TestWrapper })

		result.current.mutate({ name: 'Nope' })
		await waitFor(() => expect(result.current.isError).toBe(true))
		expect(result.current.error!.message).toBe('Bad request')
	})

	it('calls api.workspaces.update', async () => {
		vi.mocked(api.workspaces.update).mockResolvedValue({ id: workspaceId, name: 'Updated' })

		const { result } = renderHook(() => useUpdateWorkspace(workspaceId), { wrapper: TestWrapper })

		result.current.mutate({ name: 'Updated' })
		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(api.workspaces.update).toHaveBeenCalledWith(workspaceId, { name: 'Updated' })
	})
})

describe('useWorkspaceMembers', () => {
	it('exposes error when fetch fails', async () => {
		vi.mocked(api.workspaces.members.list).mockRejectedValue(new Error('Not found'))

		const { result } = renderHook(() => useWorkspaceMembers(workspaceId), { wrapper: TestWrapper })

		await waitFor(() => expect(result.current.isError).toBe(true))
		expect(result.current.error!.message).toBe('Not found')
	})

	it('fetches members for workspace', async () => {
		const mockMembers = [{ actorId: 'a-1', role: 'owner' }]
		vi.mocked(api.workspaces.members.list).mockResolvedValue(mockMembers)

		const { result } = renderHook(() => useWorkspaceMembers(workspaceId), { wrapper: TestWrapper })

		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(result.current.data).toEqual(mockMembers)
		expect(api.workspaces.members.list).toHaveBeenCalledWith(workspaceId)
	})
})

describe('useAddWorkspaceMember', () => {
	it('exposes error when add fails', async () => {
		vi.mocked(api.workspaces.members.add).mockRejectedValue(new Error('Conflict'))

		const { result } = renderHook(() => useAddWorkspaceMember(workspaceId), { wrapper: TestWrapper })

		result.current.mutate({ actor_id: 'a-2' })
		await waitFor(() => expect(result.current.isError).toBe(true))
		expect(result.current.error!.message).toBe('Conflict')
	})

	it('calls api.workspaces.members.add', async () => {
		vi.mocked(api.workspaces.members.add).mockResolvedValue({ actorId: 'a-2', role: 'member' })

		const { result } = renderHook(() => useAddWorkspaceMember(workspaceId), { wrapper: TestWrapper })

		result.current.mutate({ actor_id: 'a-2' })
		await waitFor(() => expect(result.current.isSuccess).toBe(true))
		expect(api.workspaces.members.add).toHaveBeenCalledWith(workspaceId, { actor_id: 'a-2' })
	})
})
