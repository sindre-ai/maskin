import { renderHook, waitFor } from '@testing-library/react'
import { vi } from 'vitest'

vi.mock('@/lib/api', () => ({
	api: {
		skills: {
			list: vi.fn(),
			get: vi.fn(),
			save: vi.fn(),
			delete: vi.fn(),
		},
	},
}))

import { api } from '@/lib/api'
import { useSkills, useSkill, useSaveSkill, useDeleteSkill } from '@/hooks/use-skills'
import { TestWrapper } from '../setup'

describe('useSkills', () => {
	beforeEach(() => vi.clearAllMocks())

	describe('useSkills', () => {
		it('returns skills for actor and workspace', async () => {
			const skills = [
				{ name: 'skill-1', content: 'Do something' },
				{ name: 'skill-2', content: 'Do something else' },
			]
			vi.mocked(api.skills.list).mockResolvedValue(skills)

			const { result } = renderHook(() => useSkills('actor-1', 'ws-1'), {
				wrapper: TestWrapper,
			})

			await waitFor(() => expect(result.current.isSuccess).toBe(true))
			expect(result.current.data).toEqual(skills)
			expect(api.skills.list).toHaveBeenCalledWith('actor-1', 'ws-1')
		})

		it('is disabled when actorId is falsy', () => {
			const { result } = renderHook(() => useSkills('', 'ws-1'), {
				wrapper: TestWrapper,
			})

			expect(result.current.isFetching).toBe(false)
			expect(api.skills.list).not.toHaveBeenCalled()
		})

		it('is disabled when workspaceId is falsy', () => {
			const { result } = renderHook(() => useSkills('actor-1', ''), {
				wrapper: TestWrapper,
			})

			expect(result.current.isFetching).toBe(false)
			expect(api.skills.list).not.toHaveBeenCalled()
		})

		it('handles error', async () => {
			vi.mocked(api.skills.list).mockRejectedValue(new Error('Failed to fetch'))

			const { result } = renderHook(() => useSkills('actor-1', 'ws-1'), {
				wrapper: TestWrapper,
			})

			await waitFor(() => expect(result.current.isError).toBe(true))
			expect(result.current.error?.message).toBe('Failed to fetch')
		})
	})

	describe('useSkill', () => {
		it('returns a single skill', async () => {
			const skill = { name: 'skill-1', content: 'Do something' }
			vi.mocked(api.skills.get).mockResolvedValue(skill)

			const { result } = renderHook(() => useSkill('actor-1', 'skill-1', 'ws-1'), {
				wrapper: TestWrapper,
			})

			await waitFor(() => expect(result.current.isSuccess).toBe(true))
			expect(result.current.data).toEqual(skill)
			expect(api.skills.get).toHaveBeenCalledWith('actor-1', 'skill-1', 'ws-1')
		})

		it('is disabled when skillName is null', () => {
			const { result } = renderHook(() => useSkill('actor-1', null, 'ws-1'), {
				wrapper: TestWrapper,
			})

			expect(result.current.isFetching).toBe(false)
			expect(api.skills.get).not.toHaveBeenCalled()
		})

		it('is disabled when actorId is falsy', () => {
			const { result } = renderHook(() => useSkill('', 'skill-1', 'ws-1'), {
				wrapper: TestWrapper,
			})

			expect(result.current.isFetching).toBe(false)
			expect(api.skills.get).not.toHaveBeenCalled()
		})

		it('handles error', async () => {
			vi.mocked(api.skills.get).mockRejectedValue(new Error('Skill not found'))

			const { result } = renderHook(() => useSkill('actor-1', 'skill-1', 'ws-1'), {
				wrapper: TestWrapper,
			})

			await waitFor(() => expect(result.current.isError).toBe(true))
			expect(result.current.error?.message).toBe('Skill not found')
		})
	})

	describe('useSaveSkill', () => {
		it('saves a skill', async () => {
			const saved = { name: 'skill-1', content: 'Updated content' }
			vi.mocked(api.skills.save).mockResolvedValue(saved)

			const { result } = renderHook(() => useSaveSkill('actor-1', 'ws-1'), {
				wrapper: TestWrapper,
			})

			result.current.mutate({ skillName: 'skill-1', data: { content: 'Updated content' } })

			await waitFor(() => expect(result.current.isSuccess).toBe(true))
			expect(api.skills.save).toHaveBeenCalledWith(
				'actor-1',
				'skill-1',
				{ content: 'Updated content' },
				'ws-1',
			)
		})

		it('handles save error', async () => {
			vi.mocked(api.skills.save).mockRejectedValue(new Error('Save failed'))

			const { result } = renderHook(() => useSaveSkill('actor-1', 'ws-1'), {
				wrapper: TestWrapper,
			})

			result.current.mutate({ skillName: 'skill-1', data: { content: 'content' } })

			await waitFor(() => expect(result.current.isError).toBe(true))
			expect(result.current.error?.message).toBe('Save failed')
		})
	})

	describe('useDeleteSkill', () => {
		it('deletes a skill', async () => {
			vi.mocked(api.skills.delete).mockResolvedValue(undefined)

			const { result } = renderHook(() => useDeleteSkill('actor-1', 'ws-1'), {
				wrapper: TestWrapper,
			})

			result.current.mutate('skill-1')

			await waitFor(() => expect(result.current.isSuccess).toBe(true))
			expect(api.skills.delete).toHaveBeenCalledWith('actor-1', 'skill-1', 'ws-1')
		})

		it('handles delete error', async () => {
			vi.mocked(api.skills.delete).mockRejectedValue(new Error('Delete failed'))

			const { result } = renderHook(() => useDeleteSkill('actor-1', 'ws-1'), {
				wrapper: TestWrapper,
			})

			result.current.mutate('skill-1')

			await waitFor(() => expect(result.current.isError).toBe(true))
			expect(result.current.error?.message).toBe('Delete failed')
		})
	})
})
