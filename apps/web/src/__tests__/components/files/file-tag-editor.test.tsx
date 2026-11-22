import { FileTagEditorButton } from '@/components/files/file-tags'
import type { FileDetail } from '@/lib/api'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mutate = vi.fn()

vi.mock('@/hooks/use-can-write', () => ({ useCanWrite: () => true }))
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }))
vi.mock('@/hooks/use-files', () => ({
	useFileTags: () => ({
		data: [
			{ tag: 'alpha', count: 3 },
			{ tag: 'beta', count: 2 },
			{ tag: 'gamma', count: 1 },
		],
	}),
	useUpdateFile: () => ({ mutate, isPending: false }),
}))

function buildFile(overrides: Partial<FileDetail> = {}): FileDetail {
	return {
		id: 'file-1',
		workspaceId: 'ws-1',
		name: 'notes.md',
		description: null,
		tags: [],
		mimeType: 'text/markdown',
		sizeBytes: 10,
		storageKey: 'ws-1/notes.md',
		createdBy: 'actor-1',
		createdAt: '2026-08-01T00:00:00Z',
		updatedAt: '2026-08-01T00:00:00Z',
		content: 'hi',
		encoding: 'utf8',
		url: 'http://localhost/files/file-1',
		annotations: [],
		...overrides,
	}
}

function openEditor(file = buildFile()) {
	render(<FileTagEditorButton file={file} />)
	fireEvent.click(screen.getByRole('button', { name: 'Add tag' }))
	return screen.getByRole('textbox', { name: 'Tag name' })
}

describe('FileTagEditorButton keyboard', () => {
	beforeEach(() => mutate.mockClear())

	it('ArrowDown moves the highlight and Enter adds the highlighted tag', () => {
		const input = openEditor()
		fireEvent.keyDown(input, { key: 'ArrowDown' })
		fireEvent.keyDown(input, { key: 'ArrowDown' })
		expect(input).toHaveAttribute(
			'aria-activedescendant',
			screen.getByText('beta').closest('button')?.id,
		)
		fireEvent.submit(input.closest('form') as HTMLFormElement)
		expect(mutate).toHaveBeenCalledWith({ id: 'file-1', data: { tags: ['beta'] } })
	})

	it('ArrowUp from the input starts at the last tag and wraps from the first', () => {
		const input = openEditor()
		fireEvent.keyDown(input, { key: 'ArrowUp' })
		expect(input).toHaveAttribute(
			'aria-activedescendant',
			screen.getByText('gamma').closest('button')?.id,
		)
		fireEvent.keyDown(input, { key: 'ArrowDown' })
		expect(input).toHaveAttribute(
			'aria-activedescendant',
			screen.getByText('alpha').closest('button')?.id,
		)
	})

	it('Enter on typed text with nothing highlighted still adds the typed tag', () => {
		const input = openEditor()
		fireEvent.change(input, { target: { value: 'New Tag' } })
		fireEvent.submit(input.closest('form') as HTMLFormElement)
		expect(mutate).toHaveBeenCalledTimes(1)
		expect(mutate.mock.calls[0][0].data.tags).toHaveLength(1)
	})

	it('typing clears the highlight so Enter adds what was typed', () => {
		const input = openEditor()
		fireEvent.keyDown(input, { key: 'ArrowDown' })
		fireEvent.change(input, { target: { value: 'zeta' } })
		expect(input).not.toHaveAttribute('aria-activedescendant')
		fireEvent.submit(input.closest('form') as HTMLFormElement)
		expect(mutate.mock.calls[0][0].data.tags).toEqual(['zeta'])
	})
})
