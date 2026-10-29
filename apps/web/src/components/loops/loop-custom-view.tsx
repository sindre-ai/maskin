import { Skeleton } from '@/components/shared/loading-skeleton'
import { useFile } from '@/hooks/use-files'
import { api } from '@/lib/api'
import { handleBridgeMessage } from '@/lib/loop-view-bridge'
import { BRIDGE_REFRESH_MESSAGE, prepareBridgedViewHtml, readViewSources } from '@/lib/mini-app'
import type { DataQuerySpec } from '@maskin/shared'
import { useEffect, useMemo, useRef, useState } from 'react'

/** How often declared sources are told to refresh while the tab is visible. */
const REFRESH_MS = 30_000
/** Times a view that navigates away from its srcdoc is reset before we give up on it. */
const MAX_FRAME_RESETS = 3
const MIN_HEIGHT = 160

interface LoopCustomViewProps {
	workspaceId: string
	fileId: string
	/** Called when the view cannot be shown (file missing, bad sources, failed query, escaped frame). The loop page then shows its default content. */
	onFailure: (reason: string) => void
}

export function LoopCustomView({ workspaceId, fileId, onFailure }: LoopCustomViewProps) {
	const { data: file, isLoading, isError } = useFile(workspaceId, fileId)
	const html = file?.mimeType.toLowerCase().startsWith('text/html') ? file.content : null
	const sources = useMemo(() => (html === null ? null : readViewSources(html)), [html])

	const failure = isError
		? 'The view file could not be loaded.'
		: file && html === null
			? 'The view file is not an HTML file.'
			: sources && !sources.ok
				? sources.error
				: null
	useEffect(() => {
		if (failure) onFailure(failure)
	}, [failure, onFailure])

	if (isLoading) return <Skeleton className="h-40 w-full" />
	if (html === null || !sources?.ok) return null
	return (
		<ViewFrame
			html={html}
			sources={sources.sources}
			workspaceId={workspaceId}
			onFailure={onFailure}
		/>
	)
}

function ViewFrame({
	html,
	sources,
	workspaceId,
	onFailure,
}: {
	html: string
	sources: ReadonlyMap<string, DataQuerySpec>
	workspaceId: string
	onFailure: (reason: string) => void
}) {
	const iframeRef = useRef<HTMLIFrameElement>(null)
	const [height, setHeight] = useState(MIN_HEIGHT)
	const [frameKey, setFrameKey] = useState(0)
	const loadsRef = useRef(0)
	const resetsRef = useRef(0)
	const blockedRef = useRef(false)
	const srcDoc = useMemo(() => prepareBridgedViewHtml(html), [html])

	// The handler is installed once per workspace; it reads the latest sources
	// and failure callback through refs so a re-render never drops a message.
	const sourcesRef = useRef(sources)
	sourcesRef.current = sources
	const onFailureRef = useRef(onFailure)
	onFailureRef.current = onFailure

	useEffect(() => {
		function onMessage(event: MessageEvent) {
			void handleBridgeMessage(
				{
					frameWindow: () => iframeRef.current?.contentWindow ?? null,
					isBlocked: () => blockedRef.current,
					sources: () => sourcesRef.current,
					run: (spec) => api.data.query(workspaceId, spec),
					post: (message) => iframeRef.current?.contentWindow?.postMessage(message, '*'),
					onDocHeight: (h) => setHeight(Math.max(MIN_HEIGHT, Math.ceil(h))),
					onQueryError: (message) => onFailureRef.current(`A data query failed: ${message}`),
				},
				event,
			)
		}
		window.addEventListener('message', onMessage)
		return () => window.removeEventListener('message', onMessage)
	}, [workspaceId])

	// Tell the view to re-ask for its data every tick while the tab is visible.
	useEffect(() => {
		function tick() {
			if (document.visibilityState !== 'visible' || blockedRef.current) return
			iframeRef.current?.contentWindow?.postMessage({ type: BRIDGE_REFRESH_MESSAGE }, '*')
		}
		const timer = setInterval(tick, REFRESH_MS)
		document.addEventListener('visibilitychange', tick)
		return () => {
			clearInterval(timer)
			document.removeEventListener('visibilitychange', tick)
		}
	}, [])

	// A fresh frame (first mount, new document, or a reset) starts with no loads.
	// biome-ignore lint/correctness/useExhaustiveDependencies: srcDoc and frameKey are the triggers
	useEffect(() => {
		loadsRef.current = 0
		blockedRef.current = false
	}, [srcDoc, frameKey])

	// A srcdoc frame fires `load` once. A second load means the view navigated
	// itself away (scripted navigation is not covered by the CSP). Stop answering
	// it at once, then replace the frame with a fresh one; a view that keeps doing
	// it is dropped for the default page.
	function handleLoad() {
		loadsRef.current += 1
		if (loadsRef.current === 1) return
		blockedRef.current = true
		if (resetsRef.current >= MAX_FRAME_RESETS) {
			onFailure('The view tried to navigate away and was stopped.')
			return
		}
		resetsRef.current += 1
		setFrameKey((k) => k + 1)
	}

	return (
		<iframe
			key={frameKey}
			ref={iframeRef}
			title="Custom loop view"
			srcDoc={srcDoc}
			sandbox="allow-scripts"
			onLoad={handleLoad}
			style={{ height }}
			className="block w-full rounded-md border border-border bg-background"
		/>
	)
}
