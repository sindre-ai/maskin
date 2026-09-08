import { EmptyState } from '@/components/shared/empty-state'
import { MarkdownContent } from '@/components/shared/markdown-content'
import { Button } from '@/components/ui/button'
import { type FileViewerZoomMode, trackFileViewerZoomUsed } from '@/lib/analytics'
import type { FileDetail } from '@/lib/api'
import { base64ToBytes, decodeBase64Utf8 } from '@/lib/file-utils'
import { VIEWER_DOC_SIZE_MESSAGE, prepareViewerHtml } from '@/lib/mini-app'
import {
	type Size,
	ZOOM_MAX,
	ZOOM_MIN,
	clampZoom,
	computeFit,
	zoomAt,
	zoomStep,
} from '@/lib/viewer-coord-math'
import { AlertTriangle, Maximize2, Minus, Plus } from 'lucide-react'
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
	const srcDoc = useMemo(() => prepareViewerHtml(html), [html])

	const viewportRef = useRef<HTMLDivElement>(null)
	const iframeRef = useRef<HTMLIFrameElement>(null)

	// Natural document size reported by the injected doc-size reporter (see
	// prepareViewerHtml in mini-app.ts). `null` = not yet reported, so the
	// stage sits in the loading-into-fit state and can't compute k yet.
	const [docSize, setDocSize] = useState<Size | null>(null)
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

	// Listen for the sandbox reporter's doc-size posts. Filter is the
	// namespaced type token (VIEWER_DOC_SIZE_MESSAGE) — this listener only
	// runs while the stage is mounted, and the only sender of that token is
	// the reporter script injected via prepareViewerHtml.
	useEffect(() => {
		function onMessage(event: MessageEvent) {
			const data = event.data as { type?: string; w?: number; h?: number } | null
			if (!data || data.type !== VIEWER_DOC_SIZE_MESSAGE) return
			const w = typeof data.w === 'number' ? data.w : 0
			const h = typeof data.h === 'number' ? data.h : 0
			if (w <= 0 || h <= 0) return
			setDocSize({ w, h })
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
		docSizeRef.current = null
		const timer = window.setTimeout(() => {
			if (!docSizeRef.current) setBlocked(true)
		}, IFRAME_BLOCKED_TIMEOUT_MS)
		return () => window.clearTimeout(timer)
	}, [srcDoc])

	// Once both the doc size and viewport size are known, do the initial fit.
	// Also re-fit on viewport resize as long as the user hasn't manually zoomed.
	useEffect(() => {
		if (!docSize || !viewportSize) return
		if (!zoomIsAutoFitRef.current) return
		setZoom(computeFit(docSize, viewportSize))
	}, [docSize, viewportSize])

	const emitZoom = useCallback(
		(mode: FileViewerZoomMode, k: number) => {
			trackFileViewerZoomUsed({ file_id: file.id, mode, zoom_level: roundZoom(k) })
		},
		[file.id],
	)

	const handleFit = useCallback(() => {
		if (!docSize || !viewportSize) return
		const next = computeFit(docSize, viewportSize)
		zoomIsAutoFitRef.current = true
		setZoom(next)
		emitZoom('fit', next)
	}, [docSize, viewportSize, emitZoom])

	const handleStepZoom = useCallback(
		(dir: 'in' | 'out') => {
			const next = zoomStep(zoom, dir)
			zoomIsAutoFitRef.current = false
			setZoom(next)
			emitZoom(dir === 'in' ? 'plus' : 'minus', next)
		},
		[zoom, emitZoom],
	)

	// Wheel-with-Ctrl and trackpad pinch: the browser reports pinch gestures as
	// wheel events with `ctrlKey` set even without any modifier key pressed, so
	// one handler covers both. Zoom-around-a-point via zoomAt so the doc point
	// under the cursor stays fixed under the cursor after k changes.
	const handleWheel = useCallback(
		(event: React.WheelEvent<HTMLDivElement>) => {
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

	// Fullscreen the *shell*, not the iframe — the iframe has no origin so its
	// fullscreen call would be blocked. We toggle the closest fullscreen-eligible
	// element up the tree (the stage frame) so overlays and controls stay reachable.
	const containerRef = useRef<HTMLDivElement>(null)
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

	// Keyboard subset for Slice 1: `0` = fit, `+` = zoom in, `-` = zoom out,
	// `F` = fullscreen, `Esc` = clear focus (no annotate mode yet). Focus is
	// contained to the stage — the handler lives on this container's onKeyDown
	// so nothing bubbles to the shell's routing / global shortcut listeners.
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
			}
		},
		[handleFit, handleStepZoom, toggleFullscreen],
	)

	const scaledSize = useMemo(() => {
		if (!docSize) return null
		return { w: docSize.w * zoom, h: docSize.h * zoom }
	}, [docSize, zoom])

	return (
		<StageFrame>
			{/* role="application" is the correct role for a keyboard-driven stage:
			    the shell owns the shortcut set (0 / + / - / F / Esc) and swallows
			    those keys before the browser or shell see them. tabIndex={-1} keeps
			    the stage focusable-on-click without adding it to the natural tab
			    order — Tab from the shell keeps flowing through the top-bar actions,
			    and clicking into the stage still activates the keyboard subset. */}
			<div
				ref={containerRef}
				className="relative flex h-full w-full flex-col outline-none focus-visible:ring-1 focus-visible:ring-ring"
				role="application"
				tabIndex={-1}
				onKeyDown={handleKeyDown}
				aria-label={`Viewer for ${file.name}`}
				data-viewer-state={blocked ? 'iframe-blocked' : docSize ? 'ready' : 'loading'}
			>
				{blocked ? (
					<IframeBlockedFallback file={file} />
				) : (
					<div ref={viewportRef} className="relative flex-1 overflow-auto" onWheel={handleWheel}>
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
									width: docSize?.w ?? '100%',
									height: docSize?.h ?? '100%',
									transform: docSize ? `scale(${zoom})` : undefined,
									transformOrigin: '0 0',
									border: 0,
									display: 'block',
								}}
							/>
						</div>
					</div>
				)}
				{docSize && !blocked && (
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
		<div className="pointer-events-none absolute bottom-4 right-4 z-10 flex items-center gap-1 rounded-md border border-border bg-card/95 p-1 shadow-md backdrop-blur-sm">
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
	return (
		<div className="flex h-full w-full items-center justify-center p-8">
			<div className="max-w-md rounded-md border border-border bg-card p-6 text-center shadow-sm">
				<div className="mx-auto mb-3 flex h-8 w-8 items-center justify-center rounded-full bg-warning/10 text-warning">
					<AlertTriangle size={16} />
				</div>
				<h2 className="text-sm font-semibold text-foreground">Preview didn't load</h2>
				<p className="mt-1 text-xs text-muted-foreground">
					The document didn't respond within 8 seconds — it may be blocked by its own
					content-security policy or otherwise fail to render inside the sandbox. Use the download
					action to open <span className="font-medium text-foreground">{file.name}</span> locally.
				</p>
			</div>
		</div>
	)
}

// Re-export the clamp helpers so shell tests can assert boundary state without
// pulling from viewer-coord-math directly.
export { clampZoom, ZOOM_MIN, ZOOM_MAX }
