import { PinFileButton } from '@/components/files/pin-file-button'
import type { FileDetail } from '@/lib/api'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

function buildFile(overrides: Partial<FileDetail> = {}): FileDetail {
	return {
		id: 'file-1',
		workspaceId: 'ws-1',
		name: 'dashboard.html',
		description: null,
		mimeType: 'text/html',
		sizeBytes: 1024,
		storageKey: 'ws-1/dashboard.html',
		createdBy: 'actor-1',
		createdAt: '2026-08-01T00:00:00Z',
		updatedAt: '2026-08-01T00:00:00Z',
		content: '<html><body>hello</body></html>',
		encoding: 'utf8',
		url: 'http://localhost/files/file-1',
		annotations: [],
		...overrides,
	}
}

describe('PinFileButton', () => {
	it('renders nothing for non-HTML files so the existing viewer bar is unchanged', () => {
		render(
			<PinFileButton
				file={buildFile({ mimeType: 'image/png' })}
				isPinned={false}
				onToggle={() => {}}
			/>,
		)
		expect(screen.queryByRole('button')).not.toBeInTheDocument()
	})

	it('shows an unpinned chip with aria-pressed=false for a hosted mini-app', () => {
		render(<PinFileButton file={buildFile()} isPinned={false} onToggle={() => {}} />)
		const button = screen.getByRole('button', { name: 'Pin to sidebar' })
		expect(button).toHaveAttribute('aria-pressed', 'false')
	})

	it('flips label and aria-pressed when the file is already pinned', () => {
		render(<PinFileButton file={buildFile()} isPinned onToggle={() => {}} />)
		const button = screen.getByRole('button', { name: 'Pinned to sidebar' })
		expect(button).toHaveAttribute('aria-pressed', 'true')
	})

	it('reports the file id on toggle so the caller can flip workspace settings', () => {
		const onToggle = vi.fn()
		render(<PinFileButton file={buildFile()} isPinned={false} onToggle={onToggle} />)
		fireEvent.click(screen.getByRole('button', { name: 'Pin to sidebar' }))
		expect(onToggle).toHaveBeenCalledWith('file-1')
	})
})
