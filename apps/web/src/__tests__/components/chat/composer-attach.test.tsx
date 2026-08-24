import { Composer } from '@/components/chat/chat'
import { EMPTY_CHAT_SELECTION } from '@/lib/chat-selection'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { createWorkspaceWrapper } from '../../setup'

const uploadFileMock = vi.fn()

vi.mock('@/hooks/use-files', () => ({
	useUploadFile: () => uploadFileMock,
}))

vi.mock('@/lib/file-utils', () => ({
	readFileAsBase64: async () => 'AAAA',
}))

vi.mock('@/components/chat/slash-picker', () => ({
	SlashPicker: () => null,
}))

vi.mock('@/lib/analytics', () => ({
	deriveEntryAgentRole: () => 'coach',
	trackSpecialistSummonedManually: () => {},
}))

function renderComposer(overrides: Partial<Parameters<typeof Composer>[0]> = {}) {
	const props = {
		workspaceId: 'ws-test',
		onSend: vi.fn().mockResolvedValue(undefined),
		disabled: false,
		pending: false,
		surface: 'sheet' as const,
		placeholder: 'Message',
		selection: EMPTY_CHAT_SELECTION,
		onDispatchSelection: vi.fn(),
		onRemoveAgent: vi.fn(),
		onRemoveObject: vi.fn(),
		onRemoveNotification: vi.fn(),
		onRemoveFile: vi.fn(),
		...overrides,
	}
	return {
		...render(<Composer {...props} />, { wrapper: createWorkspaceWrapper() }),
		props,
	}
}

function getFileInput(container: HTMLElement): HTMLInputElement {
	const input = container.querySelector<HTMLInputElement>('input[type="file"]')
	if (!input) throw new Error('composer file input not found')
	return input
}

describe('Composer file-attach input', () => {
	it('does not restrict the OS file picker to images (PDFs must be selectable)', () => {
		const { container } = renderComposer()
		const input = getFileInput(container)
		expect(screen.getByRole('button', { name: 'Attach file' })).toBeInTheDocument()
		// The hidden input is the OS file-picker allowlist. Any non-empty `accept`
		// blocks PDF selection at the picker — the composer must leave it unset
		// so file types are validated by the backend, not the client.
		expect(input.getAttribute('accept')).toBeNull()
		expect(input.multiple).toBe(true)
	})

	it('uploads a picked PDF via useUploadFile and dispatches add_file on success', async () => {
		uploadFileMock.mockResolvedValueOnce({ id: 'file-pdf-1' })
		const onDispatchSelection = vi.fn()
		const { container } = renderComposer({ onDispatchSelection })

		const input = getFileInput(container)
		const pdf = new File(['%PDF-1.4 hello'], 'report.pdf', { type: 'application/pdf' })
		fireEvent.change(input, { target: { files: [pdf] } })

		await waitFor(() => expect(uploadFileMock).toHaveBeenCalledTimes(1))
		expect(uploadFileMock).toHaveBeenCalledWith(
			expect.objectContaining({
				name: 'report.pdf',
				mime_type: 'application/pdf',
				encoding: 'base64',
			}),
			expect.any(Object),
		)
		await waitFor(() =>
			expect(onDispatchSelection).toHaveBeenCalledWith(
				expect.objectContaining({
					type: 'add_file',
					file: expect.objectContaining({
						fileId: 'file-pdf-1',
						name: 'report.pdf',
						mimeType: 'application/pdf',
					}),
				}),
			),
		)
	})
})
