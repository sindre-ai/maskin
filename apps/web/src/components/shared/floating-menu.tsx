import { cn } from '@/lib/cn'
import { useEffect, useState } from 'react'

// Shared by the slash menu and the emoji list. Kept apart from slash-menu.tsx so the chat box
// does not pull the document editor (Tiptap markdown) into its chunk.

const MOBILE_QUERY = '(max-width: 640px)'

export function isMobileViewport(): boolean {
	return typeof window !== 'undefined' && window.matchMedia?.(MOBILE_QUERY).matches === true
}

// Header label: 11px semibold muted sentence case. The 8px mono eyebrow is too small on
// touch and would render as BLOCKS.
export const HEADER_CLASS =
	'px-[9px] pb-[6px] pt-[5px] text-[11px] font-semibold text-muted-foreground'

export const ROW_CLASS = cn(
	'flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-1.5',
	'data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground',
)

// Keeps a bottom sheet above the on-screen keyboard. Position: fixed follows the
// layout viewport, which a mobile keyboard overlaps, so lift the sheet by the
// part of the layout viewport the visual viewport no longer covers.
export function useKeyboardInset(enabled: boolean): number {
	const [inset, setInset] = useState(0)
	useEffect(() => {
		const viewport = window.visualViewport
		if (!enabled || !viewport) return
		const update = () =>
			setInset(Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop))
		update()
		viewport.addEventListener('resize', update)
		viewport.addEventListener('scroll', update)
		return () => {
			viewport.removeEventListener('resize', update)
			viewport.removeEventListener('scroll', update)
		}
	}, [enabled])
	return inset
}
