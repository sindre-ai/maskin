import { Composer, nameClipboardImage } from '@/components/chat/chat'
import { EMPTY_CHAT_SELECTION } from '@/lib/chat-selection'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createWorkspaceWrapper } from '../../setup'

const uploadFileMock = vi.fn()

vi.mock('@/hooks/use-files', () => ({
	useUploadFile: () => uploadFileMock,
}))

vi.mock('@/lib/file-utils', () => ({
	readFileAsBase64: async () => 'AAAA',
}))

vi.mock('@/lib/analytics', () => ({
	deriveEntryAgentRole: () => 'coach',
	trackSpecialistSummonedManually: () => {},
	trackChatMentionInserted: () => {},
}))

// The composer's `@`-picker walks the workspace actors list + the conversations
// cache to build sections; neither is under test here, so shortcut both.
// CreatePicker (mounted inside the composer) still uses `useCreateActor` from
// the same module, so preserve every export except the `useActors` we stub.
vi.mock('@/hooks/use-actors', async () => {
	const actual = await vi.importActual<typeof import('@/hooks/use-actors')>('@/hooks/use-actors')
	return { ...actual, useActors: () => ({ data: [] }) }
})
vi.mock('@/hooks/use-conversations', async () => {
	const actual = await vi.importActual<typeof import('@/hooks/use-conversations')>(
		'@/hooks/use-conversations',
	)
	return { ...actual, useConversationsInfinite: () => ({ data: { pages: [] } }) }
})

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

function clipboard({ text = '', files = [] }: { text?: string; files?: File[] }) {
	return {
		getData: (type: string) => (type === 'text' || type === 'text/plain' ? text : ''),
		files,
		types: [...(text ? ['text/plain'] : []), ...(files.length ? ['Files'] : [])],
	}
}

describe('Composer clipboard paste', () => {
	it('attaches a pasted screenshot: uploading chip, then the attachment, under a readable name', async () => {
		uploadFileMock.mockReset()
		let finish: (v: { id: string }) => void = () => {}
		uploadFileMock.mockReturnValueOnce(
			new Promise((resolve) => {
				finish = resolve
			}),
		)
		const onDispatchSelection = vi.fn()
		renderComposer({ onDispatchSelection })

		const shot = new File(['png-bytes'], 'image.png', { type: 'image/png' })
		const notPrevented = fireEvent.paste(screen.getByRole('textbox'), {
			clipboardData: clipboard({ files: [shot] }),
		})

		expect(notPrevented).toBe(false)
		const chip = await screen.findByLabelText(/^Cancel upload pasted-image-/)
		expect(chip).toBeInTheDocument()
		finish({ id: 'file-shot-1' })
		await waitFor(() =>
			expect(onDispatchSelection).toHaveBeenCalledWith({
				type: 'add_file',
				file: expect.objectContaining({
					fileId: 'file-shot-1',
					name: expect.stringMatching(/^pasted-image-\d{8}-\d{6}\.png$/),
					mimeType: 'image/png',
				}),
			}),
		)
		expect(uploadFileMock).toHaveBeenCalledWith(
			expect.objectContaining({
				name: expect.stringMatching(/^pasted-image-\d{8}-\d{6}\.png$/),
				mime_type: 'image/png',
			}),
			expect.any(Object),
		)
		expect(screen.getByRole('textbox')).toHaveValue('')
	})

	it('attaches every file in a multi-file paste and keeps a real file name', async () => {
		uploadFileMock.mockReset()
		uploadFileMock.mockResolvedValueOnce({ id: 'f1' }).mockResolvedValueOnce({ id: 'f2' })
		const onDispatchSelection = vi.fn()
		renderComposer({ onDispatchSelection })

		const pdf = new File(['%PDF'], 'report.pdf', { type: 'application/pdf' })
		const jpg = new File(['jpg'], 'image.jpg', { type: 'image/jpeg' })
		fireEvent.paste(screen.getByRole('textbox'), {
			clipboardData: clipboard({ files: [pdf, jpg] }),
		})

		await waitFor(() => expect(onDispatchSelection).toHaveBeenCalledTimes(2))
		const names = uploadFileMock.mock.calls.map((c) => c[0].name)
		expect(names[0]).toBe('report.pdf')
		expect(names[1]).toMatch(/^pasted-image-\d{8}-\d{6}\.jpg$/)
	})

	it('pastes plain text as before and attaches nothing', () => {
		uploadFileMock.mockReset()
		renderComposer()
		const notPrevented = fireEvent.paste(screen.getByRole('textbox'), {
			clipboardData: clipboard({ text: 'just words' }),
		})
		expect(notPrevented).toBe(true)
		expect(uploadFileMock).not.toHaveBeenCalled()
	})

	it('keeps only the text when the clipboard holds text and an image', () => {
		uploadFileMock.mockReset()
		renderComposer()
		const rendered = new File(['png'], 'image.png', { type: 'image/png' })
		const notPrevented = fireEvent.paste(screen.getByRole('textbox'), {
			clipboardData: clipboard({ text: 'cell A1', files: [rendered] }),
		})
		expect(notPrevented).toBe(true)
		expect(uploadFileMock).not.toHaveBeenCalled()
		expect(screen.queryByLabelText(/Cancel upload/)).not.toBeInTheDocument()
	})
})

describe('nameClipboardImage', () => {
	const at = new Date(2026, 9, 22, 8, 5, 9)

	it.each([
		['image.png', 'image/png', 'pasted-image-20261022-080509.png'],
		['', 'image/jpeg', 'pasted-image-20261022-080509.jpg'],
		['image.webp', 'image/webp', 'pasted-image-20261022-080509.webp'],
		['image.svg', 'image/svg+xml', 'pasted-image-20261022-080509.svg'],
	])('renames %j (%s) to %s', (name, type, expected) => {
		expect(nameClipboardImage(new File(['x'], name, { type }), at).name).toBe(expected)
	})

	it.each([
		['photo.png', 'image/png'],
		['report.pdf', 'application/pdf'],
	])('leaves %s alone', (name, type) => {
		const file = new File(['x'], name, { type })
		expect(nameClipboardImage(file, at)).toBe(file)
	})
})

describe('Composer text over the message cap', () => {
	const longText = `${'long message '.repeat(800)}the end`

	beforeEach(() => uploadFileMock.mockReset())

	function typeAndSend(container: HTMLElement, text: string) {
		const textarea = container.querySelector('textarea') as HTMLTextAreaElement
		fireEvent.change(textarea, { target: { value: text } })
		fireEvent.submit(textarea.closest('form') as HTMLFormElement)
	}

	it('uploads the full text as a .txt file and sends a short body with it', async () => {
		uploadFileMock.mockResolvedValueOnce({ id: 'file-long-1' })
		const { container, props } = renderComposer({ longTextAsFile: true })
		typeAndSend(container, longText)

		await waitFor(() => expect(props.onSend).toHaveBeenCalledTimes(1))
		expect(uploadFileMock).toHaveBeenCalledWith(
			expect.objectContaining({ mime_type: 'text/plain', content: longText, encoding: 'utf8' }),
		)
		const [body, extras] = vi.mocked(props.onSend).mock.calls[0]
		expect(body.length).toBeLessThan(8000)
		expect(extras?.files).toEqual([
			expect.objectContaining({ fileId: 'file-long-1', mimeType: 'text/plain' }),
		])
	})

	it('keeps the typed text and shows the error when the upload fails', async () => {
		uploadFileMock.mockRejectedValueOnce(new Error('Upload failed'))
		const { container, props } = renderComposer({ longTextAsFile: true })
		typeAndSend(container, longText)

		expect(await screen.findByText(/Upload failed/)).toBeInTheDocument()
		expect(props.onSend).not.toHaveBeenCalled()
		expect((container.querySelector('textarea') as HTMLTextAreaElement).value).toBe(longText)
	})

	it('sends the text as typed when the caller did not opt in', async () => {
		const { container, props } = renderComposer()
		typeAndSend(container, longText)

		await waitFor(() => expect(props.onSend).toHaveBeenCalledWith(longText.trim()))
		expect(uploadFileMock).not.toHaveBeenCalled()
	})
})
