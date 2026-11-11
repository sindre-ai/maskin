import { Skeleton } from '@/components/shared/loading-skeleton'
import { Button } from '@/components/ui/button'
import { useFile } from '@/hooks/use-files'
import { api } from '@/lib/api'
import { handleBridgeMessage, sourcesAffectedBy } from '@/lib/loop-view-bridge'
import {
	dropCachedResult,
	formatUpdatedAt,
	readCachedResult,
	writeCachedResult,
} from '@/lib/loop-view-cache'
import { ISOLATION_LOAD_MESSAGE, prepareIsolatedViewHtml, readViewSources } from '@/lib/mini-app'
import { subscribeToSSE } from '@/lib/sse-invalidation'
import type { ListSourceEntry } from '@/lib/view-lists'
import type { DataQueryResult, DataQuerySpec } from '@maskin/shared'
import { useNavigate } from '@tanstack/react-router'
import { RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

/** Quiet time after a relevant event before the sources are re-checked, so a burst of writes is one check. */
const SETTLE_MS = 2_000
/** Added to the server's wait so the reload lands just after the change, not just before. */
const WAKE_MARGIN_MS = 1_000
/** Browsers clamp setTimeout at 2^31-1 ms; a longer wait reloads once early and re-arms. */
const MAX_TIMER_MS = 2_000_000_000
/** Times a view that navigates away from its srcdoc is reset before we give up on it. */
const MAX_FRAME_RESETS = 3
const MIN_HEIGHT = 160
/** A replacement frame that has not reported its size by now takes over anyway. */
const SWAP_TIMEOUT_MS = 3_000
/** A failed live-refresh check or next-change lookup is retried this many times, backing off, before the view is flagged as possibly out of date. */
const MAX_REFRESH_RETRIES = 5
const REFRESH_RETRY_MS = 5_000
// A query with no answer by now has hung; give up so the spinner stops and Refresh is offered.
const QUERY_TIMEOUT_MS = 30_000

interface LoopCustomViewProps {
	workspaceId: string
	fileId: string
	/** Called when the view cannot be shown (file missing, bad sources, escaped frame). The loop page then shows its default content. A failed query is not one: the view stays and says so. */
	onFailure: (reason: string) => void
	/** What a view's window.maskin.open(id) does. Without it the viewer goes to that object's page. */
	onOpenItem?: (objectId: string) => void
}

export function LoopCustomView({
	workspaceId,
	fileId,
	onFailure,
	onOpenItem,
}: LoopCustomViewProps) {
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
			lists={sources.lists}
			workspaceId={workspaceId}
			onFailure={onFailure}
			onOpenItem={onOpenItem}
		/>
	)
}

function ViewFrame({
	html,
	sources,
	lists,
	workspaceId,
	onFailure,
	onOpenItem,
}: {
	html: string
	sources: ReadonlyMap<string, DataQuerySpec>
	lists: ReadonlyMap<string, ListSourceEntry>
	workspaceId: string
	onFailure: (reason: string) => void
	onOpenItem?: (objectId: string) => void
}) {
	const iframeRef = useRef<HTMLIFrameElement>(null)
	const navigate = useNavigate()
	const [height, setHeight] = useState(MIN_HEIGHT)
	// Width the view needs when it is wider than the box it sits in. The frame takes that width
	// and the box scrolls sideways; null means "fit the box". Reset whenever the box changes
	// width or the frame is replaced, so a view that fits again goes back to fitting.
	const [contentWidth, setContentWidth] = useState<number | null>(null)
	const boxRef = useRef<HTMLDivElement>(null)
	// Shown by the host, outside the frame, so a view cannot hide it: an answer that hit the
	// server's row/group cap is partial, and a view whose live refresh keeps failing is stale.
	const [partial, setPartial] = useState(false)
	const [stale, setStale] = useState(false)
	// Stale for two independent reasons (a failed live-event check, a failed timer lookup); each
	// clears only itself, so one path recovering cannot hide the other still failing.
	const [timerStale, setTimerStale] = useState(false)
	// A query the view asked for failed. The view stays up and gets the error itself; the host
	// adds this note so the failure shows even if the view draws no error state.
	const [queryFailed, setQueryFailed] = useState(false)
	// The last attempt to bring the view up to date failed; the header says so and offers Refresh.
	const [refreshFailed, setRefreshFailed] = useState(false)
	const [frameKey, setFrameKey] = useState(0)
	// The frame on screen. A replacement frame loads hidden next to it and takes over once it
	// has drawn, so a refresh never shows a blank or half-built view.
	const [shownKey, setShownKey] = useState(0)
	const frameKeyRef = useRef(frameKey)
	frameKeyRef.current = frameKey
	// Set when the frame on screen must go at once (it navigated away), not wait for its successor.
	const swapNowRef = useRef(false)
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
	// List sources are only ever refused here: rows are for the file viewer (allowLists below).
	const listsRef = useRef(lists)
	listsRef.current = lists
	const onFailureRef = useRef(onFailure)
	onFailureRef.current = onFailure
	const onOpenItemRef = useRef(onOpenItem)
	onOpenItemRef.current = onOpenItem

	// The view draws from the last saved answers when it has them, then the host asks the
	// server again behind it. `updatedAt` is the age of the oldest answer on screen; `refreshing`
	// is true while any query is in flight.
	const [updatedAt, setUpdatedAt] = useState<number | null>(null)
	const [refreshing, setRefreshing] = useState(false)
	const pendingRef = useRef(0)
	// When each source's answer on screen was fetched, by query key.
	const answeredAtRef = useRef(new Map<string, number>())
	// A fresh answer the next frame should be given as it is, by query key (used once).
	const freshRef = useRef(new Map<string, DataQueryResult>())

	const syncUpdatedAt = useCallback(() => {
		const times = [...answeredAtRef.current.values()]
		setUpdatedAt(times.length > 0 ? Math.min(...times) : null)
	}, [])

	/** Runs one query on the server, saves the answer for next time, and stamps it as fetched now. */
	const queryAndStore = useCallback(
		async (spec: DataQuerySpec) => {
			const key = JSON.stringify(spec)
			pendingRef.current += 1
			setRefreshing(true)
			try {
				const result = await api.data.query(workspaceId, spec, {
					timeoutMs: QUERY_TIMEOUT_MS,
				})
				if (result.rows_truncated || result.groups_truncated) setPartial(true)
				answeredAtRef.current.set(key, writeCachedResult(workspaceId, key, result))
				syncUpdatedAt()
				return result
			} finally {
				pendingRef.current -= 1
				if (pendingRef.current === 0) setRefreshing(false)
			}
		},
		[workspaceId, syncUpdatedAt],
	)

	/** The Refresh button: asks the server for every source again and redraws if anything differs from what the view has. */
	const refreshAll = useCallback(async () => {
		setRefreshFailed(false)
		const specs = [...sourcesRef.current.values()]
		const settled = await Promise.allSettled(specs.map((spec) => queryAndStore(spec)))
		let changed = false
		settled.forEach((outcome, i) => {
			const key = JSON.stringify(specs[i])
			if (outcome.status === 'rejected') {
				console.error('[loop-custom-view] manual refresh failed', outcome.reason)
				setRefreshFailed(true)
			} else if (JSON.stringify(outcome.value) !== lastResultsRef.current.get(key)) {
				// Also true for a source the view never got an answer to (its query had failed).
				freshRef.current.set(key, outcome.value)
				changed = true
			}
		})
		if (changed) setFrameKey((k) => k + 1)
	}, [queryAndStore])

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
			swapNowRef.current = true
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
					allowLists: false,
					listSources: () => listsRef.current,
					onOpen: (objectId) =>
						onOpenItemRef.current
							? onOpenItemRef.current(objectId)
							: navigate({
									to: '/$workspaceId/objects/$objectId',
									params: { workspaceId, objectId },
								}),
					run: async (spec) => {
						const key = JSON.stringify(spec)
						const given = (result: DataQueryResult) => {
							lastResultsRef.current.set(key, JSON.stringify(result))
							return result
						}

						// A refresh just found a different answer; the new frame gets that one.
						const fresh = freshRef.current.get(key)
						if (fresh) {
							freshRef.current.delete(key)
							return given(fresh)
						}

						// A saved answer is drawn at once and checked against the server behind it.
						// The frame is replaced only if the server disagrees.
						const cached = readCachedResult(workspaceId, key)
						if (cached) {
							answeredAtRef.current.set(key, cached.at)
							syncUpdatedAt()
							if (cached.result.rows_truncated || cached.result.groups_truncated) setPartial(true)
							const shown = given(cached.result)
							queryAndStore(spec).then(
								(latest) => {
									setRefreshFailed(false)
									const onScreen = lastResultsRef.current.get(key)
									if (onScreen !== undefined && onScreen !== JSON.stringify(latest)) {
										freshRef.current.set(key, latest)
										setFrameKey((k) => k + 1)
									}
								},
								(err) => {
									console.error('[loop-custom-view] refresh of the saved answer failed', err)
									setRefreshFailed(true)
								},
							)
							return shown
						}

						return given(await queryAndStore(spec))
					},
					post: (message) => viewWindow()?.postMessage(message, '*'),
					onDocHeight: (h) => {
						setHeight(Math.max(MIN_HEIGHT, Math.ceil(h)))
						// The newest frame has drawn; it replaces the one on screen.
						setShownKey(frameKeyRef.current)
					},
					// A view wider than its box takes the width it needs and the box scrolls
					// sideways, rather than the view clipping or the page overflowing.
					onDocOverflow: (w) => setContentWidth(Math.ceil(w)),
					onQueryError: () => setQueryFailed(true),
				},
				event,
			)
		}
		window.addEventListener('message', onMessage)
		return () => window.removeEventListener('message', onMessage)
	}, [workspaceId, queryAndStore, syncUpdatedAt, navigate])

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
					const latest = await queryAndStore(spec)
					failures = 0
					setStale(false)
					if (JSON.stringify(latest) !== before) {
						lastResultsRef.current.delete(key)
						freshRef.current.set(key, latest)
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
	}, [queryAndStore])

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
				return
			}
			// Out of retries with a source unread: its time-based changes will not be seen, say so.
			setTimerStale(failed)
			if (wait !== Number.POSITIVE_INFINITY) {
				// The answer changed by time alone, so a saved one is wrong by definition: the new frame must ask the server.
				timer = setTimeout(() => {
					for (const spec of sourcesRef.current.values()) {
						const key = JSON.stringify(spec)
						dropCachedResult(workspaceId, key)
						freshRef.current.delete(key)
					}
					setFrameKey((k) => k + 1)
				}, wait)
			}
		}
		arm(0).catch((err) => console.error('[loop-custom-view] next-change setup failed', err))
		return () => {
			cancelled = true
			if (timer !== undefined) clearTimeout(timer)
		}
	}, [workspaceId, srcDoc, frameKey])

	useEffect(() => {
		const box = boxRef.current
		if (!box || !window.ResizeObserver) return
		let width = box.clientWidth
		const observer = new ResizeObserver(() => {
			if (box.clientWidth === width) return
			width = box.clientWidth
			setContentWidth(null)
		})
		observer.observe(box)
		return () => observer.disconnect()
	}, [])

	// A view that never reports its size must not leave the old frame up forever.
	useEffect(() => {
		if (swapNowRef.current) {
			swapNowRef.current = false
			setShownKey(frameKey)
			return
		}
		const timer = setTimeout(() => setShownKey(frameKey), SWAP_TIMEOUT_MS)
		return () => clearTimeout(timer)
	}, [frameKey])

	// A fresh frame (first mount, new document, or a reset) starts with no loads.
	// biome-ignore lint/correctness/useExhaustiveDependencies: srcDoc and frameKey are the triggers
	useEffect(() => {
		loadsRef.current = 0
		blockedRef.current = false
		setQueryFailed(false)
		setContentWidth(null)
	}, [srcDoc, frameKey])

	return (
		<>
			{(refreshing || updatedAt !== null || refreshFailed || queryFailed || stale) && (
				<div
					className="mb-2 flex items-center justify-end gap-1.5 text-xs text-muted-foreground"
					aria-live="polite"
				>
					{refreshing && <RefreshCw className="size-3 animate-spin" aria-hidden="true" />}
					<span>
						{updatedAt !== null
							? `Updated ${formatUpdatedAt(updatedAt)}`
							: refreshing
								? 'Refreshing…'
								: ''}
					</span>
					{(refreshFailed || queryFailed || stale) && !refreshing && (
						<>
							{(refreshFailed || queryFailed) && <span className="text-error">Refresh failed</span>}
							<Button type="button" variant="ghost" size="sm" onClick={() => void refreshAll()}>
								<RefreshCw className="size-3" aria-hidden="true" />
								Refresh
							</Button>
						</>
					)}
				</div>
			)}
			{(partial || stale || timerStale || queryFailed) && (
				<p className="mb-2 text-xs text-muted-foreground">
					{partial &&
						'Some numbers in this view are partial: the data hit its size limit, so counts may be lower than the real totals. '}
					{queryFailed && 'Some numbers in this view could not be loaded. '}
					{(stale || timerStale) && 'Live updates are failing, so this view may be out of date.'}
				</p>
			)}
			<div ref={boxRef} className="relative overflow-x-auto">
				{(shownKey === frameKey ? [frameKey] : [shownKey, frameKey]).map((key) => (
					<iframe
						key={key}
						ref={key === frameKey ? iframeRef : undefined}
						title="Custom flow view"
						srcDoc={srcDoc}
						sandbox="allow-scripts"
						style={{ height, width: contentWidth ?? '100%' }}
						className={`block max-w-none rounded-md border border-border bg-background${
							key === shownKey ? '' : ' invisible absolute top-0 left-0'
						}`}
						aria-hidden={key === shownKey ? undefined : true}
					/>
				))}
			</div>
		</>
	)
}
