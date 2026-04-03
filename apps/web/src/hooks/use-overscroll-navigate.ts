import { useScrollContainer } from '@/lib/scroll-container-context'
import { useNavigate } from '@tanstack/react-router'
import { useCallback, useEffect, useRef, useState } from 'react'

interface PageDef {
	label: string
	to: string
}

interface OverscrollState {
	direction: 'next' | 'prev' | null
	progress: number
	targetLabel: string | null
}

const THRESHOLD = 300
const DECAY_MS = 500
const INITIAL_STATE: OverscrollState = {
	direction: null,
	progress: 0,
	targetLabel: null,
}

export function useOverscrollNavigate(
	pages: PageDef[],
	currentIndex: number,
	workspaceId: string,
): OverscrollState {
	const scrollContainerRef = useScrollContainer()
	const navigate = useNavigate()

	const [state, setState] = useState<OverscrollState>(INITIAL_STATE)

	const accumulatedRef = useRef(0)
	const directionRef = useRef<'next' | 'prev' | null>(null)
	const decayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
	const navigatingRef = useRef(false)
	const touchStartYRef = useRef<number | null>(null)
	const lastTouchYRef = useRef<number | null>(null)

	const hasNext = currentIndex >= 0 && currentIndex < pages.length - 1
	const hasPrev = currentIndex > 0

	const reset = useCallback(() => {
		accumulatedRef.current = 0
		directionRef.current = null
		setState({ direction: null, progress: 0, targetLabel: null })
	}, [])

	// Reset when page changes — use ref comparison to avoid extra effect
	const prevIndexRef = useRef(currentIndex)
	if (prevIndexRef.current !== currentIndex) {
		prevIndexRef.current = currentIndex
		navigatingRef.current = false
		accumulatedRef.current = 0
		directionRef.current = null
		setState(INITIAL_STATE)
	}

	const handleDelta = useCallback(
		(el: HTMLElement, deltaY: number, preventDefaultFn?: () => void) => {
			if (navigatingRef.current) return

			const hasOverflow = el.scrollHeight > el.clientHeight + 2
			const atBottom = !hasOverflow || el.scrollHeight - el.scrollTop - el.clientHeight < 2
			const atTop = !hasOverflow || el.scrollTop < 2
			const scrollingDown = deltaY > 0
			const scrollingUp = deltaY < 0

			let dir: 'next' | 'prev' | null = null
			if (atBottom && scrollingDown && hasNext) {
				dir = 'next'
			} else if (atTop && scrollingUp && hasPrev) {
				dir = 'prev'
			}

			if (!dir) {
				if (directionRef.current) reset()
				return
			}

			if (directionRef.current && directionRef.current !== dir) {
				reset()
			}

			preventDefaultFn?.()

			directionRef.current = dir
			accumulatedRef.current += Math.abs(deltaY)

			const progress = Math.min(accumulatedRef.current / THRESHOLD, 1)
			const targetLabel =
				dir === 'next' ? pages[currentIndex + 1]?.label : pages[currentIndex - 1]?.label

			setState({ direction: dir, progress, targetLabel: targetLabel ?? null })

			if (decayTimerRef.current) clearTimeout(decayTimerRef.current)
			decayTimerRef.current = setTimeout(reset, DECAY_MS)

			if (progress >= 1) {
				navigatingRef.current = true
				if (decayTimerRef.current) clearTimeout(decayTimerRef.current)

				const targetPage = dir === 'next' ? pages[currentIndex + 1] : pages[currentIndex - 1]
				if (targetPage) {
					navigate({
						to: targetPage.to,
						params: { workspaceId },
					}).then(() => {
						requestAnimationFrame(() => {
							el.scrollTop = dir === 'next' ? 0 : el.scrollHeight
						})
					})
				}
			}
		},
		[hasNext, hasPrev, currentIndex, pages, workspaceId, navigate, reset],
	)

	useEffect(() => {
		const el = scrollContainerRef?.current
		if (!el) return

		const handleWheel = (e: WheelEvent) => {
			handleDelta(el, e.deltaY, () => e.preventDefault())
		}

		const handleTouchStart = (e: TouchEvent) => {
			const touch = e.touches[0]
			if (touch) {
				touchStartYRef.current = touch.clientY
				lastTouchYRef.current = touch.clientY
			}
		}

		const handleTouchMove = (e: TouchEvent) => {
			const touch = e.touches[0]
			if (!touch || lastTouchYRef.current === null) return

			// Touch delta is inverted: swipe up (negative clientY change) = scroll down
			const deltaY = lastTouchYRef.current - touch.clientY
			lastTouchYRef.current = touch.clientY

			handleDelta(el, deltaY, () => e.preventDefault())
		}

		const handleTouchEnd = () => {
			touchStartYRef.current = null
			lastTouchYRef.current = null
		}

		el.addEventListener('wheel', handleWheel, { passive: false })
		el.addEventListener('touchstart', handleTouchStart, { passive: true })
		el.addEventListener('touchmove', handleTouchMove, { passive: false })
		el.addEventListener('touchend', handleTouchEnd)

		return () => {
			el.removeEventListener('wheel', handleWheel)
			el.removeEventListener('touchstart', handleTouchStart)
			el.removeEventListener('touchmove', handleTouchMove)
			el.removeEventListener('touchend', handleTouchEnd)
			if (decayTimerRef.current) clearTimeout(decayTimerRef.current)
		}
	}, [scrollContainerRef, handleDelta])

	return state
}
