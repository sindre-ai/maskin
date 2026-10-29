import {
	type MessageAttachmentItem,
	MessageAttachments,
	fileKindOf,
} from '@/components/chat/message-attachments'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TestWrapper } from '../../setup'

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../mocks/router')
	return mockTanStackRouter()
})

const failedFiles = vi.hoisted(() => new Set<string>())
const downloads = vi.hoisted(() => ({ get: vi.fn() }))

vi.mock('@/hooks/use-files', () => ({
	useFile: (_workspaceId: string, id: string | null) => {
		if (!id) return { data: undefined, isError: false }
		if (id.startsWith('pending-')) return { data: undefined, isError: false }
		if (failedFiles.has(id)) return { data: undefined, isError: true }
		return {
			data: {
				id,
				name: `${id}.png`,
				mimeType: 'image/png',
				encoding: 'base64',
				content: 'iVBORw0KGgo=',
				url: '',
			},
			isError: false,
		}
	},
}))

const saved = vi.hoisted(() => ({ downloadFile: vi.fn() }))
vi.mock('@/lib/file-utils', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/lib/file-utils')>()),
	downloadFile: saved.downloadFile,
}))

vi.mock('@/lib/api', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/lib/api')>()),
	api: { files: { get: downloads.get } },
}))

const image = (n: number, over: Partial<MessageAttachmentItem> = {}): MessageAttachmentItem => ({
	id: `img-${n}`,
	name: `photo-${n}.png`,
	sizeBytes: 1000,
	mimeType: 'image/png',
	...over,
})

const file = (over: Partial<MessageAttachmentItem> = {}): MessageAttachmentItem => ({
	id: 'file-1',
	name: 'Q3-pipeline-review.pdf',
	sizeBytes: 2_516_582,
	mimeType: 'application/pdf',
	...over,
})

function renderAttachments(items: MessageAttachmentItem[], align: 'start' | 'end' = 'end') {
	return render(<MessageAttachments workspaceId="ws-1" items={items} align={align} />, {
		wrapper: TestWrapper,
	})
}

beforeEach(() => {
	failedFiles.clear()
	downloads.get.mockReset()
	saved.downloadFile.mockReset()
})

describe('MessageAttachments images', () => {
	it('draws one image as a single tile with its accessible name', () => {
		renderAttachments([image(1)])
		expect(screen.getByRole('button', { name: 'Image 1, photo-1.png, open' })).toBeInTheDocument()
		expect(screen.getByRole('list', { name: 'Attached image' })).toBeInTheDocument()
	})

	it.each([
		[2, 'aspect-[2/1]'],
		[3, 'aspect-[4/3]'],
		[4, 'aspect-square'],
	])('lays out %i images in the block shape from the spec', (count, shape) => {
		renderAttachments(Array.from({ length: count }, (_, i) => image(i + 1)))
		const list = screen.getByRole('list', { name: `${count} attached images` })
		expect(list.className).toContain(shape)
		expect(within(list).getAllByRole('button', { name: /^Image \d, .*, open$/ })).toHaveLength(
			count,
		)
	})

	it('puts one large tile on the left of three images, spanning both rows', () => {
		renderAttachments([image(1), image(2), image(3)])
		const items = screen.getAllByRole('listitem')
		expect(items[0].className).toContain('row-span-2')
		expect(items[1].className).not.toContain('row-span-2')
	})

	it('shows +N on the fourth tile of six images and opens the viewer on image 4', () => {
		renderAttachments(Array.from({ length: 6 }, (_, i) => image(i + 1)))
		expect(screen.getAllByRole('button', { name: /^Image \d, .*, open$/ })).toHaveLength(4)
		expect(screen.getByText('+2')).toBeInTheDocument()
		fireEvent.click(screen.getByRole('button', { name: 'Image 4, photo-4.png, open' }))
		expect(screen.getByRole('dialog')).toBeInTheDocument()
		expect(screen.getByText('4 of 6')).toBeInTheDocument()
		expect(screen.getByText('photo-4.png')).toBeInTheDocument()
	})

	it('draws a skeleton in the reserved shape while an image loads', () => {
		renderAttachments([image(1, { id: 'pending-1' })])
		expect(screen.getByRole('img', { name: 'Loading image' })).toBeInTheDocument()
	})

	it("says it can't load an image whose file fails to fetch, keeping the name", () => {
		failedFiles.add('img-1')
		renderAttachments([image(1)])
		expect(screen.getByText("Can't load this image")).toBeInTheDocument()
		expect(screen.getByText('photo-1.png')).toBeInTheDocument()
		expect(screen.queryByRole('button', { name: /open$/ })).not.toBeInTheDocument()
	})

	it('shows a progress ring and percent on an uploading image', () => {
		renderAttachments([image(1, { id: undefined, status: 'uploading', progress: 62 })])
		expect(
			screen.getByRole('img', { name: 'Uploading photo-1.png, 62 percent' }),
		).toBeInTheDocument()
		expect(screen.getByText('62%')).toBeInTheDocument()
	})

	it('shows Retry on one failed tile without blocking the others', () => {
		const onRetry = vi.fn()
		renderAttachments([
			image(1),
			image(2, { id: undefined, status: 'failed', onRetry }),
			image(3),
			image(4),
		])
		expect(screen.getByText("Couldn't upload")).toBeInTheDocument()
		fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
		expect(onRetry).toHaveBeenCalledTimes(1)
		expect(screen.getAllByRole('button', { name: /^Image \d, .*, open$/ })).toHaveLength(3)
	})
})

describe('ImageViewer', () => {
	function openAt(count: number, at = 1) {
		renderAttachments(Array.from({ length: count }, (_, i) => image(i + 1)))
		fireEvent.click(screen.getByRole('button', { name: `Image ${at}, photo-${at}.png, open` }))
	}

	it('opens on the tapped image with a counter, and moves with the buttons and arrow keys', () => {
		openAt(4, 2)
		expect(screen.getByText('2 of 4')).toBeInTheDocument()
		fireEvent.click(screen.getByRole('button', { name: 'Next image' }))
		expect(screen.getByText('3 of 4')).toBeInTheDocument()
		fireEvent.click(screen.getByRole('button', { name: 'Previous image' }))
		expect(screen.getByText('2 of 4')).toBeInTheDocument()
		fireEvent.keyDown(screen.getByRole('dialog'), { key: 'ArrowRight' })
		expect(screen.getByText('3 of 4')).toBeInTheDocument()
		fireEvent.keyDown(screen.getByRole('dialog'), { key: 'ArrowLeft' })
		expect(screen.getByText('2 of 4')).toBeInTheDocument()
	})

	it('has no counter or arrows for a single image', () => {
		openAt(1)
		expect(screen.getByRole('dialog')).toBeInTheDocument()
		expect(screen.queryByText(/ of /)).not.toBeInTheDocument()
		expect(screen.queryByRole('button', { name: 'Next image' })).not.toBeInTheDocument()
	})

	it('closes on Escape', () => {
		renderAttachments([image(1), image(2)])
		fireEvent.click(screen.getByRole('button', { name: 'Image 1, photo-1.png, open' }))
		fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
		expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
	})

	it('closes with the close button', () => {
		renderAttachments([image(1), image(2)])
		fireEvent.click(screen.getByRole('button', { name: 'Image 1, photo-1.png, open' }))
		fireEvent.click(screen.getByRole('button', { name: 'Close viewer' }))
		expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
	})
})

describe('MessageAttachments files', () => {
	it('shows a file card with the type tag, name, type and size, and no page count', () => {
		renderAttachments([file()])
		const card = screen.getByRole('link', { name: 'Open Q3-pipeline-review.pdf' })
		expect(card).toBeInTheDocument()
		expect(screen.getByText('PDF')).toBeInTheDocument()
		expect(screen.getByText('PDF · 2.4 MB')).toBeInTheDocument()
		expect(screen.queryByText(/page/i)).not.toBeInTheDocument()
		expect(
			screen.getByRole('button', { name: 'Download Q3-pipeline-review.pdf' }),
		).toBeInTheDocument()
	})

	it('downloads through the file route when the arrow is pressed', async () => {
		const detail = { name: 'a.pdf', mimeType: 'application/pdf', encoding: 'base64', content: '' }
		downloads.get.mockResolvedValue(detail)
		renderAttachments([file()])
		fireEvent.click(screen.getByRole('button', { name: 'Download Q3-pipeline-review.pdf' }))
		expect(downloads.get).toHaveBeenCalledWith('ws-1', 'file-1')
		await waitFor(() => expect(saved.downloadFile).toHaveBeenCalledWith(detail))
	})

	it('stacks several files in the order given', () => {
		renderAttachments([
			file(),
			file({ id: 'f2', name: 'pricing.xlsx', mimeType: undefined }),
			file({ id: 'f3', name: 'assets.zip', mimeType: 'application/zip' }),
		])
		const list = screen.getByRole('list', { name: 'Attached files' })
		expect(
			within(list)
				.getAllByRole('link')
				.map((a) => a.getAttribute('aria-label')),
		).toEqual(['Open Q3-pipeline-review.pdf', 'Open pricing.xlsx', 'Open assets.zip'])
	})

	it('shows progress and Cancel on an uploading file', () => {
		const onCancel = vi.fn()
		renderAttachments([file({ id: undefined, status: 'uploading', progress: 40, onCancel })])
		expect(screen.getByText('Uploading, 40%')).toBeInTheDocument()
		fireEvent.click(screen.getByRole('button', { name: 'Cancel upload of Q3-pipeline-review.pdf' }))
		expect(onCancel).toHaveBeenCalledTimes(1)
	})

	it('shows a danger card with Retry on a failed file', () => {
		const onRetry = vi.fn()
		renderAttachments([file({ id: undefined, status: 'failed', onRetry })])
		expect(screen.getByText("Couldn't upload")).toBeInTheDocument()
		fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
		expect(onRetry).toHaveBeenCalledTimes(1)
	})

	it('shows a gone file with a struck-through name and no actions', () => {
		renderAttachments([file({ status: 'gone' })])
		expect(screen.getByText('File no longer available')).toBeInTheDocument()
		expect(screen.getByText('Q3-pipeline-review.pdf').className).toContain('line-through')
		expect(screen.queryByRole('link')).not.toBeInTheDocument()
		expect(screen.queryByRole('button')).not.toBeInTheDocument()
	})

	it('puts the images before the files', () => {
		const { container } = renderAttachments([file(), image(1)])
		const imageList = screen.getByRole('list', { name: 'Attached image' })
		const fileList = screen.getByRole('list', { name: 'Attached files' })
		expect(
			imageList.compareDocumentPosition(fileList) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy()
		expect(container.firstElementChild?.className).toContain('items-end')
	})

	it('aligns to the left for someone else’s message', () => {
		const { container } = renderAttachments([file()], 'start')
		expect(container.firstElementChild?.className).toContain('items-start')
	})
})

describe('fileKindOf', () => {
	it.each([
		['a.pdf', 'application/pdf', 'PDF', 'PDF'],
		['spec.md', 'text/markdown', 'MD', 'Markdown'],
		['pricing.xlsx', undefined, 'XLSX', 'Spreadsheet'],
		['assets.zip', undefined, 'ZIP', 'Archive'],
		['notes.txt', 'text/plain', 'TXT', 'Text'],
		['blob', undefined, 'FILE', 'File'],
	])('reads %s as %s', (name, mime, tag, label) => {
		expect(fileKindOf(name, mime)).toMatchObject({ tag, label })
	})
})
