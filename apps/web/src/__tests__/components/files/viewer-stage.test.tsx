import { ViewerStage } from '@/components/files/viewer-stage'
import { trackFileViewerZoomUsed } from '@/lib/analytics'
import type { FileDetail } from '@/lib/api'
import { VIEWER_DOC_SIZE_MESSAGE } from '@/lib/mini-app'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// analytics goes through posthog + a console fallback; silence both for the
// stage tests — we assert the *sites* fire (via trackFileViewerZoomUsed mock)
// rather than what posthog does with them.
vi.mock('@/lib/analytics', async () => {
	const actual = await vi.importActual<typeof import('@/lib/analytics')>('@/lib/analytics')
	return {
		...actual,
		trackFileViewerZoomUsed: vi.fn(),
	}
})

function buildHtmlFile(overrides: Partial<FileDetail> = {}): FileDetail {
	return {
		id: 'file-1',
		workspaceId: 'ws-1',
		name: 'mockup.html',
		description: null,
		mimeType: 'text/html',
		sizeBytes: 100,
		storageKey: 'workspaces/ws-1/files/file-1',
		createdBy: 'actor-1',
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		content: '<!DOCTYPE html><html><body>hi</body></html>',
		encoding: 'utf8',
		url: 'http://localhost:5173/ws-1/files/file-1',
		annotations: [],
		...overrides,
	}
}

describe('ViewerStage — HTML sandbox posture', () => {
	it('renders the iframe with sandbox="allow-scripts" and no allow-same-origin', () => {
		render(<ViewerStage file={buildHtmlFile()} />)
		const frame = screen.getByTitle('Preview of mockup.html') as HTMLIFrameElement
		expect(frame.getAttribute('sandbox')).toBe('allow-scripts')
		expect(frame.getAttribute('sandbox')).not.toMatch(/allow-same-origin/)
	})

	it('renders srcdoc containing the doc-size reporter (single injection call)', () => {
		render(<ViewerStage file={buildHtmlFile()} />)
		const frame = screen.getByTitle('Preview of mockup.html') as HTMLIFrameElement
		const srcDoc = frame.getAttribute('srcdoc') ?? ''
		expect(srcDoc).toContain(VIEWER_DOC_SIZE_MESSAGE)
		expect(srcDoc).toContain('Content-Security-Policy')
	})
})

describe('ViewerStage — keyboard subset (Slice 1)', () => {
	// The keyboard handler lives on the stage's tabIndex container. Fire the
	// event on it directly so React's synthetic-event pipeline actually invokes
	// the handler — a document-level keydown would bypass it.
	function getStage(): HTMLElement {
		return screen.getByRole('generic', { hidden: true, name: /viewer for/i }) as HTMLElement
	}

	beforeEach(() => {
		vi.mocked(trackFileViewerZoomUsed).mockClear()
	})

	it('does not leak keys to the surrounding shell — the container stopPropagation-s them', () => {
		const outerHandler = vi.fn()
		render(
			<div onKeyDown={outerHandler}>
				<ViewerStage file={buildHtmlFile()} />
			</div>,
		)
		const stage = document.querySelector('[data-viewer-state]') as HTMLElement
		fireEvent.keyDown(stage, { key: '0' })
		fireEvent.keyDown(stage, { key: '+' })
		fireEvent.keyDown(stage, { key: '-' })
		fireEvent.keyDown(stage, { key: 'F' })
		fireEvent.keyDown(stage, { key: 'Escape' })
		expect(outerHandler).not.toHaveBeenCalled()
	})

	it('ignores modifier-carrying combos so browser shortcuts still work', () => {
		const outerHandler = vi.fn()
		render(
			<div onKeyDown={outerHandler}>
				<ViewerStage file={buildHtmlFile()} />
			</div>,
		)
		const stage = document.querySelector('[data-viewer-state]') as HTMLElement
		fireEvent.keyDown(stage, { key: '0', metaKey: true })
		fireEvent.keyDown(stage, { key: '+', ctrlKey: true })
		// The modified keys bubble because the stage refused them — that's the
		// contract that keeps Cmd-R / Ctrl-+ reaching the browser.
		expect(outerHandler).toHaveBeenCalledTimes(2)
	})
})

describe('ViewerStage — iframe-blocked timeout', () => {
	beforeEach(() => {
		vi.useFakeTimers()
	})
	afterEach(() => {
		vi.useRealTimers()
	})

	it('shows the fallback tile when no doc-size message arrives within 8s', () => {
		render(<ViewerStage file={buildHtmlFile()} />)
		expect(screen.getByTitle('Preview of mockup.html')).toBeInTheDocument()
		act(() => {
			vi.advanceTimersByTime(8000)
		})
		expect(screen.queryByTitle('Preview of mockup.html')).not.toBeInTheDocument()
		expect(screen.getByText(/Preview didn't load/i)).toBeInTheDocument()
	})

	it('does NOT show the fallback if a doc-size message arrives before 8s', () => {
		render(<ViewerStage file={buildHtmlFile()} />)
		const frame = screen.getByTitle('Preview of mockup.html') as HTMLIFrameElement
		// Fire the reporter payload as if the sandboxed frame posted it, then
		// let React flush before advancing the fake timer — coalescing both
		// into one act() would run the timeout before setDocSize commits.
		act(() => {
			window.dispatchEvent(
				new MessageEvent('message', {
					source: frame.contentWindow,
					data: { type: VIEWER_DOC_SIZE_MESSAGE, w: 1440, h: 900 },
				}),
			)
		})
		act(() => {
			vi.advanceTimersByTime(8000)
		})
		expect(screen.queryByText(/Preview didn't load/i)).not.toBeInTheDocument()
	})
})
