import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({
	api: {
		workspaceSkills: {
			listForActor: vi.fn(),
			attach: vi.fn(),
			detach: vi.fn(),
		},
	},
}))

import {
	useAgentSkillAttachments,
	useAttachSkill,
	useDetachSkill,
} from '@/hooks/use-agent-skill-attachments'
import { api } from '@/lib/api'
import { TestWrapper } from '../setup'

const attached = {
	id: '11111111-1111-1111-1111-111111111111',
	workspaceId: 'ws-1',
	name: 'my-skill',
	description: 'A skill',
	storageKey: 'workspaces/ws-1/skills/my-skill/SKILL.md',
	sizeBytes: 200,
	isValid: true,
	createdBy: '22222222-2222-2222-2222-222222222222',
	createdAt: '2026-04-23T00:00:00Z',
	updatedAt: '2026-04-23T00:00:00Z',
	attachedAt: '2026-04-23T01:00:00Z',
}

describe('use-agent-skill-attachments', () => {
	beforeEach(() => vi.clearAllMocks())

	describe('useAgentSkillAttachments', () => {
		it('fetches workspace skills attached to an actor', async () => {
			vi.mocked(api.workspaceSkills.listForActor).mockResolvedValue([attached])

			const { result } = renderHook(() => useAgentSkillAttachments('actor-1'), {
				wrapper: TestWrapper,
			})

			await waitFor(() => expect(result.current.isSuccess).toBe(true))
			expect(result.current.data).toEqual([attached])
			expect(api.workspaceSkills.listForActor).toHaveBeenCalledWith('actor-1')
		})

		it('is disabled when actorId is falsy', () => {
			const { result } = renderHook(() => useAgentSkillAttachments(''), {
				wrapper: TestWrapper,
			})

			expect(result.current.isFetching).toBe(false)
			expect(api.workspaceSkills.listForActor).not.toHaveBeenCalled()
		})
	})

	describe('useAttachSkill', () => {
		it('attaches a workspace skill to an actor', async () => {
			vi.mocked(api.workspaceSkills.attach).mockResolvedValue(attached)

			const { result } = renderHook(() => useAttachSkill('actor-1'), {
				wrapper: TestWrapper,
			})

			result.current.mutate(attached.id)

			await waitFor(() => expect(result.current.isSuccess).toBe(true))
			expect(api.workspaceSkills.attach).toHaveBeenCalledWith('actor-1', attached.id)
		})

		it('surfaces errors', async () => {
			vi.mocked(api.workspaceSkills.attach).mockRejectedValue(new Error('forbidden'))

			const { result } = renderHook(() => useAttachSkill('actor-1'), {
				wrapper: TestWrapper,
			})

			result.current.mutate(attached.id)

			await waitFor(() => expect(result.current.isError).toBe(true))
			expect(result.current.error?.message).toBe('forbidden')
		})
	})

	describe('useDetachSkill', () => {
		it('detaches a workspace skill from an actor', async () => {
			vi.mocked(api.workspaceSkills.detach).mockResolvedValue({ deleted: true })

			const { result } = renderHook(() => useDetachSkill('actor-1'), {
				wrapper: TestWrapper,
			})

			result.current.mutate(attached.id)

			await waitFor(() => expect(result.current.isSuccess).toBe(true))
			expect(api.workspaceSkills.detach).toHaveBeenCalledWith('actor-1', attached.id)
		})
	})
})
