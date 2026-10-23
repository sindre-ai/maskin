import { LinkedPanelContext } from '@/components/chat/linked-panel-context'
import { FilePreview, isPreviewableFile } from '@/components/shared/file-preview'
import type { FileDetail, FileListItem } from '@/lib/api'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TestWrapper } from '../../setup'

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../mocks/router')
	return mockTanStackRouter()
})

const useFileMock = vi.fn()
const useFilesMock = vi.fn()
vi.mock('@/hooks/use-files', () => ({
	useFile: (...args: unknown[]) => useFileMock(...args),
	useFiles: (...args: unknown[]) => useFilesMock(...args),
}))

const WS = 'ws-1'
const ID = 'file-1'

const utf8 = (text: string) => btoa(unescape(encodeURIComponent(text)))

function listItem(overrides: Partial<FileListItem> = {}): FileListItem {
	return {
		id: ID,
		workspaceId: WS,
		name: 'launch-page.html',
		description: null,
		mimeType: 'text/html',
		sizeBytes: 2048,
		storageKey: `workspaces/${WS}/files/${ID}`,
		createdBy: 'actor-1',
		createdAt: '2026-10-21T08:00:00.000Z',
		updatedAt: '2026-10-21T08:00:00.000Z',
		...overrides,
	}
}

function detail(overrides: Partial<FileDetail> = {}): FileDetail {
	return {
		...listItem(),
		content: utf8('<h1>Hello</h1>'),
		encoding: 'base64',
		url: `http://localhost:5173/${WS}/files/${ID}`,
		annotations: [],
		...overrides,
	}
}

function renderCard(props: Partial<React.ComponentProps<typeof FilePreview>> = {}) {
	return render(<FilePreview workspaceId={WS} fileId={ID} {...props} />, { wrapper: TestWrapper })
}

describe('FilePreview', () => {
	beforeEach(() => {
		useFileMock.mockReset()
		useFilesMock.mockReset()
		useFilesMock.mockReturnValue({ data: undefined })
		useFileMock.mockReturnValue({ data: undefined, isError: false })
	})

	describe('when the caller already knows the file', () => {
		const meta = { name: 'launch-page.html', mimeType: 'text/html', sizeBytes: 2048 }

		it('draws the header at once and does not fetch the bytes until it opens', () => {
			renderCard({ meta })
			expect(screen.getByText('launch-page.html')).toBeInTheDocument()
			expect(screen.getByText('HTML page')).toBeInTheDocument()
			expect(screen.getByRole('link', { name: /Open/ })).toBeInTheDocument()
			expect(useFileMock).toHaveBeenLastCalledWith(WS, null)
			expect(useFilesMock).toHaveBeenLastCalledWith(WS, { ids: [] })
		})

		it('renders an HTML page in a frame that can run scripts but not touch the app', async () => {
			useFileMock.mockReturnValue({ data: detail(), isError: false })
			renderCard({ meta })
			await userEvent.click(
				screen.getByRole('button', { name: /Expand preview of launch-page.html/ }),
			)
			expect(useFileMock).toHaveBeenLastCalledWith(WS, ID)
			const frame = screen.getByTitle('Preview of launch-page.html')
			expect(frame).toHaveAttribute('sandbox', 'allow-scripts')
			expect(frame.getAttribute('srcdoc')).toContain('<h1>Hello</h1>')
		})

		it('opens straight away when asked to, as a For You card does', () => {
			useFileMock.mockReturnValue({ data: detail(), isError: false })
			renderCard({ meta, defaultExpanded: true })
			expect(screen.getByTitle('Preview of launch-page.html')).toBeInTheDocument()
			expect(screen.getByRole('button', { name: /Contract preview/ })).toHaveAttribute(
				'aria-expanded',
				'true',
			)
		})

		it('folds back down when the header is clicked again', async () => {
			useFileMock.mockReturnValue({ data: detail(), isError: false })
			renderCard({ meta, defaultExpanded: true })
			await userEvent.click(screen.getByRole('button', { name: /Contract preview/ }))
			expect(screen.queryByTitle('Preview of launch-page.html')).not.toBeInTheDocument()
		})

		it('renders markdown as formatted text', async () => {
			useFileMock.mockReturnValue({
				data: detail({
					name: 'plan.md',
					mimeType: 'text/markdown',
					content: utf8('# The plan\n\n- first step'),
				}),
				isError: false,
			})
			renderCard({
				meta: { name: 'plan.md', mimeType: 'text/markdown', sizeBytes: 40 },
				defaultExpanded: true,
			})
			expect(screen.getByText('Markdown')).toBeInTheDocument()
			expect(await screen.findByRole('heading', { name: 'The plan' })).toBeInTheDocument()
			expect(screen.getByText('first step')).toBeInTheDocument()
		})

		it('shows plain text as it is', () => {
			useFileMock.mockReturnValue({
				data: detail({
					name: 'notes.txt',
					mimeType: 'text/plain',
					content: 'line one\nline two',
					encoding: 'utf8',
				}),
				isError: false,
			})
			renderCard({
				meta: { name: 'notes.txt', mimeType: 'text/plain', sizeBytes: 17 },
				defaultExpanded: true,
			})
			expect(screen.getByText(/line one/)).toBeInTheDocument()
		})

		it('shows a picture without being opened, from the bytes, and has nothing to fold', () => {
			useFileMock.mockReturnValue({
				data: detail({ name: 'hero.png', mimeType: 'image/png', content: 'ZmFrZQ==' }),
				isError: false,
			})
			renderCard({ meta: { name: 'hero.png', mimeType: 'image/png', sizeBytes: 4 } })
			expect(useFileMock).toHaveBeenLastCalledWith(WS, ID)
			expect(screen.getByRole('img', { name: 'hero.png' })).toHaveAttribute(
				'src',
				'data:image/png;base64,ZmFrZQ==',
			)
			expect(screen.queryByRole('button')).not.toBeInTheDocument()
		})

		it('never renders an SVG, which the browser would run: it is text', () => {
			useFileMock.mockReturnValue({
				data: detail({
					name: 'logo.svg',
					mimeType: 'image/svg+xml',
					content: '<svg onload="alert(1)"></svg>',
					encoding: 'utf8',
				}),
				isError: false,
			})
			renderCard({
				meta: { name: 'logo.svg', mimeType: 'image/svg+xml', sizeBytes: 30 },
				defaultExpanded: true,
			})
			expect(screen.queryByRole('img')).not.toBeInTheDocument()
			expect(screen.queryByTitle(/Preview of/)).not.toBeInTheDocument()
			expect(screen.getByText(/<svg onload/)).toBeInTheDocument()
		})

		it('says a file is too large instead of pulling it into the card', () => {
			useFileMock.mockReturnValue({ data: detail({ sizeBytes: 3_000_000 }), isError: false })
			renderCard({ meta: { ...meta, sizeBytes: 3_000_000 }, defaultExpanded: true })
			expect(screen.getByText(/too large to preview/)).toBeInTheDocument()
			expect(screen.queryByTitle(/Preview of/)).not.toBeInTheDocument()
		})

		it('says so when the file could not be loaded', () => {
			useFileMock.mockReturnValue({ data: undefined, isError: true })
			renderCard({ meta, defaultExpanded: true })
			expect(screen.getByRole('alert')).toHaveTextContent('Could not load this file.')
		})

		it('shows a header and a link, nothing to open, for a type it cannot draw', () => {
			renderCard({ meta: { name: 'deck.pdf', mimeType: 'application/pdf', sizeBytes: 90_000 } })
			expect(screen.getByText('deck.pdf')).toBeInTheDocument()
			expect(screen.getByText('File')).toBeInTheDocument()
			expect(screen.getByRole('link', { name: /Open/ })).toBeInTheDocument()
			expect(screen.queryByRole('button')).not.toBeInTheDocument()
		})
	})

	describe('when only the id is known, as for a link in a chat message', () => {
		it('looks the file up first and shows nothing until it answers', () => {
			const { container } = renderCard()
			expect(container).toBeEmptyDOMElement()
			expect(useFilesMock).toHaveBeenLastCalledWith(WS, { ids: [ID] })
			expect(useFileMock).toHaveBeenLastCalledWith(WS, null)
		})

		it('draws the card from the lookup, folded', () => {
			useFilesMock.mockReturnValue({ data: [listItem()] })
			renderCard()
			expect(screen.getByText('launch-page.html')).toBeInTheDocument()
			expect(useFileMock).toHaveBeenLastCalledWith(WS, null)
		})

		it("shows nothing for a file that is not there or is another workspace's", () => {
			useFilesMock.mockReturnValue({ data: [] })
			const { container } = renderCard()
			expect(container).toBeEmptyDOMElement()
		})
	})
})

describe('isPreviewableFile', () => {
	it('is true for the types a card can draw', () => {
		for (const type of [
			'text/html',
			'text/markdown',
			'image/png',
			'image/jpeg',
			'text/plain',
			'application/json',
		]) {
			expect(isPreviewableFile(type)).toBe(true)
		}
	})

	it('is false for the rest', () => {
		for (const type of ['application/pdf', 'application/zip', 'video/mp4']) {
			expect(isPreviewableFile(type)).toBe(false)
		}
	})

	describe('Show in panel', () => {
		it('is not offered without a panel to show it in', () => {
			renderCard({ meta: { name: 'a.html', mimeType: 'text/html', sizeBytes: 1 } })
			expect(screen.queryByRole('button', { name: 'Show in panel' })).not.toBeInTheDocument()
		})

		it('asks the panel to show the file, without opening the card', async () => {
			const openLinked = vi.fn()
			render(
				<LinkedPanelContext.Provider value={{ openLinked }}>
					<FilePreview
						workspaceId={WS}
						fileId={ID}
						meta={{ name: 'a.html', mimeType: 'text/html', sizeBytes: 1 }}
					/>
				</LinkedPanelContext.Provider>,
				{ wrapper: TestWrapper },
			)
			await userEvent.click(screen.getByRole('button', { name: 'Show in panel' }))
			expect(openLinked).toHaveBeenCalledWith({ kind: 'file', id: ID })
			expect(screen.queryByTitle('Preview of a.html')).not.toBeInTheDocument()
		})
	})
})
