import { trackForyouCardMarkedRead } from '@/lib/analytics'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { toast } from 'sonner'

export const SWIPE_THRESHOLD = 80
const VELOCITY_THRESHOLD = 0.42

interface UseSwipeToMarkReadResult {
	dragOffset: number
	isDragging: boolean
	swipePending: boolean
	swipeBgOpacity: number
	handlePointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void
	handlePointerMove: (e: ReactPointerEvent<HTMLDivElement>) => void
	handlePointerUp: () => void
	handlePointerCancel: () => void
}

// Optional analytics context for the mark-read event. When provided, a
// `foryou_card_marked_read` PostHog event fires inside the post-Undo timer
// callback — i.e. only on a completed swipe. Tapping Undo cancels the timer, so
// no event fires. Callers that don't pass this (unit tests, non-For-You surfaces
// added later) get the pre-existing behaviour with no analytics side effect.
interface SwipeAnalytics {
	entity_type: string
	entity_id: string
}

export function useSwipeToMarkRead(
	onMarkRead: () => void,
	analytics?: SwipeAnalytics,
): UseSwipeToMarkReadResult {
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
	const pendingReadTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

	useEffect(() => {
		return () => {
			if (pendingReadTimer.current) clearTimeout(pendingReadTimer.current)
		}
	}, [])

	const triggerMarkReadWithUndo = useCallback(() => {
		setSwipePending(true)
		pendingReadTimer.current = setTimeout(() => {
			onMarkRead()
			if (analytics) {
				trackForyouCardMarkedRead({
					entity_type: analytics.entity_type,
					entity_id: analytics.entity_id,
				})
			}
			setSwipePending(false)
			pendingReadTimer.current = null
		}, 4500)
		toast('Marked as read', {
			duration: 4500,
			action: {
				label: 'Undo',
				onClick: () => {
					if (pendingReadTimer.current) {
						clearTimeout(pendingReadTimer.current)
						pendingReadTimer.current = null
					}
					setSwipePending(false)
				},
			},
		})
	}, [onMarkRead, analytics])

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
		s.dx = Math.max(dx, 0) // right-swipe only
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
		if (dx > SWIPE_THRESHOLD || (vel > VELOCITY_THRESHOLD && dx > 20)) {
			triggerMarkReadWithUndo()
		}
	}, [triggerMarkReadWithUndo])

	const handlePointerCancel = useCallback(() => {
		const s = swipeRef.current
		s.active = false
		s.dx = 0
		setIsDragging(false)
		setDragOffset(0)
	}, [])

	const swipeBgOpacity = dragOffset > 10 ? Math.min(dragOffset / SWIPE_THRESHOLD, 1) : 0

	return {
		dragOffset,
		isDragging,
		swipePending,
		swipeBgOpacity,
		handlePointerDown,
		handlePointerMove,
		handlePointerUp,
		handlePointerCancel,
	}
}
