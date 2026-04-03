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

	useEffect(() => {
		const el = scrollContainerRef?.current
		if (!el) return

		const handleWheel = (e: WheelEvent) => {
			if (navigatingRef.current) return

			const hasOverflow = el.scrollHeight > el.clientHeight + 2
			const atBottom = !hasOverflow || el.scrollHeight - el.scrollTop - el.clientHeight < 2
			const atTop = !hasOverflow || el.scrollTop < 2
			const scrollingDown = e.deltaY > 0
			const scrollingUp = e.deltaY < 0

			// Determine if we should accumulate
			let dir: 'next' | 'prev' | null = null
			if (atBottom && scrollingDown && hasNext) {
				dir = 'next'
			} else if (atTop && scrollingUp && hasPrev) {
				dir = 'prev'
			}

			if (!dir) {
				// If user scrolled away from boundary, reset
				if (directionRef.current) reset()
				return
			}

			// If direction changed, reset
			if (directionRef.current && directionRef.current !== dir) {
				reset()
			}

			e.preventDefault()

			directionRef.current = dir
			accumulatedRef.current += Math.abs(e.deltaY)

			const progress = Math.min(accumulatedRef.current / THRESHOLD, 1)
			const targetLabel =
				dir === 'next' ? pages[currentIndex + 1]?.label : pages[currentIndex - 1]?.label

			setState({ direction: dir, progress, targetLabel: targetLabel ?? null })

			// Clear existing decay timer
			if (decayTimerRef.current) clearTimeout(decayTimerRef.current)
			decayTimerRef.current = setTimeout(reset, DECAY_MS)

			// Trigger navigation
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
		}

		el.addEventListener('wheel', handleWheel, { passive: false })

		return () => {
			el.removeEventListener('wheel', handleWheel)
			if (decayTimerRef.current) clearTimeout(decayTimerRef.current)
		}
	}, [scrollContainerRef, hasNext, hasPrev, currentIndex, pages, workspaceId, navigate, reset])

	return state
}
