import { AttachedFileCard } from '@/components/shared/attached-file-card'
import type { FileDetail } from '@/lib/api'
import { render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { TestWrapper } from '../../setup'

vi.mock('@tanstack/react-router', () => ({
	Link: ({
		children,
		className,
		'aria-label': ariaLabel,
	}: {
		children: React.ReactNode
		className?: string
		'aria-label'?: string
		[key: string]: unknown
	}) => (
		<a href="/test" className={className} aria-label={ariaLabel}>
			{children}
		</a>
	),
}))

vi.mock('@/hooks/use-files', () => ({
	useFile: vi.fn(),
}))

import { useFile } from '@/hooks/use-files'

function buildImageDetail(overrides: Partial<FileDetail> = {}): FileDetail {
	return {
		id: 'file-img-1',
		workspaceId: 'ws-1',
		name: 'photo.png',
		description: null,
		mimeType: 'image/png',
		sizeBytes: 1234,
		storageKey: 'workspaces/ws-1/files/file-img-1',
		createdBy: 'actor-1',
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		content: 'ZmFrZS1pbWFnZS1ieXRlcw==', // base64 of "fake-image-bytes"
		encoding: 'base64',
		url: 'http://localhost:5173/ws-1/files/file-img-1',
		...overrides,
	}
}

describe('AttachedFileCard', () => {
	it('renders inline <img> with data URI when mimeType is image/*', async () => {
		const detail = buildImageDetail()
		vi.mocked(useFile).mockReturnValue({ data: detail } as ReturnType<typeof useFile>)

		render(
			<AttachedFileCard
				workspaceId="ws-1"
				file={{ id: detail.id, name: detail.name, mimeType: detail.mimeType, sizeBytes: 1234 }}
			/>,
			{ wrapper: TestWrapper },
		)

		const img = await waitFor(() => screen.getByRole('img', { name: 'photo.png' }))
		expect(img).toHaveAttribute('src', `data:image/png;base64,${detail.content}`)
	})

	it('falls back to the filename card while the image detail is loading', () => {
		vi.mocked(useFile).mockReturnValue({ data: undefined } as ReturnType<typeof useFile>)

		render(
			<AttachedFileCard
				workspaceId="ws-1"
				file={{ id: 'file-img-2', name: 'pending.png', mimeType: 'image/png', sizeBytes: 500 }}
			/>,
			{ wrapper: TestWrapper },
		)

		expect(screen.getByText('pending.png')).toBeInTheDocument()
		expect(screen.queryByRole('img')).not.toBeInTheDocument()
	})

	it('renders the existing filename card for non-image mime types', () => {
		vi.mocked(useFile).mockReturnValue({ data: undefined } as ReturnType<typeof useFile>)

		render(
			<AttachedFileCard
				workspaceId="ws-1"
				file={{
					id: 'file-pdf-1',
					name: 'spec.pdf',
					mimeType: 'application/pdf',
					sizeBytes: 9999,
				}}
			/>,
			{ wrapper: TestWrapper },
		)

		expect(screen.getByText('spec.pdf')).toBeInTheDocument()
		expect(screen.queryByRole('img')).not.toBeInTheDocument()
	})

	it('does not treat SVG as inline image (unsafe MIME)', () => {
		vi.mocked(useFile).mockReturnValue({ data: undefined } as ReturnType<typeof useFile>)

		render(
			<AttachedFileCard
				workspaceId="ws-1"
				file={{
					id: 'file-svg-1',
					name: 'icon.svg',
					mimeType: 'image/svg+xml',
					sizeBytes: 200,
				}}
			/>,
			{ wrapper: TestWrapper },
		)

		expect(screen.getByText('icon.svg')).toBeInTheDocument()
		expect(screen.queryByRole('img')).not.toBeInTheDocument()
	})
})
