import * as React from 'react'

const MOBILE_BREAKPOINT = 768
const TOUCH_VIEWPORT_BREAKPOINT = 1024

export function useIsMobile() {
	const [isMobile, setIsMobile] = React.useState<boolean | undefined>(undefined)

	React.useEffect(() => {
		const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`)
		const onChange = () => {
			setIsMobile(window.innerWidth < MOBILE_BREAKPOINT)
		}
		mql.addEventListener('change', onChange)
		setIsMobile(window.innerWidth < MOBILE_BREAKPOINT)
		return () => mql.removeEventListener('change', onChange)
	}, [])

	return !!isMobile
}

// True at iPad-and-below viewports (≤1024 CSS px) — the viewport class where
// iOS HIG / WCAG 2.5.5 AAA require ≥44×44 touch targets. Boundary is inclusive
// of 1024 to cover iPad landscape (matches AC-T6).
export function useIsTouchViewport() {
	const [isTouch, setIsTouch] = React.useState<boolean | undefined>(undefined)

	React.useEffect(() => {
		const mql = window.matchMedia(`(max-width: ${TOUCH_VIEWPORT_BREAKPOINT}px)`)
		const onChange = () => {
			setIsTouch(window.innerWidth <= TOUCH_VIEWPORT_BREAKPOINT)
		}
		mql.addEventListener('change', onChange)
		setIsTouch(window.innerWidth <= TOUCH_VIEWPORT_BREAKPOINT)
		return () => mql.removeEventListener('change', onChange)
	}, [])

	return !!isTouch
}
