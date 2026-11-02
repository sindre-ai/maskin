import * as React from 'react'

const MOBILE_BREAKPOINT = 768
const TOUCH_VIEWPORT_BREAKPOINT = 1024
const WIDE_DESKTOP_VIEWPORT_BREAKPOINT = 1280

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

// True at ≥1024 CSS px — the viewport class where side rails (e.g. Today's
// Brief) render inline beside primary content instead of as an overlay Sheet.
// Boundary is inclusive of 1024 to match the redesign's AC ("right-rail at 1024").
export function useIsDesktopViewport() {
	const [isDesktop, setIsDesktop] = React.useState<boolean | undefined>(undefined)

	React.useEffect(() => {
		const mql = window.matchMedia(`(min-width: ${TOUCH_VIEWPORT_BREAKPOINT}px)`)
		const onChange = () => {
			setIsDesktop(window.innerWidth >= TOUCH_VIEWPORT_BREAKPOINT)
		}
		mql.addEventListener('change', onChange)
		setIsDesktop(window.innerWidth >= TOUCH_VIEWPORT_BREAKPOINT)
		return () => mql.removeEventListener('change', onChange)
	}, [])

	return !!isDesktop
}

// True at ≥1280 CSS px (Tailwind `xl`) — wide enough for a 440px right rail
// beside the chat column with the app sidebar open. Below it, such a rail
// opens as an overlay Sheet instead.
export function useIsWideDesktopViewport() {
	const [isWide, setIsWide] = React.useState<boolean | undefined>(undefined)

	React.useEffect(() => {
		const mql = window.matchMedia(`(min-width: ${WIDE_DESKTOP_VIEWPORT_BREAKPOINT}px)`)
		const onChange = () => {
			setIsWide(window.innerWidth >= WIDE_DESKTOP_VIEWPORT_BREAKPOINT)
		}
		mql.addEventListener('change', onChange)
		setIsWide(window.innerWidth >= WIDE_DESKTOP_VIEWPORT_BREAKPOINT)
		return () => mql.removeEventListener('change', onChange)
	}, [])

	return !!isWide
}
