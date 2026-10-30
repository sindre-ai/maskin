import { Skeleton } from '@/components/shared/loading-skeleton'
import { useFile } from '@/hooks/use-files'
import { api } from '@/lib/api'
import { handleBridgeMessage, sourcesAffectedBy } from '@/lib/loop-view-bridge'
import { prepareBridgedViewHtml, readViewSources } from '@/lib/mini-app'
import { subscribeToSSE } from '@/lib/sse-invalidation'
import type { DataQuerySpec } from '@maskin/shared'
import { useEffect, useMemo, useRef, useState } from 'react'

/** Quiet time after a relevant event before the sources are re-checked, so a burst of writes is one check. */
const SETTLE_MS = 2_000
/** Added to the server's wait so the reload lands just after the change, not just before. */
const WAKE_MARGIN_MS = 1_000
/** Browsers clamp setTimeout at 2^31-1 ms; a longer wait reloads once early and re-arms. */
const MAX_TIMER_MS = 2_000_000_000
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
	// The last answer given to the frame per source (by its query), to tell whether a change matters.
	const lastResultsRef = useRef(new Map<string, string>())
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
					run: async (spec) => {
						const result = await api.data.query(workspaceId, spec)
						lastResultsRef.current.set(JSON.stringify(spec), JSON.stringify(result))
						return result
					},
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

	// Keeps the view live without it having to cooperate, and only while it is open (this
	// component is mounted). A page cannot be told to re-render from outside, so when an
	// event arrives that could change one of its sources, the host re-runs just those
	// sources and, if a number differs, replaces the frame with a fresh one that re-asks
	// for everything. Events that cannot affect the view cost nothing; a burst of them
	// settles into one check; a hidden tab waits until it is visible again.
	useEffect(() => {
		const dirty = new Set<string>()
		let timer: ReturnType<typeof setTimeout> | undefined
		let checking = false

		function schedule() {
			if (timer !== undefined) return
			timer = setTimeout(() => {
				timer = undefined
				void check()
			}, SETTLE_MS)
		}

		async function check() {
			if (dirty.size === 0 || checking) return
			if (document.visibilityState !== 'visible' || blockedRef.current) return
			checking = true
			const keys = new Set(dirty)
			dirty.clear()
			try {
				for (const spec of sourcesRef.current.values()) {
					const key = JSON.stringify(spec)
					const before = lastResultsRef.current.get(key)
					if (!keys.has(key) || before === undefined) continue
					const after = JSON.stringify(await api.data.query(workspaceId, spec))
					if (after !== before) {
						lastResultsRef.current.delete(key)
						setFrameKey((k) => k + 1)
						return
					}
				}
			} catch {
				// A failed check leaves the view as it is; the next relevant event tries again.
			} finally {
				checking = false
				if (dirty.size > 0) schedule()
			}
		}

		const unsubscribe = subscribeToSSE((event) => {
			const affected = sourcesAffectedBy(event, sourcesRef.current)
			if (affected.size === 0) return
			for (const key of affected) dirty.add(key)
			schedule()
		})
		const onVisible = () => {
			if (document.visibilityState === 'visible') schedule()
		}
		document.addEventListener('visibilitychange', onVisible)
		return () => {
			unsubscribe()
			document.removeEventListener('visibilitychange', onVisible)
			if (timer !== undefined) clearTimeout(timer)
		}
	}, [workspaceId])

	// Some answers change with no write at all: an object ages out of "last 7 days", a
	// day-by-day chart rolls over at midnight. No event announces that, so on each load of
	// the view the server says how long until its sources next change that way, and we
	// reload the frame once, then. Views with no moving dates get nothing back and no timer.
	// biome-ignore lint/correctness/useExhaustiveDependencies: srcDoc and frameKey are the triggers
	useEffect(() => {
		let cancelled = false
		let timer: ReturnType<typeof setTimeout> | undefined
		void (async () => {
			try {
				const answers = await Promise.all(
					[...sourcesRef.current.values()].map((spec) => api.data.nextChange(workspaceId, spec)),
				)
				if (cancelled) return
				const waits = answers.flatMap((a) => (a.in_ms === null ? [] : [a.in_ms]))
				if (waits.length === 0) return
				const wait = Math.min(Math.min(...waits) + WAKE_MARGIN_MS, MAX_TIMER_MS)
				timer = setTimeout(() => setFrameKey((k) => k + 1), wait)
			} catch {
				// No timer this time; the view still updates on writes.
			}
		})()
		return () => {
			cancelled = true
			if (timer !== undefined) clearTimeout(timer)
		}
	}, [workspaceId, srcDoc, frameKey])

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
