import { EmptyState } from '@/components/shared/empty-state'
import { Button } from '@/components/ui/button'
import type { UnreadItem } from '@/lib/api'
import { Link } from '@tanstack/react-router'
import { Check } from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ForYouQueueCard, type ForYouQueueCardHandle, itemQueueKey } from './foryou-queue-card'

interface ForYouCardQueueProps {
	workspaceId: string
	queue: UnreadItem[]
	/** The sparse-feed composer nudge (T-something), rendered by the caller so
	 *  it can be shared with the list-mode layout too. On mobile it's hidden
	 *  while a card is actively shown — the fixed action bar sits at a
	 *  viewport-anchored offset, so any sibling sharing this flex-1 column
	 *  shrinks the card away from it (bet foryou-brief-feed CI investigation,
	 *  2026-08-13). It reappears once the queue empties, where the compact
	 *  EmptyState doesn't compete for fill-height the same way. */
	sparseComposer?: ReactNode
	/** Item key the user picked in List mode — the queue opens parked on it
	 *  instead of on the sort's front runner (mockup 490). */
	pinnedKey?: string | null
	/** The active sort. The queue pins its front card against background
	 *  re-sorts (see below), but an explicit sort change is the user asking for
	 *  a different front runner — so a change here releases the pin. */
	sort?: string
}

function noop() {}

export function ForYouCardQueue({
	workspaceId,
	queue,
	sparseComposer,
	pinnedKey,
	sort,
}: ForYouCardQueueProps) {
	const [currentKey, setCurrentKey] = useState<string | null>(pinnedKey ?? null)
	const [processedKeys, setProcessedKeys] = useState<Set<string>>(() => new Set())
	// Items whose deferred mark-read/mark-unread mutation (use-swipe-to-mark-read's
	// 4.5s Undo timer) has been scheduled but hasn't fired or been undone yet.
	// The queue advances past these immediately for a responsive feel, but the
	// card instance that owns the timer must stay mounted (hidden, below) until
	// it settles — unmounting it early would tear down the hook and silently
	// cancel the real mutation before it ever runs.
	const [pendingCommitKeys, setPendingCommitKeys] = useState<Set<string>>(() => new Set())
	const cardRef = useRef<ForYouQueueCardHandle>(null)

	const visibleQueue = useMemo(
		() => queue.filter((item) => !processedKeys.has(itemQueueKey(item))),
		[queue, processedKeys],
	)

	// A List-mode selection wins over the pin below: the user just told us which
	// item they want in front.
	useEffect(() => {
		if (pinnedKey) setCurrentKey(pinnedKey)
	}, [pinnedKey])

	// Same reasoning for an explicit sort change: the pin below exists to keep
	// *background* re-sorts from swapping the card mid-read, not to ignore the
	// user picking a different order. Clearing the key re-fronts the queue on
	// the new sort's first item. Skips the initial mount so it can't stomp a
	// List-mode pin that arrived with the first render.
	const lastSortRef = useRef(sort)
	useEffect(() => {
		if (lastSortRef.current === sort) return
		lastSortRef.current = sort
		setCurrentKey(null)
	}, [sort])

	// Pin the front card once shown. `queue` re-sorts on every background
	// refetch (SSE-triggered unread invalidation) — without pinning, the card
	// the user is mid-read/mid-reply on would get silently swapped out
	// whenever a re-sort put a different item first. New/reprioritized items
	// just wait behind the pinned card until it's processed or drops out.
	useEffect(() => {
		if (currentKey !== null && visibleQueue.some((item) => itemQueueKey(item) === currentKey)) {
			return
		}
		setCurrentKey(visibleQueue[0] ? itemQueueKey(visibleQueue[0]) : null)
	}, [visibleQueue, currentKey])

	const currentItem =
		visibleQueue.find((item) => itemQueueKey(item) === currentKey) ?? visibleQueue[0] ?? null
	const currentItemKey = currentItem ? itemQueueKey(currentItem) : null
	const remaining = visibleQueue.length

	const activeItems = useMemo(() => {
		const items: UnreadItem[] = currentItem ? [currentItem] : []
		for (const item of queue) {
			const key = itemQueueKey(item)
			if (key !== currentItemKey && pendingCommitKeys.has(key)) items.push(item)
		}
		return items
	}, [currentItem, currentItemKey, queue, pendingCommitKeys])

	const handleProcessed = useCallback((key: string) => {
		setProcessedKeys((prev) => {
			const next = new Set(prev)
			next.add(key)
			return next
		})
		setCurrentKey(null)
	}, [])

	const handleRestored = useCallback((key: string) => {
		setProcessedKeys((prev) => {
			if (!prev.has(key)) return prev
			const next = new Set(prev)
			next.delete(key)
			return next
		})
		setPendingCommitKeys((prev) => {
			if (!prev.has(key)) return prev
			const next = new Set(prev)
			next.delete(key)
			return next
		})
		setCurrentKey(key)
	}, [])

	const handleCommitScheduled = useCallback((key: string) => {
		setPendingCommitKeys((prev) => {
			if (prev.has(key)) return prev
			const next = new Set(prev)
			next.add(key)
			return next
		})
	}, [])

	const handleCommitSettled = useCallback((key: string) => {
		setPendingCommitKeys((prev) => {
			if (!prev.has(key)) return prev
			const next = new Set(prev)
			next.delete(key)
			return next
		})
	}, [])

	const cards = activeItems.map((item) => {
		const key = itemQueueKey(item)
		const isCurrent = key === currentItemKey
		return (
			<div
				key={key}
				className={isCurrent ? 'flex-1 min-h-0' : 'hidden'}
				aria-hidden={isCurrent ? undefined : true}
			>
				<ForYouQueueCard
					ref={isCurrent ? cardRef : undefined}
					workspaceId={workspaceId}
					item={item}
					onProcessed={isCurrent ? handleProcessed : noop}
					onRestored={handleRestored}
					onCommitScheduled={handleCommitScheduled}
					onCommitSettled={handleCommitSettled}
				/>
			</div>
		)
	})

	// Always return the same top-level wrapper regardless of currentItem, with
	// `cards` in a stable child position — swapping between a `<div>` and a
	// `<>` fragment here (as an early-return once did) changes the root
	// element type React sees, which tears down and remounts the *entire*
	// subtree including the hidden pending-commit card, cancelling its
	// still-running use-swipe-to-mark-read timer. Only the second slot
	// (action bar vs. empty state) is allowed to swap type.
	//
	// Bottom padding: below md the action bar is `fixed`, so the flex column
	// can't see it and the card would grow underneath it — reserve the bar's own
	// height here. The bar measures 68px (`py-3` twice plus the `size="lg"`
	// button's `h-11`), so `pb-16` (64px) clears it while leaving the card flush;
	// `pb-20` (80px) over-reserved and, stacked on the page shell's own bottom
	// padding, stranded 40px of dead space above the buttons. At md+ the bar is
	// back in flow (`md:sticky`) and reserves its own space, so none is needed.
	return (
		<div className="flex flex-1 min-h-0 flex-col gap-4 pb-16 md:pb-0">
			{cards}

			{currentItem ? (
				<div className="fixed inset-x-0 bottom-0 z-10 flex justify-center px-4 py-3 md:sticky md:px-0 md:py-0">
					<div className="flex w-full max-w-[760px] items-center justify-between gap-3">
						<Button
							size="lg"
							variant="outline"
							className="flex-1 md:flex-none"
							onClick={() => cardRef.current?.skip()}
						>
							Keep unread
							<kbd
								aria-hidden
								className="hidden font-mono text-[10px] text-muted-foreground sm:inline"
							>
								←
							</kbd>
						</Button>
						<span className="hidden text-xs text-muted-foreground md:inline">
							{remaining} {remaining === 1 ? 'item' : 'items'} left
						</span>
						<Button
							size="lg"
							variant="outline"
							className="flex-1 md:flex-none"
							onClick={() => cardRef.current?.commit()}
						>
							Mark as read
							<kbd
								aria-hidden
								className="hidden font-mono text-[10px] text-muted-foreground sm:inline"
							>
								→
							</kbd>
						</Button>
					</div>
				</div>
			) : (
				<EmptyState
					emphasis="page"
					icon={
						<span className="grid size-[52px] place-items-center rounded-full bg-status-active-bg text-status-active-text">
							<Check size={20} aria-hidden />
						</span>
					}
					title="You're caught up"
					description="Nothing needs you right now. The loops keep running — you'll hear when one does."
					action={
						<Button size="sm" variant="ghost" asChild>
							<Link to="/$workspaceId/loops" params={{ workspaceId }}>
								Review loops →
							</Link>
						</Button>
					}
				/>
			)}

			{sparseComposer && (
				<div className={currentItem ? 'hidden md:block' : undefined}>{sparseComposer}</div>
			)}
		</div>
	)
}
