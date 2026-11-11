import { ObjectPreviewMeta } from '@/components/shared/object-preview-meta'
import { DraftMedia, PreviewMedia } from '@/components/shared/preview-media'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { useFiles, useFile } = vi.hoisted(() => ({ useFiles: vi.fn(), useFile: vi.fn() }))
vi.mock('@/hooks/use-files', () => ({ useFiles, useFile }))
vi.mock('@/components/chat/linked-panel-context', () => ({ useLinkedPanel: () => null }))
vi.mock('@tanstack/react-router', () => ({
	Link: ({ children }: { children: React.ReactNode }) => <a href="/x">{children}</a>,
}))

const listed = (id: string, name: string, mimeType = 'image/png', sizeBytes = 1000) => ({
	id,
	name,
	mimeType,
	sizeBytes,
})
const detail = (id: string, mimeType = 'image/png') => ({
	id,
	mimeType,
	encoding: 'base64',
	content: 'iVBORw0KGgo=',
	contentOmitted: false,
	// A video streams from its storage URL; no Blob is made.
	downloadUrl: mimeType.startsWith('video/') ? 'https://storage.test/demo.mp4' : null,
})

function serve(files: ReturnType<typeof listed>[]) {
	useFiles.mockReturnValue({ data: files, isLoading: false })
	useFile.mockImplementation((_ws: string, id: string | null) => ({
		data: id ? detail(id, files.find((f) => f.id === id)?.mimeType) : undefined,
		isError: false,
	}))
}

const IDS = ['a', 'b', 'c']

describe('PreviewMedia', () => {
	beforeEach(() => {
		useFiles.mockReset()
		useFile.mockReset()
	})

	it('draws a single image with no carousel controls', () => {
		serve([listed('a', 'slide-1.png')])
		render(<PreviewMedia workspaceId="ws" fileIds={['a']} />)
		expect(screen.getByRole('img', { name: 'slide-1.png' })).toBeInTheDocument()
		expect(screen.queryByRole('button', { name: 'Next' })).not.toBeInTheDocument()
		expect(screen.queryByText(/\d \/ \d/)).not.toBeInTheDocument()
	})

	it('keeps the order the draft lists the files in, not the order the server returns them', () => {
		serve([listed('c', 'three.png'), listed('a', 'one.png'), listed('b', 'two.png')])
		render(<PreviewMedia workspaceId="ws" fileIds={IDS} />)
		// The third slide is not loaded yet; step to it and every slide is in the order listed.
		fireEvent.click(screen.getByRole('button', { name: 'Next' }))
		const names = screen.getAllByRole('img').map((img) => img.getAttribute('alt'))
		expect(names).toEqual(['one.png', 'two.png', 'three.png'])
	})

	it('steps through a carousel with the buttons and the arrow keys, and counts the slides', () => {
		serve([listed('a', 'one.png'), listed('b', 'two.png'), listed('c', 'three.png')])
		render(<PreviewMedia workspaceId="ws" fileIds={IDS} />)
		expect(screen.getByText('1 / 3')).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled()
		fireEvent.click(screen.getByRole('button', { name: 'Next' }))
		expect(screen.getByText('2 / 3')).toBeInTheDocument()
		fireEvent.keyDown(screen.getByRole('region', { name: 'Media, 3 items' }), { key: 'ArrowRight' })
		expect(screen.getByText('3 / 3')).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled()
		fireEvent.keyDown(screen.getByRole('region', { name: 'Media, 3 items' }), { key: 'ArrowLeft' })
		expect(screen.getByText('2 / 3')).toBeInTheDocument()
	})

	it('loads only the slide in view and its neighbours', () => {
		const ids = ['a', 'b', 'c', 'd', 'e']
		serve(ids.map((id) => listed(id, `${id}.png`)))
		render(<PreviewMedia workspaceId="ws" fileIds={ids} />)
		const asked = useFile.mock.calls.map((call) => call[1]).filter(Boolean)
		expect(new Set(asked)).toEqual(new Set(['a', 'b']))
	})

	it('draws a video with native controls and no autoplay', () => {
		serve([listed('v', 'demo.mp4', 'video/mp4', 5000)])
		const { container } = render(<PreviewMedia workspaceId="ws" fileIds={['v']} />)
		const video = container.querySelector('video')
		expect(video).not.toBeNull()
		expect(video).toHaveAttribute('controls')
		expect(video).not.toHaveAttribute('autoplay')
		expect(video).toHaveAttribute('preload', 'metadata')
	})

	it('draws a document as its header with the name and size, in the same strip as the images', () => {
		serve([listed('a', 'one.png'), listed('p', 'carousel.pdf', 'application/pdf', 1_064_264)])
		render(<PreviewMedia workspaceId="ws" fileIds={['a', 'p']} />)
		expect(screen.getByText('carousel.pdf')).toBeInTheDocument()
		expect(screen.getByText('1 / 2')).toBeInTheDocument()
	})

	it('skips a file that is missing or in another workspace, without showing its id', () => {
		serve([listed('a', 'one.png'), listed('c', 'three.png')])
		const { container } = render(<PreviewMedia workspaceId="ws" fileIds={['a', 'gone-id', 'c']} />)
		expect(screen.getByText('1 / 2')).toBeInTheDocument()
		expect(container.textContent).not.toContain('gone-id')
	})

	it('draws nothing when no listed file can be shown', () => {
		serve([])
		const { container } = render(<PreviewMedia workspaceId="ws" fileIds={['gone-id']} />)
		expect(container).toBeEmptyDOMElement()
	})

	it('shows a skeleton while the files are looked up', () => {
		useFiles.mockReturnValue({ data: undefined, isLoading: true })
		render(<PreviewMedia workspaceId="ws" fileIds={['a']} />)
		expect(screen.getByLabelText('Loading media')).toBeInTheDocument()
	})
})

describe('DraftMedia', () => {
	const preview = (media_file_ids?: string[]) => ({ media_file_ids })

	it('draws the media of a draft', () => {
		serve([listed('a', 'one.png'), listed('b', 'two.png')])
		render(<DraftMedia preview={preview(['a', 'b'])} workspaceId="ws" />)
		expect(screen.getByText('1 / 2')).toBeInTheDocument()
	})

	it('draws nothing when the draft lists no files', () => {
		serve([listed('a', 'one.png')])
		const { container, rerender } = render(<DraftMedia preview={preview([])} workspaceId="ws" />)
		expect(container).toBeEmptyDOMElement()
		rerender(<DraftMedia preview={preview()} workspaceId="ws" />)
		expect(container).toBeEmptyDOMElement()
	})

	it('is not part of the header block above the text', () => {
		serve([listed('a', 'one.png')])
		const { container } = render(
			<ObjectPreviewMeta
				preview={{
					kind: 'linkedin_post',
					label: 'LinkedIn post',
					provider: null,
					recipients: [],
					subject: null,
					details: [],
					media_file_ids: ['a'],
					body: 'x',
					maxLength: null,
					missing: [],
					warnings: [],
					content_hash: 'h',
				}}
			/>,
		)
		expect(container).toBeEmptyDOMElement()
	})
})
