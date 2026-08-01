import { trackForyouCardMarkedRead, trackForyouCardMarkedUnread } from '@/lib/analytics'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { toast } from 'sonner'

export const SWIPE_THRESHOLD = 80
const VELOCITY_THRESHOLD = 0.42

export type SwipeRevealVariant = 'mark-read' | 'mark-unread'

// Optional analytics context — when provided, the matching
// `foryou_card_marked_read` / `foryou_card_marked_unread` PostHog event fires
// inside the post-Undo timer commit (i.e. only on completed swipes; tapping
// Undo cancels the timer and no event fires). Callers that don't pass this
// (unit tests, non-For-You surfaces added later) get the pre-existing
// behaviour with no analytics side effect.
interface SwipeAnalytics {
	entity_type: string
	entity_id: string
}

interface UseSwipeToMarkReadOptions {
	// Fires 4.5s after a completed right-swipe on an unread card (unless Undo).
	onMarkRead: () => void
	// Fires 4.5s after a completed left-swipe on a read card (unless Undo).
	// Optional so consumers that only need mark-read stay call-compatible.
	onMarkUnread?: () => void
	// When true the card is already read — reverse the gesture direction:
	// right-swipe becomes a no-op wrong-direction bounce, left-swipe reveals
	// mark-unread. When false the mark-read path stays exactly as before.
	isRead?: boolean
	analytics?: SwipeAnalytics
}

interface UseSwipeToMarkReadResult {
	dragOffset: number
	isDragging: boolean
	swipePending: boolean
	swipeBgOpacity: number
	// Which reveal to render this frame — the card picks one overlay variant
	// at a time keyed off this value so the wrong-direction bounce never
	// flashes the opposite colour.
	revealVariant: SwipeRevealVariant
	handlePointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void
	handlePointerMove: (e: ReactPointerEvent<HTMLDivElement>) => void
	handlePointerUp: () => void
	handlePointerCancel: () => void
}

/**
 * Bidirectional swipe hook for For You cards.
 *
 * - Unread card + right-swipe past 80px / 0.42 px/ms → `onMarkRead` after a
 *   4.5s Undo window, plus a `foryou_card_marked_read` PostHog emission when
 *   analytics context is supplied.
 * - Read card + left-swipe past 80px / 0.42 px/ms → `onMarkUnread` after the
 *   same 4.5s Undo window, plus a `foryou_card_marked_unread` emission.
 * - Wrong-direction swipe (right on read, left on unread) is clamped to zero
 *   displacement — no reveal, rubber-bands back on release, no callback fires.
 *
 * Legacy callsites can pass a bare `onMarkRead` callback (optionally with an
 * analytics object as the second positional arg) — the options overload keeps
 * the mark-unread path opt-in so nothing regresses when the card doesn't need
 * the reverse gesture.
 */
export function useSwipeToMarkRead(
	onMarkReadOrOptions: (() => void) | UseSwipeToMarkReadOptions,
	analyticsPositional?: SwipeAnalytics,
): UseSwipeToMarkReadResult {
	const options: UseSwipeToMarkReadOptions =
		typeof onMarkReadOrOptions === 'function'
			? { onMarkRead: onMarkReadOrOptions, analytics: analyticsPositional }
			: onMarkReadOrOptions
	const { onMarkRead, onMarkUnread, isRead = false, analytics } = options

	// Ref keeps callbacks fresh without resetting the swipe callbacks each
	// render — the hook's outward-facing handlers stay referentially stable.
	const callbacksRef = useRef({ onMarkRead, onMarkUnread, isRead, analytics })
	callbacksRef.current = { onMarkRead, onMarkUnread, isRead, analytics }

	const swipeRef = useRef({
		startX: 0,
		startY: 0,
		lastX: 0,
		lastTime: 0,
		vel: 0,
		dx: 0,
		locked: false,
		isHoriz: false,
		active: false,
	})
	const [dragOffset, setDragOffset] = useState(0)
	const [isDragging, setIsDragging] = useState(false)
	const [swipePending, setSwipePending] = useState(false)
	// Tracks which colour reveal to show behind the card while dragging. On
	// pointer-down we assume the card's current state — read cards reveal blue
	// (mark-unread), unread cards reveal green (mark-read). Wrong-direction
	// swipes leave dragOffset at 0 so the reveal stays invisible anyway.
	const [revealVariant, setRevealVariant] = useState<SwipeRevealVariant>(
		isRead ? 'mark-unread' : 'mark-read',
	)
	const pendingTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

	useEffect(() => {
		return () => {
			if (pendingTimer.current) clearTimeout(pendingTimer.current)
		}
	}, [])

	// Keep the visible reveal in sync with the card's current read state when
	// no drag is in progress. Once the pointer is down, the reveal is locked
	// to the direction the user is committing to until pointer-up.
	useEffect(() => {
		if (!swipeRef.current.active) {
			setRevealVariant(isRead ? 'mark-unread' : 'mark-read')
		}
	}, [isRead])

	const triggerWithUndo = useCallback((variant: SwipeRevealVariant) => {
		setSwipePending(true)
		pendingTimer.current = setTimeout(() => {
			const c = callbacksRef.current
			if (variant === 'mark-read') {
				c.onMarkRead()
				if (c.analytics) {
					trackForyouCardMarkedRead({
						entity_type: c.analytics.entity_type,
						entity_id: c.analytics.entity_id,
					})
				}
			} else {
				c.onMarkUnread?.()
				if (c.analytics) {
					trackForyouCardMarkedUnread({
						entity_type: c.analytics.entity_type,
						entity_id: c.analytics.entity_id,
					})
				}
			}
			setSwipePending(false)
			pendingTimer.current = null
		}, 4500)
		toast(variant === 'mark-read' ? 'Marked as read' : 'Marked as unread', {
			duration: 4500,
			action: {
				label: 'Undo',
				onClick: () => {
					if (pendingTimer.current) {
						clearTimeout(pendingTimer.current)
						pendingTimer.current = null
					}
					setSwipePending(false)
				},
			},
		})
	}, [])

	const handlePointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
		// Presses starting on a button/link (quick-reply chips, Reply, Mark as
		// read) must not engage the swipe gesture — setPointerCapture below
		// retargets the resulting `click` event to this card, so the button's
		// own onClick never fires and the card's onClick fires instead.
		if ((e.target as HTMLElement).closest('button, a')) return
		const s = swipeRef.current
		s.startX = e.clientX
		s.startY = e.clientY
		s.lastX = e.clientX
		s.lastTime = Date.now()
		s.vel = 0
		s.dx = 0
		s.locked = false
		s.isHoriz = false
		s.active = true
		setRevealVariant(callbacksRef.current.isRead ? 'mark-unread' : 'mark-read')
		const el = e.currentTarget as HTMLDivElement
		// setPointerCapture is not available in jsdom — guard for test environments
		if (el.setPointerCapture) el.setPointerCapture(e.pointerId)
		setIsDragging(true)
	}, [])

	const handlePointerMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
		const s = swipeRef.current
		if (!s.active) return
		const dx = e.clientX - s.startX
		const dy = e.clientY - s.startY
		if (!s.locked) {
			if (Math.abs(dx) > 4 || Math.abs(dy) > 4) {
				s.locked = true
				s.isHoriz = Math.abs(dx) > Math.abs(dy) * 1.5
			}
		}
		if (!s.isHoriz) return
		// Clamp to the direction that matches the card's state: read cards
		// only track a leftward drag (mark-unread), unread cards only track a
		// rightward drag (mark-read). Wrong-direction pointer motion produces
		// a translation of 0 — the card visually rubber-bands on release and
		// the wrong-colour reveal never becomes visible.
		s.dx = callbacksRef.current.isRead ? Math.min(dx, 0) : Math.max(dx, 0)
		e.preventDefault()
		const now = Date.now()
		s.vel = (e.clientX - s.lastX) / (now - s.lastTime || 1)
		s.lastX = e.clientX
		s.lastTime = now
		setDragOffset(s.dx)
	}, [])

	const handlePointerUp = useCallback(() => {
		const s = swipeRef.current
		if (!s.active) return
		s.active = false
		setIsDragging(false)
		const { dx, vel } = s
		s.dx = 0
		setDragOffset(0)
		if (callbacksRef.current.isRead) {
			// Mark-unread commits on a left-swipe past threshold or velocity.
			// dx is negative here (clamped in handlePointerMove).
			if (!callbacksRef.current.onMarkUnread) return
			if (dx < -SWIPE_THRESHOLD || (vel < -VELOCITY_THRESHOLD && dx < -20)) {
				triggerWithUndo('mark-unread')
			}
			return
		}
		if (dx > SWIPE_THRESHOLD || (vel > VELOCITY_THRESHOLD && dx > 20)) {
			triggerWithUndo('mark-read')
		}
	}, [triggerWithUndo])

	const handlePointerCancel = useCallback(() => {
		const s = swipeRef.current
		s.active = false
		s.dx = 0
		setIsDragging(false)
		setDragOffset(0)
	}, [])

	const swipeBgOpacity =
		Math.abs(dragOffset) > 10 ? Math.min(Math.abs(dragOffset) / SWIPE_THRESHOLD, 1) : 0

	return {
		dragOffset,
		isDragging,
		swipePending,
		swipeBgOpacity,
		revealVariant,
		handlePointerDown,
		handlePointerMove,
		handlePointerUp,
		handlePointerCancel,
	}
}
