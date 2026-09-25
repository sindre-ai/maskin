import { EmptyState } from '@/components/shared/empty-state'
import { MarkdownContent } from '@/components/shared/markdown-content'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import {
	type FileViewerZoomMode,
	trackFileViewerPageNavigated,
	trackFileViewerZoomUsed,
} from '@/lib/analytics'
import type { FileDetail } from '@/lib/api'
import { base64ToBytes, decodeBase64Utf8, downloadFile } from '@/lib/file-utils'
import {
	VIEWER_DOC_SIZE_MESSAGE,
	VIEWER_GOTO_PAGE_MESSAGE,
	VIEWER_PAGE_MESSAGE,
	VIEWER_WHEEL_MESSAGE,
	prepareViewerHtml,
} from '@/lib/mini-app'
import {
	type Size,
	ZOOM_MAX,
	ZOOM_MIN,
	clampZoom,
	computeFit,
	zoomAt,
	zoomStep,
} from '@/lib/viewer-coord-math'
import { resolveViewerVariant } from '@/lib/viewer-detect'
import { AlertTriangle, Code, Download, Maximize2, Minus, Plus } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { isHtml, isInlineImage, isMarkdown, isPlainText } from './file-body'

// 8 seconds is the spec's `iframe-blocked` timeout: the sandboxed frame that
// never posts a doc-size message (agent CSP that blocks the reporter, empty
// document, malformed HTML) falls back to the empty-state tile so the user
// isn't left staring at a blank grey stage forever.
const IFRAME_BLOCKED_TIMEOUT_MS = 8000

// Two-decimal rounding for the zoom-level property on `file_viewer_zoom_used`.
// The observability spec keys off zoom_level as a float, but the pinch/wheel
// path can emit dozens of events per second and 12 significant figures is
// pointless noise for the metric.
function roundZoom(k: number): number {
	return Math.round(k * 100) / 100
}

interface ViewerStageProps {
	file: FileDetail
}

export function ViewerStage({ file }: ViewerStageProps) {
	if (isHtml(file.mimeType)) return <HtmlViewerStage file={file} />
	if (isMarkdown(file.mimeType)) return <MarkdownViewerStage file={file} />
	if (isInlineImage(file.mimeType)) return <ImageViewerStage file={file} />
	if (isPlainText(file.mimeType)) return <TextViewerStage file={file} />
	return (
		<StageFrame>
			<div className="flex h-full w-full items-center justify-center p-8">
				<EmptyState
					title="Preview not available"
					description={`Files of type ${file.mimeType} can't be previewed here. Use the download action to open them locally.`}
				/>
			</div>
		</StageFrame>
	)
}

function StageFrame({ children }: { children: React.ReactNode }) {
	// Every mode renders inside this bg-muted stage so the full-bleed shell
	// reads consistently regardless of file type — the wrapper is what makes
	// dropping `max-w-3xl mx-auto` from the route body coherent.
	return <div className="relative flex h-full w-full flex-1 bg-muted">{children}</div>
}

function fileText(file: FileDetail): string {
	return file.encoding === 'utf8' ? file.content : decodeBase64Utf8(file.content)
}

function MarkdownViewerStage({ file }: { file: FileDetail }) {
	return (
		<StageFrame>
			<div className="h-full w-full overflow-auto">
				<div className="mx-auto max-w-3xl px-6 py-8">
					<MarkdownContent content={fileText(file)} />
				</div>
			</div>
		</StageFrame>
	)
}

function TextViewerStage({ file }: { file: FileDetail }) {
	return (
		<StageFrame>
			<div className="h-full w-full overflow-auto">
				<div className="mx-auto max-w-4xl px-6 py-8">
					<pre className="rounded-md border border-border bg-card p-4 text-xs font-mono whitespace-pre-wrap break-words text-foreground">
						{fileText(file)}
					</pre>
				</div>
			</div>
		</StageFrame>
	)
}

function ImageViewerStage({ file }: { file: FileDetail }) {
	// Base64 for binary bytes; utf8 files that happen to be image-typed still
	// b64-encode inline. Same fallback pattern as file-body.tsx.
	const src = useMemo(() => {
		if (file.encoding === 'base64') return `data:${file.mimeType};base64,${file.content}`
		return URL.createObjectURL(
			new Blob([base64ToBytes(btoa(file.content)).buffer as ArrayBuffer], {
				type: file.mimeType,
			}),
		)
	}, [file.content, file.encoding, file.mimeType])
	return (
		<StageFrame>
			<div className="flex h-full w-full items-center justify-center overflow-auto p-6">
				<img src={src} alt={file.name} className="max-h-full max-w-full object-contain" />
			</div>
		</StageFrame>
	)
}

function HtmlViewerStage({ file }: { file: FileDetail }) {
	const html = useMemo(() => fileText(file), [file])
	// Variant resolution (viewer-detect.ts) decides whether a paging controller
	// is injected. A `deck` gets one; every other variant keeps the plain
	// document path. The override slot is `null` for Slice 2a — the viewport
	// preset / ⋯ menu that sets it lands in Slice 2c.
	const isPaged = useMemo(
		() => resolveViewerVariant({ filename: file.name, html, override: null }) === 'deck',
		[file.name, html],
	)
	const srcDoc = useMemo(() => prepareViewerHtml(html, { paged: isPaged }), [html, isPaged])

	const viewportRef = useRef<HTMLDivElement>(null)
	const iframeRef = useRef<HTMLIFrameElement>(null)

	// Natural document size reported by the injected doc-size reporter (see
	// prepareViewerHtml in mini-app.ts). `null` = not yet reported, so the
	// stage sits in the loading-into-fit state and can't compute k yet.
	const [docSize, setDocSize] = useState<Size | null>(null)
	// For a paged doc the doc-size reporter's numbers come from
	// documentElement — meaningless when one slide is on screen. The paging
	// controller instead reports the ACTIVE slide's box (VIEWER_PAGE_MESSAGE),
	// and that is what fit k is derived from. `null` for non-paged docs.
	const [page, setPage] = useState<{ index: number; total: number } | null>(null)
	const [pageSize, setPageSize] = useState<Size | null>(null)
	const [viewportSize, setViewportSize] = useState<Size | null>(null)
	const [zoom, setZoom] = useState<number>(ZOOM_MIN)
	// Whether the current `zoom` was chosen automatically (fit) or by the user.
	// Auto-fits recompute when the viewport resizes; a manual zoom sticks.
	const zoomIsAutoFitRef = useRef(true)
	// The 8s iframe-blocked timeout fires when no doc-size message has arrived
	// (agent HTML blocked the reporter, empty doc, malformed markup). `blocked`
	// short-circuits to the fallback tile.
	const [blocked, setBlocked] = useState(false)

	// Track the viewport size so computeFit re-derives k on window resize / a
	// sidebar toggle that changes the stage width. ResizeObserver is the
	// invariant-preserving choice — window resize alone misses layout shifts
	// upstream of the viewport.
	useLayoutEffect(() => {
		const el = viewportRef.current
		if (!el) return
		const update = () => {
			setViewportSize({ w: el.clientWidth, h: el.clientHeight })
		}
		update()
		const observer = new ResizeObserver(update)
		observer.observe(el)
		return () => observer.disconnect()
	}, [])

	// Listen for the sandbox reporter's posts: doc-size on load + resize, and
	// forwarded wheel events (see VIEWER_WHEEL_MESSAGE in mini-app.ts for why
	// forwarding is required at all). The frame has null origin so origin-based
	// filtering isn't possible; source-window comparison against our own iframe
	// ref is the invariant that keeps a hostile ad frame or browser extension
	// from feeding fake payloads into the zoom/scroll path.
	useEffect(() => {
		function onMessage(event: MessageEvent) {
			const iframe = iframeRef.current
			if (!iframe || event.source !== iframe.contentWindow) return
			const data = event.data as {
				type?: string
				w?: number
				h?: number
				index?: number
				total?: number
				deltaX?: number
				deltaY?: number
				ctrlKey?: boolean
				docX?: number
				docY?: number
			} | null
			if (!data) return
			if (data.type === VIEWER_DOC_SIZE_MESSAGE) {
				const w = typeof data.w === 'number' ? data.w : 0
				const h = typeof data.h === 'number' ? data.h : 0
				if (w <= 0 || h <= 0) return
				setDocSize({ w, h })
				return
			}
			if (data.type === VIEWER_PAGE_MESSAGE) {
				const total = typeof data.total === 'number' ? data.total : 0
				const index = typeof data.index === 'number' ? data.index : 0
				if (total <= 0) return
				setPage({ index: Math.max(0, index), total })
				const w = typeof data.w === 'number' ? data.w : 0
				const h = typeof data.h === 'number' ? data.h : 0
				if (w > 0 && h > 0) setPageSize({ w, h })
				return
			}
			if (data.type === VIEWER_WHEEL_MESSAGE) {
				wheelFromFrameRef.current({
					deltaX: typeof data.deltaX === 'number' ? data.deltaX : 0,
					deltaY: typeof data.deltaY === 'number' ? data.deltaY : 0,
					ctrlKey: !!data.ctrlKey,
					docX: typeof data.docX === 'number' ? data.docX : 0,
					docY: typeof data.docY === 'number' ? data.docY : 0,
				})
			}
		}
		window.addEventListener('message', onMessage)
		return () => window.removeEventListener('message', onMessage)
	}, [])

	// Iframe-blocked timeout. Starts on mount / srcDoc change; cancelled the
	// moment the first doc-size message lands (which is proof the reporter ran).
	// The timer reads `docSize` through a ref so the effect only reruns on
	// srcDoc change — otherwise every message-driven docSize update would
	// re-arm the timer.
	const docSizeRef = useRef<Size | null>(null)
	useEffect(() => {
		docSizeRef.current = docSize
	}, [docSize])
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-arm the timer only on a new document — the body reads docSize through a ref, not the state
	useEffect(() => {
		setBlocked(false)
		setDocSize(null)
		setPage(null)
		setPageSize(null)
		docSizeRef.current = null
		const timer = window.setTimeout(() => {
			if (!docSizeRef.current) setBlocked(true)
		}, IFRAME_BLOCKED_TIMEOUT_MS)
		return () => window.clearTimeout(timer)
	}, [srcDoc])

	// The box fit k is derived from: for a paged doc that is the visible
	// slide's own box (criterion 3) — a deck's documentElement dimensions are
	// meaningless when exactly one slide is on screen. Non-paged docs fall back
	// to the whole document.
	const fitSize = isPaged ? pageSize : docSize

	// Once both the fit box and viewport size are known, do the initial fit.
	// Also re-fit on viewport resize as long as the user hasn't manually zoomed.
	useEffect(() => {
		if (!fitSize || !viewportSize) return
		if (!zoomIsAutoFitRef.current) return
		setZoom(computeFit(fitSize, viewportSize))
	}, [fitSize, viewportSize])

	const emitZoom = useCallback(
		(mode: FileViewerZoomMode, k: number) => {
			trackFileViewerZoomUsed({ file_id: file.id, mode, zoom_level: roundZoom(k) })
		},
		[file.id],
	)

	const handleFit = useCallback(() => {
		if (!fitSize || !viewportSize) return
		const next = computeFit(fitSize, viewportSize)
		zoomIsAutoFitRef.current = true
		setZoom(next)
		emitZoom('fit', next)
	}, [fitSize, viewportSize, emitZoom])

	const handleStepZoom = useCallback(
		(dir: 'in' | 'out') => {
			const next = zoomStep(zoom, dir)
			zoomIsAutoFitRef.current = false
			setZoom(next)
			emitZoom(dir === 'in' ? 'plus' : 'minus', next)
		},
		[zoom, emitZoom],
	)

	// Page navigation. Commands the injected controller over postMessage and
	// emits file_viewer_page_navigated (criterion 5). Page numbers on the event
	// are 1-based (page 1 of N) while the frame protocol is 0-based — the
	// analytics consumer sees human page numbers.
	const gotoPage = useCallback(
		(nextIndex: number) => {
			if (!isPaged || !page) return
			const next = Math.max(0, Math.min(nextIndex, page.total - 1))
			const from = page.index
			if (next === from) return
			const frame = iframeRef.current
			if (frame?.contentWindow) {
				frame.contentWindow.postMessage({ type: VIEWER_GOTO_PAGE_MESSAGE, page: next }, '*')
			}
			setPage({ index: next, total: page.total })
			// A new slide gets a fresh auto-fit — its box may differ from the
			// previous slide's. Manual zoom still sticks once the user steps it.
			zoomIsAutoFitRef.current = true
			if (fitSize && viewportSize) setZoom(computeFit(fitSize, viewportSize))
			trackFileViewerPageNavigated({
				file_id: file.id,
				from_page: from + 1,
				to_page: next + 1,
				total_pages: page.total,
			})
		},
		[isPaged, page, fitSize, viewportSize, file.id],
	)

	// Wheel-with-Ctrl and trackpad pinch: the browser reports pinch gestures as
	// wheel events with `ctrlKey` set even without any modifier key pressed, so
	// one handler covers both. Zoom-around-a-point via zoomAt so the doc point
	// under the cursor stays fixed under the cursor after k changes.
	//
	// This handler is bound natively (see the effect below), not through React's
	// `onWheel` prop: React 19 attaches wheel listeners at the root as passive,
	// so `preventDefault()` inside a React handler is a no-op and the browser's
	// own Ctrl+wheel page zoom wins instead of ours.
	const handleWheel = useCallback(
		(event: WheelEvent) => {
			if (!event.ctrlKey) return
			event.preventDefault()
			const viewport = viewportRef.current
			if (!viewport) return
			const rect = viewport.getBoundingClientRect()
			const cursor = { x: event.clientX - rect.left, y: event.clientY - rect.top }
			// deltaY < 0 (scroll up / pinch out) zooms in.
			const factor = Math.exp(-event.deltaY / 300)
			const result = zoomAt(zoom, zoom * factor, cursor, {
				x: viewport.scrollLeft,
				y: viewport.scrollTop,
			})
			zoomIsAutoFitRef.current = false
			setZoom(result.k)
			// The scroll offset must be applied *after* the layout resizes to
			// (Dw*k, Dh*k) — a rAF is enough because the state update paints
			// on the same frame that runs the callback.
			requestAnimationFrame(() => {
				const el = viewportRef.current
				if (!el) return
				el.scrollLeft = Math.max(0, result.scroll.x)
				el.scrollTop = Math.max(0, result.scroll.y)
			})
			// The gesture source distinction (`pinch` vs `wheel`) is what the
			// spec's observability contract asks for. `ctrlKey` alone can't tell
			// them apart, but wheel events synthesised from a trackpad pinch
			// always carry sub-pixel `deltaY` — a fractional delta is the
			// browser tell that this is a pinch, not a mouse wheel.
			const mode: FileViewerZoomMode = Number.isInteger(event.deltaY) ? 'wheel' : 'pinch'
			emitZoom(mode, result.k)
		},
		[zoom, emitZoom],
	)

	// Keep the latest handler in a ref so the native listener can be attached
	// once per viewport (not re-attached on every zoom change) while still
	// calling the current closure — the handler reads `zoom` from state.
	const wheelHandlerRef = useRef(handleWheel)
	useEffect(() => {
		wheelHandlerRef.current = handleWheel
	}, [handleWheel])
	useEffect(() => {
		if (blocked) return
		const el = viewportRef.current
		if (!el) return
		const onWheel = (event: WheelEvent) => wheelHandlerRef.current(event)
		// `passive: false` is the whole point: it lets preventDefault() suppress
		// the browser's Ctrl+wheel page zoom so our stage zoom is the only one.
		el.addEventListener('wheel', onWheel, { passive: false })
		return () => el.removeEventListener('wheel', onWheel)
	}, [blocked])

	// Wheel handler for events forwarded from *inside* the sandboxed iframe via
	// postMessage (see VIEWER_WHEEL_MESSAGE in mini-app.ts). The native listener
	// above only catches wheels that landed on bare stage area (letterbox);
	// wheels over the document itself fire in the frame's own browsing context
	// and never bubble out, so this path is what makes ctrl+wheel zoom and
	// plain-scroll pan work where a user actually points.
	//
	// The `docX/docY` coordinates arrive in the iframe's own unscaled document
	// space. Converting them to the viewport-screen coord space that `zoomAt`
	// operates in is `docX * zoom - viewport.scrollLeft`: the scaled iframe
	// occupies [0..docSize.w*zoom, 0..docSize.h*zoom] in the viewport's scroll
	// area, and the viewport-screen coord is that pre-scroll position minus
	// the current scroll offset.
	const handleFrameWheel = useCallback(
		(data: { deltaX: number; deltaY: number; ctrlKey: boolean; docX: number; docY: number }) => {
			const viewport = viewportRef.current
			if (!viewport) return
			if (data.ctrlKey) {
				const cursor = {
					x: data.docX * zoom - viewport.scrollLeft,
					y: data.docY * zoom - viewport.scrollTop,
				}
				const factor = Math.exp(-data.deltaY / 300)
				const result = zoomAt(zoom, zoom * factor, cursor, {
					x: viewport.scrollLeft,
					y: viewport.scrollTop,
				})
				zoomIsAutoFitRef.current = false
				setZoom(result.k)
				requestAnimationFrame(() => {
					const el = viewportRef.current
					if (!el) return
					el.scrollLeft = Math.max(0, result.scroll.x)
					el.scrollTop = Math.max(0, result.scroll.y)
				})
				// Same gesture-source heuristic as the native handler: an
				// integer deltaY is a mouse wheel; a fractional one is a
				// trackpad pinch synthesised as ctrlKey+wheel by the browser.
				const mode: FileViewerZoomMode = Number.isInteger(data.deltaY) ? 'wheel' : 'pinch'
				emitZoom(mode, result.k)
				return
			}
			// Plain wheel over the document pans the viewport — the iframe has
			// no scroll room of its own, so without this the gesture is dead.
			viewport.scrollLeft = Math.max(0, viewport.scrollLeft + data.deltaX)
			viewport.scrollTop = Math.max(0, viewport.scrollTop + data.deltaY)
		},
		[zoom, emitZoom],
	)
	const wheelFromFrameRef = useRef(handleFrameWheel)
	useEffect(() => {
		wheelFromFrameRef.current = handleFrameWheel
	}, [handleFrameWheel])

	// Fullscreen the *shell*, not the iframe — the iframe has no origin so its
	// fullscreen call would be blocked. We toggle the closest fullscreen-eligible
	// element up the tree (the stage frame) so overlays and controls stay reachable.
	const containerRef = useRef<HTMLDivElement>(null)
	// Focus the stage on mount so the keyboard subset (0 / + / - / F / Esc) is
	// live without a click. The stage is the primary surface for an HTML preview,
	// so gating the shortcuts behind a click leaves them inert on arrival.
	useEffect(() => {
		containerRef.current?.focus()
	}, [])
	const toggleFullscreen = useCallback(() => {
		const target = containerRef.current
		if (!target) return
		// jsdom and older browsers lack the Fullscreen API; make the shortcut
		// a no-op there rather than throwing into the shell.
		if (document.fullscreenElement) {
			if (typeof document.exitFullscreen === 'function') {
				document.exitFullscreen().catch(() => {})
			}
		} else if (typeof target.requestFullscreen === 'function') {
			target.requestFullscreen().catch(() => {})
		}
	}, [])

	// Keyboard subset: Slice 1 had `0` = fit, `+` = zoom in, `-` = zoom out,
	// `F` = fullscreen, `Esc` = clear focus (no annotate mode yet). Slice 2a
	// adds `←` / `→` / `space` / `PageUp` / `PageDown` for page nav, but only
	// when the doc is paged. Focus is contained to the stage — the handler
	// lives on this container's onKeyDown so nothing bubbles to the shell's
	// routing / global shortcut listeners.
	const handleKeyDown = useCallback(
		(event: React.KeyboardEvent<HTMLDivElement>) => {
			// Ignore modifier-carrying combos so browser shortcuts (Cmd-R, etc.)
			// still work. `+` / `-` on the numpad don't need shift; on the
			// number row, `Shift` + `=` produces `+`, which we still want to
			// accept.
			if (event.metaKey || event.ctrlKey || event.altKey) return
			const key = event.key
			if (key === '0') {
				event.preventDefault()
				event.stopPropagation()
				handleFit()
			} else if (key === '+' || key === '=') {
				event.preventDefault()
				event.stopPropagation()
				handleStepZoom('in')
			} else if (key === '-' || key === '_') {
				event.preventDefault()
				event.stopPropagation()
				handleStepZoom('out')
			} else if (key === 'f' || key === 'F') {
				event.preventDefault()
				event.stopPropagation()
				toggleFullscreen()
			} else if (key === 'Escape') {
				event.preventDefault()
				event.stopPropagation()
				;(event.currentTarget as HTMLDivElement).blur()
			} else if (isPaged && (key === 'ArrowLeft' || key === 'PageUp')) {
				// Page-nav keys are claimed ONLY for a paged doc: on a plain
				// document they must keep their native scroll behaviour, so they
				// fall through here without preventDefault.
				event.preventDefault()
				event.stopPropagation()
				gotoPage((page?.index ?? 0) - 1)
			} else if (isPaged && (key === 'ArrowRight' || key === 'PageDown' || key === ' ')) {
				event.preventDefault()
				event.stopPropagation()
				gotoPage((page?.index ?? 0) + 1)
			}
		},
		[handleFit, handleStepZoom, toggleFullscreen, isPaged, page, gotoPage],
	)

	const scaledSize = useMemo(() => {
		if (!fitSize) return null
		return { w: fitSize.w * zoom, h: fitSize.h * zoom }
	}, [fitSize, zoom])

	return (
		<StageFrame>
			{/* role="application" is the correct role for a keyboard-driven stage:
			    the shell owns the shortcut set (0 / + / - / F / Esc) and swallows
			    those keys before the browser or shell see them. tabIndex={0} puts
			    the stage in the natural tab order and is focused on mount, so the
			    shortcuts are live the moment the preview opens. `bg-muted` here
			    (not just on the outer StageFrame) matters for fullscreen: the
			    browser fullscreens this element, and without its own background
			    the letterbox area around the scaled document renders black. */}
			<div
				ref={containerRef}
				className="relative flex h-full w-full flex-col bg-muted outline-none focus-visible:ring-1 focus-visible:ring-ring"
				role="application"
				// biome-ignore lint/a11y/noNoninteractiveTabindex: role="application" is a focusable keyboard-driven region — the stage owns the shortcut set and is focused on mount
				tabIndex={0}
				onKeyDown={handleKeyDown}
				aria-label={`Viewer for ${file.name}`}
				data-viewer-state={blocked ? 'iframe-blocked' : fitSize ? 'ready' : 'loading'}
			>
				{blocked ? (
					<IframeBlockedFallback file={file} />
				) : (
					<div ref={viewportRef} className="relative flex-1 overflow-auto">
						{!fitSize && (
							<div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
								<Spinner className="size-6 text-muted-foreground" />
							</div>
						)}
						<div
							style={{
								width: scaledSize?.w ?? '100%',
								height: scaledSize?.h ?? '100%',
								position: 'relative',
							}}
						>
							<iframe
								ref={iframeRef}
								title={`Preview of ${file.name}`}
								srcDoc={srcDoc}
								// `allow-scripts` only — no `allow-same-origin`,
								// so the frame's fetch/XHR sees a null origin and
								// same-origin checks against the app fail closed.
								// The reporter script runs inside this sandbox.
								sandbox="allow-scripts"
								style={{
									width: fitSize?.w ?? '100%',
									height: fitSize?.h ?? '100%',
									transform: fitSize ? `scale(${zoom})` : undefined,
									transformOrigin: '0 0',
									border: 0,
									display: 'block',
								}}
							/>
						</div>
					</div>
				)}
				{fitSize && !blocked && (
					<ZoomControls
						zoom={zoom}
						onFit={handleFit}
						onStep={handleStepZoom}
						canFit={!!viewportSize}
					/>
				)}
			</div>
		</StageFrame>
	)
}

function ZoomControls({
	zoom,
	onFit,
	onStep,
	canFit,
}: {
	zoom: number
	onFit: () => void
	onStep: (dir: 'in' | 'out') => void
	canFit: boolean
}) {
	const percent = Math.round(zoom * 100)
	return (
		<div className="pointer-events-none absolute bottom-4 right-4 z-10 flex items-center gap-1 rounded-md border border-border bg-card p-1 shadow-md">
			<div className="pointer-events-auto flex items-center gap-1">
				<Button
					type="button"
					variant="ghost"
					size="sm"
					onClick={() => onStep('out')}
					disabled={zoom <= ZOOM_MIN}
					aria-label="Zoom out"
				>
					<Minus size={14} />
				</Button>
				<span
					className="min-w-12 text-center text-xs font-mono tabular-nums text-muted-foreground"
					aria-live="polite"
				>
					{percent}%
				</span>
				<Button
					type="button"
					variant="ghost"
					size="sm"
					onClick={() => onStep('in')}
					disabled={zoom >= ZOOM_MAX}
					aria-label="Zoom in"
				>
					<Plus size={14} />
				</Button>
				<Button
					type="button"
					variant="ghost"
					size="sm"
					onClick={onFit}
					disabled={!canFit}
					aria-label="Fit to screen"
				>
					<Maximize2 size={14} />
				</Button>
			</div>
		</div>
	)
}

function IframeBlockedFallback({ file }: { file: FileDetail }) {
	// The blocked tile is the one surface a user reaches when the sandbox never
	// reported a doc size, so it has to offer a way forward that doesn't depend on
	// the frame rendering. View source opens the raw text as a text/plain blob —
	// reusing the file's own text/html mime here would render and execute the
	// document in the app origin, which is exactly what the sandbox prevents.
	// Revoke on a delay rather than immediately: the new tab reads the blob URL
	// during its own navigation, so a synchronous revoke can race the load.
	const handleViewSource = useCallback(() => {
		const blob = new Blob([fileText(file)], { type: 'text/plain' })
		const url = URL.createObjectURL(blob)
		window.open(url, '_blank', 'noopener,noreferrer')
		window.setTimeout(() => URL.revokeObjectURL(url), 1000)
	}, [file])
	return (
		<div className="flex h-full w-full items-center justify-center p-8">
			<div className="max-w-md rounded-md border border-border bg-card p-6 text-center shadow-sm">
				<div className="mx-auto mb-3 flex h-8 w-8 items-center justify-center rounded-full bg-warning/10 text-warning">
					<AlertTriangle size={16} />
				</div>
				<h2 className="text-sm font-semibold text-foreground">Preview didn't load</h2>
				<p className="mt-1 text-xs text-muted-foreground">
					The document didn't respond within 8 seconds — it may be blocked by its own
					content-security policy or otherwise fail to render inside the sandbox. Open the source or
					download <span className="font-medium text-foreground">{file.name}</span> to read it
					locally.
				</p>
				<div className="mt-4 flex items-center justify-center gap-2">
					<Button type="button" variant="outline" size="sm" onClick={handleViewSource}>
						<Code size={14} />
						View source
					</Button>
					<Button type="button" variant="default" size="sm" onClick={() => downloadFile(file)}>
						<Download size={14} />
						Download
					</Button>
				</div>
			</div>
		</div>
	)
}

// Re-export the clamp helpers so shell tests can assert boundary state without
// pulling from viewer-coord-math directly.
export { clampZoom, ZOOM_MIN, ZOOM_MAX }
