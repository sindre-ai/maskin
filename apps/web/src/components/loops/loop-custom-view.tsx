import { Skeleton } from '@/components/shared/loading-skeleton'
import { useFile } from '@/hooks/use-files'
import { api } from '@/lib/api'
import { handleBridgeMessage, sourcesAffectedBy } from '@/lib/loop-view-bridge'
import { ISOLATION_LOAD_MESSAGE, prepareIsolatedViewHtml, readViewSources } from '@/lib/mini-app'
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
/** A failed live-refresh check or next-change lookup is retried this many times, backing off, before the view is flagged as possibly out of date. */
const MAX_REFRESH_RETRIES = 5
const REFRESH_RETRY_MS = 5_000

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
	// Shown by the host, outside the frame, so a view cannot hide it: an answer that hit the
	// server's row/group cap is partial, and a view whose live refresh keeps failing is stale.
	const [partial, setPartial] = useState(false)
	const [stale, setStale] = useState(false)
	const [frameKey, setFrameKey] = useState(0)
	const loadsRef = useRef(0)
	const resetsRef = useRef(0)
	const blockedRef = useRef(false)
	// The last answer given to the frame per source (by its query), to tell whether a change matters.
	const lastResultsRef = useRef(new Map<string, string>())
	const srcDoc = useMemo(() => prepareIsolatedViewHtml(html), [html])

	// The handler is installed once per workspace; it reads the latest sources
	// and failure callback through refs so a re-render never drops a message.
	const sourcesRef = useRef(sources)
	sourcesRef.current = sources
	const onFailureRef = useRef(onFailure)
	onFailureRef.current = onFailure

	useEffect(() => {
		// The view runs one frame inside the iframe we render (see prepareIsolatedViewHtml), so
		// it is that iframe's first child frame. Cross-origin windows still expose `frames`.
		const viewWindow = () => iframeRef.current?.contentWindow?.frames[0] ?? null

		// The isolation frame reports each load of the view frame. A view frame loads once; a
		// second load means it navigated itself away (the isolation frame's CSP blocks that in
		// Chrome, but is untested elsewhere). Stop answering it at once, then replace the frame
		// with a fresh one; a view that keeps doing it is dropped for the default page.
		function noteViewLoad() {
			loadsRef.current += 1
			if (loadsRef.current === 1) return
			blockedRef.current = true
			if (resetsRef.current >= MAX_FRAME_RESETS) {
				onFailureRef.current('The view tried to navigate away and was stopped.')
				return
			}
			resetsRef.current += 1
			setFrameKey((k) => k + 1)
		}

		function onMessage(event: MessageEvent) {
			// Only the isolation frame itself can say this; the view frame's window is a different one.
			if (
				event.source === iframeRef.current?.contentWindow &&
				(event.data as { type?: unknown } | null)?.type === ISOLATION_LOAD_MESSAGE
			) {
				noteViewLoad()
				return
			}
			void handleBridgeMessage(
				{
					frameWindow: viewWindow,
					isBlocked: () => blockedRef.current,
					sources: () => sourcesRef.current,
					run: async (spec) => {
						const result = await api.data.query(workspaceId, spec)
						lastResultsRef.current.set(JSON.stringify(spec), JSON.stringify(result))
						if (result.rows_truncated || result.groups_truncated) setPartial(true)
						return result
					},
					post: (message) => viewWindow()?.postMessage(message, '*'),
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
		let failures = 0

		function schedule(delay = SETTLE_MS) {
			if (timer !== undefined) return
			timer = setTimeout(() => {
				timer = undefined
				void check()
			}, delay)
		}

		async function check() {
			if (dirty.size === 0 || checking) return
			if (document.visibilityState !== 'visible' || blockedRef.current) return
			checking = true
			const keys = new Set(dirty)
			dirty.clear()
			let retryIn = SETTLE_MS
			try {
				for (const spec of sourcesRef.current.values()) {
					const key = JSON.stringify(spec)
					const before = lastResultsRef.current.get(key)
					if (!keys.has(key) || before === undefined) continue
					const after = JSON.stringify(await api.data.query(workspaceId, spec))
					failures = 0
					setStale(false)
					if (after !== before) {
						lastResultsRef.current.delete(key)
						setFrameKey((k) => k + 1)
						return
					}
				}
			} catch (err) {
				// Keep the keys so the check is retried, backing off; after repeated failures say so.
				failures += 1
				console.error('[loop-custom-view] live refresh check failed', err)
				if (failures <= MAX_REFRESH_RETRIES) {
					for (const key of keys) dirty.add(key)
					retryIn = REFRESH_RETRY_MS * 2 ** (failures - 1)
				} else {
					setStale(true)
				}
			} finally {
				checking = false
				if (dirty.size > 0) schedule(retryIn)
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

		async function arm(attempt: number) {
			// One failing source must not take the others' timers down with it.
			const settled = await Promise.allSettled(
				[...sourcesRef.current.values()].map((spec) => api.data.nextChange(workspaceId, spec)),
			)
			if (cancelled) return
			const waits: number[] = []
			let failed = false
			for (const outcome of settled) {
				if (outcome.status === 'rejected') {
					failed = true
					console.error('[loop-custom-view] next-change lookup failed', outcome.reason)
				} else if (outcome.value.in_ms !== null) {
					waits.push(outcome.value.in_ms)
				}
			}
			const wait =
				waits.length > 0
					? Math.min(Math.min(...waits) + WAKE_MARGIN_MS, MAX_TIMER_MS)
					: Number.POSITIVE_INFINITY
			const retryIn = REFRESH_RETRY_MS * (attempt + 1)
			if (failed && attempt < MAX_REFRESH_RETRIES && retryIn < wait) {
				// A source we could not read may change sooner than the ones we could; look again.
				timer = setTimeout(() => void arm(attempt + 1), retryIn)
			} else if (wait !== Number.POSITIVE_INFINITY) {
				timer = setTimeout(() => setFrameKey((k) => k + 1), wait)
			}
		}
		arm(0).catch((err) => console.error('[loop-custom-view] next-change setup failed', err))
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

	return (
		<>
			{(partial || stale) && (
				<p className="mb-2 text-xs text-muted-foreground">
					{partial &&
						'Some numbers in this view are partial: the data hit its size limit, so counts may be lower than the real totals. '}
					{stale && 'Live updates are failing, so this view may be out of date.'}
				</p>
			)}
			<iframe
				key={frameKey}
				ref={iframeRef}
				title="Custom loop view"
				srcDoc={srcDoc}
				sandbox="allow-scripts"
				style={{ height }}
				className="block w-full rounded-md border border-border bg-background"
			/>
		</>
	)
}
