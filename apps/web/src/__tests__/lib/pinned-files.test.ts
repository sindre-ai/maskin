import type { WorkspaceResponse } from '@/lib/api'
import { getPinnedFileIds, isPinned, togglePinnedFile } from '@/lib/pinned-files'
import { describe, expect, it } from 'vitest'

function buildWorkspace(settings?: Record<string, unknown>): WorkspaceResponse {
	return {
		id: 'ws-1',
		name: 'Test',
		settings: settings ?? {},
		createdBy: null,
		createdAt: null,
		updatedAt: null,
	} as unknown as WorkspaceResponse
}

describe('pinned-files', () => {
	describe('getPinnedFileIds', () => {
		it('returns an empty list when no pinned_files key is present', () => {
			expect(getPinnedFileIds(buildWorkspace())).toEqual([])
			expect(getPinnedFileIds(undefined)).toEqual([])
			expect(getPinnedFileIds(null)).toEqual([])
		})

		it('returns the stored ids verbatim (references, never copies)', () => {
			const workspace = buildWorkspace({ pinned_files: ['file-1', 'file-2'] })
			expect(getPinnedFileIds(workspace)).toEqual(['file-1', 'file-2'])
		})

		it('degrades malformed values to an empty list instead of throwing', () => {
			expect(getPinnedFileIds(buildWorkspace({ pinned_files: 'not-an-array' }))).toEqual([])
			expect(getPinnedFileIds(buildWorkspace({ pinned_files: [1, 'file-1'] }))).toEqual(['file-1'])
		})
	})

	describe('togglePinnedFile', () => {
		it('pins a file id that is not yet pinned', () => {
			const ids = togglePinnedFile(buildWorkspace({ pinned_files: ['file-1'] }), 'file-2')
			expect(ids).toEqual(['file-1', 'file-2'])
		})

		it('unpins a file id that is already pinned', () => {
			const ids = togglePinnedFile(buildWorkspace({ pinned_files: ['file-1', 'file-2'] }), 'file-1')
			expect(ids).toEqual(['file-2'])
		})

		it('pins into an empty list when nothing is pinned yet', () => {
			expect(togglePinnedFile(buildWorkspace(), 'file-1')).toEqual(['file-1'])
		})
	})

	describe('isPinned', () => {
		it('is true only for ids present in the current workspace settings', () => {
			const workspace = buildWorkspace({ pinned_files: ['file-1'] })
			expect(isPinned(workspace, 'file-1')).toBe(true)
			expect(isPinned(workspace, 'file-2')).toBe(false)
		})
	})
})
