import { type RefObject, useEffect } from 'react'

/**
 * ⌘F / Ctrl+F focuses `inputRef` instead of opening the browser's find. Only
 * the pages that own a search box call this; everywhere else the browser's own
 * find is left alone.
 */
export function useFindShortcut(inputRef: RefObject<HTMLInputElement | null>): void {
	useEffect(() => {
		const handler = (e: KeyboardEvent) => {
			if (e.key !== 'f' || !(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return
			const input = inputRef.current
			if (!input) return
			e.preventDefault()
			input.focus()
			input.select()
		}
		document.addEventListener('keydown', handler)
		return () => document.removeEventListener('keydown', handler)
	}, [inputRef])
}
