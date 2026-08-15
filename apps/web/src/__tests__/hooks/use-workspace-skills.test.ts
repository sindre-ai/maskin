import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({
	api: {
		workspaceSkills: {
			list: vi.fn(),
			get: vi.fn(),
			create: vi.fn(),
			update: vi.fn(),
			delete: vi.fn(),
			upload: vi.fn(),
			listFiles: vi.fn(),
		},
	},
}))

import {
	useCreateWorkspaceSkill,
	useDeleteWorkspaceSkill,
	useUpdateWorkspaceSkill,
	useUploadWorkspaceSkill,
	useWorkspaceSkill,
	useWorkspaceSkillFiles,
	useWorkspaceSkills,
} from '@/hooks/use-workspace-skills'
import { api } from '@/lib/api'
import { TestWrapper } from '../setup'

const skillListItem = {
	id: '11111111-1111-1111-1111-111111111111',
	workspaceId: 'ws-1',
	name: 'my-skill',
	description: 'A helpful skill',
	storageKey: 'workspaces/ws-1/skills/my-skill/SKILL.md',
	sizeBytes: 128,
	isValid: true,
	isFolder: false,
	fileCount: null,
	createdBy: '22222222-2222-2222-2222-222222222222',
	createdAt: '2026-04-23T00:00:00Z',
	updatedAt: '2026-04-23T00:00:00Z',
}

const skillDetail = {
	...skillListItem,
	content: '---\nname: my-skill\ndescription: A helpful skill\n---\n\nDo things.',
}

describe('use-workspace-skills', () => {
	beforeEach(() => vi.clearAllMocks())

	describe('useWorkspaceSkills', () => {
		it('returns skills for a workspace', async () => {
			vi.mocked(api.workspaceSkills.list).mockResolvedValue([skillListItem])

			const { result } = renderHook(() => useWorkspaceSkills('ws-1'), { wrapper: TestWrapper })

			await waitFor(() => expect(result.current.isSuccess).toBe(true))
			expect(result.current.data).toEqual([skillListItem])
			expect(api.workspaceSkills.list).toHaveBeenCalledWith('ws-1')
		})

		it('is disabled when workspaceId is falsy', () => {
			const { result } = renderHook(() => useWorkspaceSkills(''), { wrapper: TestWrapper })

			expect(result.current.isFetching).toBe(false)
			expect(api.workspaceSkills.list).not.toHaveBeenCalled()
		})

		it('handles error', async () => {
			vi.mocked(api.workspaceSkills.list).mockRejectedValue(new Error('boom'))

			const { result } = renderHook(() => useWorkspaceSkills('ws-1'), { wrapper: TestWrapper })

			await waitFor(() => expect(result.current.isError).toBe(true))
			expect(result.current.error?.message).toBe('boom')
		})
	})

	describe('useWorkspaceSkill', () => {
		it('returns a single skill with content', async () => {
			vi.mocked(api.workspaceSkills.get).mockResolvedValue(skillDetail)

			const { result } = renderHook(() => useWorkspaceSkill('ws-1', 'my-skill'), {
				wrapper: TestWrapper,
			})

			await waitFor(() => expect(result.current.isSuccess).toBe(true))
			expect(result.current.data).toEqual(skillDetail)
			expect(api.workspaceSkills.get).toHaveBeenCalledWith('ws-1', 'my-skill')
		})

		it('is disabled when name is null', () => {
			const { result } = renderHook(() => useWorkspaceSkill('ws-1', null), {
				wrapper: TestWrapper,
			})

			expect(result.current.isFetching).toBe(false)
			expect(api.workspaceSkills.get).not.toHaveBeenCalled()
		})
	})

	describe('useCreateWorkspaceSkill', () => {
		it('creates a workspace skill', async () => {
			vi.mocked(api.workspaceSkills.create).mockResolvedValue(skillDetail)

			const { result } = renderHook(() => useCreateWorkspaceSkill('ws-1'), {
				wrapper: TestWrapper,
			})

			result.current.mutate({ name: 'my-skill', content: skillDetail.content })

			await waitFor(() => expect(result.current.isSuccess).toBe(true))
			expect(api.workspaceSkills.create).toHaveBeenCalledWith('ws-1', {
				name: 'my-skill',
				content: skillDetail.content,
			})
		})

		it('surfaces errors', async () => {
			vi.mocked(api.workspaceSkills.create).mockRejectedValue(new Error('conflict'))

			const { result } = renderHook(() => useCreateWorkspaceSkill('ws-1'), {
				wrapper: TestWrapper,
			})

			result.current.mutate({ name: 'dup', content: 'x' })

			await waitFor(() => expect(result.current.isError).toBe(true))
			expect(result.current.error?.message).toBe('conflict')
		})
	})

	describe('useUpdateWorkspaceSkill', () => {
		it('updates a workspace skill', async () => {
			vi.mocked(api.workspaceSkills.update).mockResolvedValue({
				...skillDetail,
				content: 'new',
			})

			const { result } = renderHook(() => useUpdateWorkspaceSkill('ws-1'), {
				wrapper: TestWrapper,
			})

			result.current.mutate({ name: 'my-skill', data: { content: 'new' } })

			await waitFor(() => expect(result.current.isSuccess).toBe(true))
			expect(api.workspaceSkills.update).toHaveBeenCalledWith('ws-1', 'my-skill', {
				content: 'new',
			})
		})

		it('renames a workspace skill via the name field', async () => {
			vi.mocked(api.workspaceSkills.update).mockResolvedValue({
				...skillDetail,
				name: 'renamed',
			})

			const { result } = renderHook(() => useUpdateWorkspaceSkill('ws-1'), {
				wrapper: TestWrapper,
			})

			result.current.mutate({
				name: 'my-skill',
				data: { name: 'renamed', content: skillDetail.content },
				newName: 'renamed',
			})

			await waitFor(() => expect(result.current.isSuccess).toBe(true))
			expect(api.workspaceSkills.update).toHaveBeenCalledWith('ws-1', 'my-skill', {
				name: 'renamed',
				content: skillDetail.content,
			})
		})
	})

	describe('useDeleteWorkspaceSkill', () => {
		it('deletes a workspace skill', async () => {
			vi.mocked(api.workspaceSkills.delete).mockResolvedValue({ deleted: true })

			const { result } = renderHook(() => useDeleteWorkspaceSkill('ws-1'), {
				wrapper: TestWrapper,
			})

			result.current.mutate('my-skill')

			await waitFor(() => expect(result.current.isSuccess).toBe(true))
			expect(api.workspaceSkills.delete).toHaveBeenCalledWith('ws-1', 'my-skill')
		})
	})

	describe('useUploadWorkspaceSkill', () => {
		it('forwards the file without a skillId on first upload', async () => {
			const result = { ...skillListItem, isFolder: true, fileCount: 3, content: '', error: null }
			vi.mocked(api.workspaceSkills.upload).mockResolvedValue(result)

			const { result: hook } = renderHook(() => useUploadWorkspaceSkill('ws-1'), {
				wrapper: TestWrapper,
			})

			const file = new File(['zip'], 'docx.zip', { type: 'application/zip' })
			hook.current.mutate({ file })

			await waitFor(() => expect(hook.current.isSuccess).toBe(true))
			expect(api.workspaceSkills.upload).toHaveBeenCalledWith('ws-1', file, undefined)
		})

		it('passes skillId through as a replace flow', async () => {
			const result = { ...skillListItem, isFolder: true, fileCount: 3, content: '', error: null }
			vi.mocked(api.workspaceSkills.upload).mockResolvedValue(result)

			const { result: hook } = renderHook(() => useUploadWorkspaceSkill('ws-1'), {
				wrapper: TestWrapper,
			})

			const file = new File(['zip'], 'docx.zip', { type: 'application/zip' })
			hook.current.mutate({ file, skillId: 'skill-42' })

			await waitFor(() => expect(hook.current.isSuccess).toBe(true))
			expect(api.workspaceSkills.upload).toHaveBeenCalledWith('ws-1', file, { skillId: 'skill-42' })
		})
	})

	describe('useWorkspaceSkillFiles', () => {
		it('fetches files when enabled and skillId are set', async () => {
			const entries = [{ relativePath: 'SKILL.md', sizeBytes: 100 }]
			vi.mocked(api.workspaceSkills.listFiles).mockResolvedValue(entries)

			const { result } = renderHook(() => useWorkspaceSkillFiles('ws-1', 'skill-42', true), {
				wrapper: TestWrapper,
			})

			await waitFor(() => expect(result.current.isSuccess).toBe(true))
			expect(result.current.data).toEqual(entries)
			expect(api.workspaceSkills.listFiles).toHaveBeenCalledWith('ws-1', 'skill-42')
		})

		it('does not fetch when disabled', () => {
			renderHook(() => useWorkspaceSkillFiles('ws-1', 'skill-42', false), {
				wrapper: TestWrapper,
			})

			expect(api.workspaceSkills.listFiles).not.toHaveBeenCalled()
		})

		it('does not fetch when skillId is null', () => {
			renderHook(() => useWorkspaceSkillFiles('ws-1', null, true), { wrapper: TestWrapper })

			expect(api.workspaceSkills.listFiles).not.toHaveBeenCalled()
		})
	})
})
