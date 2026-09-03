import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({
	api: {
		files: { create: vi.fn(), delete: vi.fn() },
		relationships: { create: vi.fn(), list: vi.fn() },
	},
}))

vi.mock('@/lib/file-utils', () => ({
	readFileAsBase64: vi.fn(async () => 'YmFzZTY0'),
}))

vi.mock('sonner', () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}))

import { useObjectFileAttachments } from '@/hooks/use-object-file-attachments'
import { api } from '@/lib/api'
import { toast } from 'sonner'
import { TestWrapper } from '../setup'

function file(name: string) {
	return new File(['x'], name, { type: 'text/plain' })
}

function mount() {
	return renderHook(
		() => useObjectFileAttachments({ workspaceId: 'ws-1', objectId: 'o-1', objectType: 'bet' }),
		{ wrapper: TestWrapper },
	)
}

describe('useObjectFileAttachments', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.mocked(api.files.create).mockImplementation(
			async (_ws, data) => ({ id: `f-${data.name}` }) as never,
		)
		vi.mocked(api.relationships.create).mockResolvedValue({ id: 'r-1' } as never)
		vi.mocked(api.files.delete).mockResolvedValue({ deleted: true } as never)
	})

	it('attaches every uploaded file to the object', async () => {
		const { result } = mount()
		await act(() => result.current.upload([file('a.md'), file('b.md')]))

		await waitFor(() => expect(api.relationships.create).toHaveBeenCalledTimes(2))
		expect(vi.mocked(api.relationships.create).mock.calls[0][1]).toMatchObject({
			source_id: 'o-1',
			source_type: 'bet',
			target_type: 'file',
			target_id: 'f-a.md',
			type: 'attached',
		})
	})

	it('keeps uploading the remaining files when one fails', async () => {
		vi.mocked(api.files.create).mockImplementation(async (_ws, data) => {
			if (data.name === 'b.md') throw new Error('boom')
			return { id: `f-${data.name}` } as never
		})

		const { result } = mount()
		await act(() => result.current.upload([file('a.md'), file('b.md'), file('c.md')]))

		// The third file is the point: a single try/catch around the loop would
		// have abandoned it without telling anyone.
		expect(api.files.create).toHaveBeenCalledTimes(3)
		expect(toast.success).toHaveBeenCalledWith('Uploaded a.md')
		expect(toast.success).toHaveBeenCalledWith('Uploaded c.md')
		expect(toast.error).toHaveBeenCalledWith('Failed to upload b.md')
	})

	it('names every failure when more than one file fails', async () => {
		vi.mocked(api.files.create).mockRejectedValue(new Error('boom'))

		const { result } = mount()
		await act(() => result.current.upload([file('a.md'), file('b.md')]))

		expect(toast.error).toHaveBeenCalledWith('Failed to upload 2 files: a.md, b.md')
	})

	it('deletes the orphaned file row when the attach edge fails', async () => {
		vi.mocked(api.relationships.create).mockRejectedValue(new Error('boom'))

		const { result } = mount()
		await act(() => result.current.upload([file('a.md')]))

		// Otherwise the file exists in the workspace, attached to nothing, while
		// the user is told the upload failed.
		expect(api.files.delete).toHaveBeenCalledWith('ws-1', 'f-a.md')
	})

	it('clears isUploading after a failed run', async () => {
		vi.mocked(api.files.create).mockRejectedValue(new Error('boom'))

		const { result } = mount()
		await act(() => result.current.upload([file('a.md')]))

		await waitFor(() => expect(result.current.isUploading).toBe(false))
	})
})
