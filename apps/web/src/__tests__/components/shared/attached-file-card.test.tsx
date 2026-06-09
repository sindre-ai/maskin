import { AttachedFileCard } from '@/components/shared/attached-file-card'
import type { FileDetail } from '@/lib/api'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { TestWrapper } from '../../setup'

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../mocks/router')
	return mockTanStackRouter()
})

const useFileMock = vi.fn()
vi.mock('@/hooks/use-files', () => ({
	useFile: (...args: unknown[]) => useFileMock(...args),
}))

function buildImageDetail(overrides: Partial<FileDetail> = {}): FileDetail {
	return {
		id: 'file-img-1',
		workspaceId: 'ws-1',
		name: 'cat.png',
		description: null,
		mimeType: 'image/png',
		sizeBytes: 1234,
		storageKey: 'workspaces/ws-1/files/file-img-1',
		createdBy: 'actor-1',
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		content: 'ZmFrZS1wbmctYnl0ZXM=', // base64 of "fake-png-bytes"
		encoding: 'base64',
		url: 'http://localhost:5173/ws-1/files/file-img-1',
		...overrides,
	}
}

describe('AttachedFileCard', () => {
	beforeEach(() => {
		useFileMock.mockReset()
	})

	it('renders an inline <img> with a data URI for image MIME types', () => {
		const detail = buildImageDetail()
		useFileMock.mockReturnValue({ data: detail })

		render(
			<AttachedFileCard
				workspaceId="ws-1"
				file={{
					id: detail.id,
					name: detail.name,
					sizeBytes: detail.sizeBytes,
					mimeType: detail.mimeType,
				}}
			/>,
			{ wrapper: TestWrapper },
		)

		const img = screen.getByRole('img', { name: 'cat.png' })
		expect(img).toHaveAttribute('src', `data:image/png;base64,${detail.content}`)
	})

	it('only requests file detail when the MIME type is a safe inline image', () => {
		useFileMock.mockReturnValue({ data: undefined })

		render(
			<AttachedFileCard
				workspaceId="ws-1"
				file={{
					id: 'file-pdf-1',
					name: 'report.pdf',
					sizeBytes: 2048,
					mimeType: 'application/pdf',
				}}
			/>,
			{ wrapper: TestWrapper },
		)

		// useFile should be called with a null fileId so the underlying query
		// stays disabled — that's the SVG/PDF/etc. fallback contract.
		expect(useFileMock).toHaveBeenCalledWith('ws-1', null)
		expect(screen.getByText('report.pdf')).toBeInTheDocument()
		expect(screen.queryByRole('img')).not.toBeInTheDocument()
	})

	it('does not render <img> for SVG even though the MIME starts with image/', () => {
		// SVG can carry executable script, so it must fall through to the icon
		// layout — never end up in an <img>.
		useFileMock.mockReturnValue({ data: undefined })

		render(
			<AttachedFileCard
				workspaceId="ws-1"
				file={{
					id: 'file-svg-1',
					name: 'icon.svg',
					sizeBytes: 512,
					mimeType: 'image/svg+xml',
				}}
			/>,
			{ wrapper: TestWrapper },
		)

		expect(useFileMock).toHaveBeenCalledWith('ws-1', null)
		expect(screen.queryByRole('img')).not.toBeInTheDocument()
		expect(screen.getByText('icon.svg')).toBeInTheDocument()
	})

	it('falls back to filename layout while the image detail is loading', () => {
		useFileMock.mockReturnValue({ data: undefined })

		render(
			<AttachedFileCard
				workspaceId="ws-1"
				file={{
					id: 'file-img-1',
					name: 'cat.png',
					sizeBytes: 1234,
					mimeType: 'image/png',
				}}
			/>,
			{ wrapper: TestWrapper },
		)

		expect(screen.queryByRole('img')).not.toBeInTheDocument()
		expect(screen.getByText('cat.png')).toBeInTheDocument()
	})

	it('wraps the image in the file-viewer link so click-to-open still works', () => {
		const detail = buildImageDetail()
		useFileMock.mockReturnValue({ data: detail })

		const { container } = render(
			<AttachedFileCard
				workspaceId="ws-1"
				file={{
					id: detail.id,
					name: detail.name,
					sizeBytes: detail.sizeBytes,
					mimeType: detail.mimeType,
				}}
			/>,
			{ wrapper: TestWrapper },
		)

		const link = container.querySelector('a')
		expect(link).not.toBeNull()
		// The mocked Link renders `to` as href — verify the viewer route is reached
		// through the link wrapper rather than detached from it.
		expect(link?.querySelector('img')).not.toBeNull()
	})
})
