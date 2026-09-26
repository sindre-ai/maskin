import { ViewerStage } from '@/components/files/viewer-stage'
import { trackFileViewerPageNavigated, trackFileViewerZoomUsed } from '@/lib/analytics'
import type { FileDetail } from '@/lib/api'
import {
	VIEWER_DOC_SIZE_MESSAGE,
	VIEWER_GOTO_PAGE_MESSAGE,
	VIEWER_PAGE_MESSAGE,
	VIEWER_WHEEL_MESSAGE,
} from '@/lib/mini-app'
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
		trackFileViewerPageNavigated: vi.fn(),
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

describe('ViewerStage — native wheel binding', () => {
	// The wheel listener is attached natively to the scroll viewport, not through
	// React's onWheel prop — React 19 attaches root wheel listeners as passive, so
	// a React handler's preventDefault() is a no-op and the browser's own
	// Ctrl+wheel page zoom wins. Firing a real WheelEvent at the viewport is the
	// only way to observe whether preventDefault actually took.
	function getViewport(): HTMLElement {
		return screen.getByTitle('Preview of mockup.html').closest('.overflow-auto') as HTMLElement
	}

	beforeEach(() => {
		vi.mocked(trackFileViewerZoomUsed).mockClear()
	})

	it('prevents default on ctrl+wheel so the stage zoom beats the browser page zoom', () => {
		render(<ViewerStage file={buildHtmlFile()} />)
		const event = new WheelEvent('wheel', {
			ctrlKey: true,
			deltaY: -120,
			cancelable: true,
			bubbles: true,
		})
		// The handler calls setZoom, so the dispatch has to be wrapped — otherwise
		// React warns about a state update outside act().
		act(() => {
			getViewport().dispatchEvent(event)
		})
		expect(event.defaultPrevented).toBe(true)
		expect(trackFileViewerZoomUsed).toHaveBeenCalledWith(expect.objectContaining({ mode: 'wheel' }))
	})

	it('leaves an unmodified wheel alone so the viewport scrolls normally', () => {
		render(<ViewerStage file={buildHtmlFile()} />)
		const event = new WheelEvent('wheel', { deltaY: 120, cancelable: true, bubbles: true })
		getViewport().dispatchEvent(event)
		expect(event.defaultPrevented).toBe(false)
		expect(trackFileViewerZoomUsed).not.toHaveBeenCalled()
	})
})

describe('ViewerStage — wheel forwarded from the sandboxed iframe', () => {
	// This is the boundary the native-wheel test above CANNOT reach: a real
	// ctrl+wheel over a sandboxed iframe fires in the frame's own browsing
	// context and never bubbles to the parent listener, so the feature depends
	// entirely on the reporter script (see VIEWER_WHEEL_MESSAGE in mini-app.ts)
	// forwarding the event over postMessage. jsdom has no iframe browsing
	// context, so we simulate the boundary by dispatching the same MessageEvent
	// the reporter would post — matching `source: iframe.contentWindow`, since
	// the parent checks source-window equality before trusting any payload.

	function getIframe(): HTMLIFrameElement {
		return screen.getByTitle('Preview of mockup.html') as HTMLIFrameElement
	}

	function getViewport(): HTMLElement {
		return screen.getByTitle('Preview of mockup.html').closest('.overflow-auto') as HTMLElement
	}

	beforeEach(() => {
		vi.mocked(trackFileViewerZoomUsed).mockClear()
	})

	it('emits file_viewer_zoom_used when the iframe forwards a ctrl+wheel over the document', () => {
		render(<ViewerStage file={buildHtmlFile()} />)
		const iframe = getIframe()
		act(() => {
			window.dispatchEvent(
				new MessageEvent('message', {
					source: iframe.contentWindow,
					data: {
						type: VIEWER_WHEEL_MESSAGE,
						deltaX: 0,
						deltaY: -120,
						ctrlKey: true,
						docX: 400,
						docY: 300,
					},
				}),
			)
		})
		expect(trackFileViewerZoomUsed).toHaveBeenCalledWith(
			expect.objectContaining({ mode: 'wheel', file_id: 'file-1' }),
		)
	})

	it('reports mode=pinch when the forwarded delta is fractional (trackpad pinch)', () => {
		render(<ViewerStage file={buildHtmlFile()} />)
		const iframe = getIframe()
		act(() => {
			window.dispatchEvent(
				new MessageEvent('message', {
					source: iframe.contentWindow,
					data: {
						type: VIEWER_WHEEL_MESSAGE,
						deltaX: 0,
						deltaY: -13.5,
						ctrlKey: true,
						docX: 100,
						docY: 100,
					},
				}),
			)
		})
		expect(trackFileViewerZoomUsed).toHaveBeenCalledWith(expect.objectContaining({ mode: 'pinch' }))
	})

	it('pans the viewport on a plain (non-ctrl) wheel forwarded from the iframe', () => {
		render(<ViewerStage file={buildHtmlFile()} />)
		const iframe = getIframe()
		const viewport = getViewport()
		viewport.scrollLeft = 0
		viewport.scrollTop = 0
		act(() => {
			window.dispatchEvent(
				new MessageEvent('message', {
					source: iframe.contentWindow,
					data: {
						type: VIEWER_WHEEL_MESSAGE,
						deltaX: 25,
						deltaY: 40,
						ctrlKey: false,
						docX: 0,
						docY: 0,
					},
				}),
			)
		})
		expect(viewport.scrollLeft).toBe(25)
		expect(viewport.scrollTop).toBe(40)
		expect(trackFileViewerZoomUsed).not.toHaveBeenCalled()
	})

	it('ignores a wheel message whose source is not our iframe (spoofed sender)', () => {
		render(<ViewerStage file={buildHtmlFile()} />)
		act(() => {
			// source omitted → null, so the source-window check drops the payload.
			window.dispatchEvent(
				new MessageEvent('message', {
					data: {
						type: VIEWER_WHEEL_MESSAGE,
						deltaX: 0,
						deltaY: -120,
						ctrlKey: true,
						docX: 100,
						docY: 100,
					},
				}),
			)
		})
		expect(trackFileViewerZoomUsed).not.toHaveBeenCalled()
	})
})

describe('ViewerStage — keyboard focus', () => {
	it('is focusable on mount so the shortcut set is live without a click', () => {
		render(<ViewerStage file={buildHtmlFile()} />)
		const stage = document.querySelector('[data-viewer-state]') as HTMLElement
		expect(stage).toHaveAttribute('tabindex', '0')
		expect(document.activeElement).toBe(stage)
	})
})

describe('ViewerStage — loading state', () => {
	it('shows a spinner while the doc size is still unknown', () => {
		render(<ViewerStage file={buildHtmlFile()} />)
		expect(screen.getByTitle('Loading')).toBeInTheDocument()
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
		vi.unstubAllGlobals()
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

	it('offers View source and Download actions once the frame is declared blocked', () => {
		render(<ViewerStage file={buildHtmlFile()} />)
		act(() => {
			vi.advanceTimersByTime(8000)
		})
		expect(screen.getByRole('button', { name: /view source/i })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: /download/i })).toBeInTheDocument()
	})

	it('opens the source as a text/plain blob so the document never runs in the app origin', () => {
		// jsdom ships no object-URL implementation, so stub both halves around the
		// click — the assertion is on the blob's mime and the window.open contract,
		// not on anything the browser would do with the URL.
		// The parameter is declared so the mock's call tuple is typed [Blob] —
		// an untyped vi.fn() records calls as empty tuples, which makes the
		// assertion below untypeable.
		const createObjectURL = vi.fn((_blob: Blob) => 'blob:mock')
		const revokeObjectURL = vi.fn()
		const originalCreate = URL.createObjectURL
		const originalRevoke = URL.revokeObjectURL
		URL.createObjectURL = createObjectURL
		URL.revokeObjectURL = revokeObjectURL
		const openSpy = vi.fn()
		vi.stubGlobal('open', openSpy)
		try {
			render(<ViewerStage file={buildHtmlFile()} />)
			act(() => {
				vi.advanceTimersByTime(8000)
			})
			fireEvent.click(screen.getByRole('button', { name: /view source/i }))
			expect(createObjectURL).toHaveBeenCalledTimes(1)
			const blob = createObjectURL.mock.calls[0][0]
			expect(blob.type).toBe('text/plain')
			expect(openSpy).toHaveBeenCalledWith('blob:mock', '_blank', 'noopener,noreferrer')
		} finally {
			if (originalCreate) URL.createObjectURL = originalCreate
			else Reflect.deleteProperty(URL, 'createObjectURL')
			if (originalRevoke) URL.revokeObjectURL = originalRevoke
			else Reflect.deleteProperty(URL, 'revokeObjectURL')
		}
	})
})

describe('ViewerStage — paged deck (Slice 2a)', () => {
	// jsdom runs no srcdoc frame scripts, so the injected paging controller never
	// executes here. "Exactly one slide is visible" is covered by the direct unit
	// test of showViewerPage in __tests__/lib/mini-app.test.ts; what these tests
	// cover is the parent's half of the protocol — the page report it accepts, the
	// goto message it posts back, and the analytics site it fires.
	function getDeckFile(): FileDetail {
		return buildHtmlFile({ name: 'deck.deck.html' })
	}

	function getStage(): HTMLElement {
		return document.querySelector('[data-viewer-state]') as HTMLElement
	}

	function getDeckFrame(): HTMLIFrameElement {
		return screen.getByTitle('Preview of deck.deck.html') as HTMLIFrameElement
	}

	// The controller reports its page over postMessage; this replays that exact
	// boundary the same way the wheel tests replay VIEWER_WHEEL_MESSAGE.
	function reportPage(iframe: HTMLIFrameElement, index: number, total: number) {
		act(() => {
			window.dispatchEvent(
				new MessageEvent('message', {
					source: iframe.contentWindow,
					data: { type: VIEWER_PAGE_MESSAGE, index, total, w: 1440, h: 900 },
				}),
			)
		})
	}

	beforeEach(() => {
		vi.mocked(trackFileViewerPageNavigated).mockClear()
		vi.mocked(trackFileViewerZoomUsed).mockClear()
	})

	it('injects the paging controller into a deck document without a second injection', () => {
		render(<ViewerStage file={getDeckFile()} />)
		const frame = getDeckFrame()
		const srcDoc = frame.getAttribute('srcdoc') ?? ''
		expect(srcDoc).toContain(VIEWER_GOTO_PAGE_MESSAGE)
		// Slice 1's reporter rides the same injection, and one meta means the
		// controller did not get its own injectIntoHtml call.
		expect(srcDoc).toContain(VIEWER_DOC_SIZE_MESSAGE)
		expect(srcDoc.match(/<meta http-equiv="Content-Security-Policy"/g)).toHaveLength(1)
		// criterion 6: the sandbox posture Slice 1 set is unchanged for decks
		expect(frame.getAttribute('sandbox')).toBe('allow-scripts')
		expect(frame.getAttribute('sandbox')).not.toMatch(/allow-same-origin/)
	})

	it('omits the paging controller from a plain document', () => {
		render(<ViewerStage file={buildHtmlFile()} />)
		const frame = screen.getByTitle('Preview of mockup.html') as HTMLIFrameElement
		expect(frame.getAttribute('srcdoc') ?? '').not.toContain(VIEWER_GOTO_PAGE_MESSAGE)
	})

	it('advances then rewinds the page on → / ← and reports each navigation', () => {
		const outerHandler = vi.fn()
		render(
			<div onKeyDown={outerHandler}>
				<ViewerStage file={getDeckFile()} />
			</div>,
		)
		const frame = getDeckFrame()
		const post = vi.spyOn(frame.contentWindow as Window, 'postMessage')
		reportPage(frame, 0, 3)

		fireEvent.keyDown(getStage(), { key: 'ArrowRight' })
		expect(post).toHaveBeenLastCalledWith({ type: VIEWER_GOTO_PAGE_MESSAGE, page: 1 }, '*')
		// the event is 1-based while the frame protocol is 0-based
		expect(trackFileViewerPageNavigated).toHaveBeenLastCalledWith({
			file_id: 'file-1',
			from_page: 1,
			to_page: 2,
			total_pages: 3,
		})

		fireEvent.keyDown(getStage(), { key: 'ArrowLeft' })
		expect(post).toHaveBeenLastCalledWith({ type: VIEWER_GOTO_PAGE_MESSAGE, page: 0 }, '*')
		expect(trackFileViewerPageNavigated).toHaveBeenLastCalledWith({
			file_id: 'file-1',
			from_page: 2,
			to_page: 1,
			total_pages: 3,
		})

		expect(outerHandler).not.toHaveBeenCalled()
	})

	it('treats space / PageDown / PageUp as page navigation without leaking', () => {
		const outerHandler = vi.fn()
		render(
			<div onKeyDown={outerHandler}>
				<ViewerStage file={getDeckFile()} />
			</div>,
		)
		const frame = getDeckFrame()
		const post = vi.spyOn(frame.contentWindow as Window, 'postMessage')
		reportPage(frame, 0, 4)

		fireEvent.keyDown(getStage(), { key: ' ' })
		expect(post).toHaveBeenLastCalledWith({ type: VIEWER_GOTO_PAGE_MESSAGE, page: 1 }, '*')
		fireEvent.keyDown(getStage(), { key: 'PageDown' })
		expect(post).toHaveBeenLastCalledWith({ type: VIEWER_GOTO_PAGE_MESSAGE, page: 2 }, '*')
		fireEvent.keyDown(getStage(), { key: 'PageUp' })
		expect(post).toHaveBeenLastCalledWith({ type: VIEWER_GOTO_PAGE_MESSAGE, page: 1 }, '*')

		expect(outerHandler).not.toHaveBeenCalled()
		expect(trackFileViewerPageNavigated).toHaveBeenCalledTimes(3)
	})

	it('clamps at the deck edges instead of navigating past them', () => {
		render(<ViewerStage file={getDeckFile()} />)
		const frame = getDeckFrame()
		const post = vi.spyOn(frame.contentWindow as Window, 'postMessage')
		reportPage(frame, 0, 3)
		post.mockClear()

		fireEvent.keyDown(getStage(), { key: 'ArrowLeft' })
		expect(post).not.toHaveBeenCalled()
		expect(trackFileViewerPageNavigated).not.toHaveBeenCalled()
	})

	it('leaves arrow keys to native scroll in a plain document', () => {
		const outerHandler = vi.fn()
		render(
			<div onKeyDown={outerHandler}>
				<ViewerStage file={buildHtmlFile()} />
			</div>,
		)
		fireEvent.keyDown(getStage(), { key: 'ArrowRight' })
		expect(outerHandler).toHaveBeenCalledTimes(1)
		expect(trackFileViewerPageNavigated).not.toHaveBeenCalled()
	})
})

describe('ViewerStage — thumbnail rail (Slice 2b)', () => {
	function getDeckFile(): FileDetail {
		return buildHtmlFile({ name: 'deck.deck.html' })
	}

	function getDeckFrame(): HTMLIFrameElement {
		return screen.getByTitle('Preview of deck.deck.html') as HTMLIFrameElement
	}

	function reportPage(iframe: HTMLIFrameElement, index: number, total: number) {
		act(() => {
			window.dispatchEvent(
				new MessageEvent('message', {
					source: iframe.contentWindow,
					data: { type: VIEWER_PAGE_MESSAGE, index, total, w: 1440, h: 900 },
				}),
			)
		})
	}

	beforeEach(() => {
		vi.mocked(trackFileViewerPageNavigated).mockClear()
	})

	it('is hidden for a non-paged doc', () => {
		render(<ViewerStage file={buildHtmlFile()} />)
		expect(screen.queryByRole('tablist', { name: 'Page thumbnails' })).not.toBeInTheDocument()
	})

	it('is hidden for a paged doc until the controller reports its pages', () => {
		render(<ViewerStage file={getDeckFile()} />)
		expect(screen.queryByRole('tablist', { name: 'Page thumbnails' })).not.toBeInTheDocument()
	})

	it('lists one thumbnail per page once the controller reports', () => {
		render(<ViewerStage file={getDeckFile()} />)
		reportPage(getDeckFrame(), 0, 4)
		const rail = screen.getByRole('tablist', { name: 'Page thumbnails' })
		expect(rail).toBeInTheDocument()
		expect(rail.querySelectorAll('[role="tab"]')).toHaveLength(4)
		expect(screen.getByRole('tab', { name: 'Go to page 1 of 4' })).toHaveAttribute(
			'aria-selected',
			'true',
		)
	})

	it('is hidden for a single-page deck (nothing to navigate to)', () => {
		render(<ViewerStage file={getDeckFile()} />)
		reportPage(getDeckFrame(), 0, 1)
		expect(screen.queryByRole('tablist', { name: 'Page thumbnails' })).not.toBeInTheDocument()
	})

	it('drives showPage via the same VIEWER_GOTO_PAGE_MESSAGE path as keyboard nav', () => {
		render(<ViewerStage file={getDeckFile()} />)
		const frame = getDeckFrame()
		reportPage(frame, 0, 3)
		const post = vi.spyOn(frame.contentWindow as Window, 'postMessage')

		fireEvent.click(screen.getByRole('tab', { name: 'Go to page 3 of 3' }))
		expect(post).toHaveBeenLastCalledWith({ type: VIEWER_GOTO_PAGE_MESSAGE, page: 2 }, '*')
		expect(trackFileViewerPageNavigated).toHaveBeenLastCalledWith({
			file_id: 'file-1',
			from_page: 1,
			to_page: 3,
			total_pages: 3,
		})
	})

	it('reflects the active slide when the controller reports a page change', () => {
		render(<ViewerStage file={getDeckFile()} />)
		const frame = getDeckFrame()
		reportPage(frame, 0, 3)
		reportPage(frame, 1, 3)
		expect(screen.getByRole('tab', { name: 'Go to page 2 of 3' })).toHaveAttribute(
			'aria-selected',
			'true',
		)
	})
})
