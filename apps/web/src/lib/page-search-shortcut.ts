import { useEffect, useRef } from 'react'

/**
 * Cmd+F / Ctrl+F focuses the current page's own search when it has one.
 *
 * One registry and one listener: a page search registers a focus function while
 * it is mounted (`usePageSearchShortcut`), and the workspace shell mounts the single
 * keydown listener (`usePageSearchShortcutListener`). On a page with no registered
 * search the listener does nothing, so the browser's own find still works.
 */

/** Returns false when it could not take focus (the field is hidden or gone). */
export type PageSearchFocus = () => boolean | undefined

const registry: PageSearchFocus[] = []

/** Registers a page search. The most recently registered one wins. Returns the unregister. */
export function registerPageSearch(focus: PageSearchFocus): () => void {
	registry.push(focus)
	return () => {
		const index = registry.lastIndexOf(focus)
		if (index !== -1) registry.splice(index, 1)
	}
}

/** Focuses the newest registered search that can take focus. True when one did. */
export function focusPageSearch(): boolean {
	for (let i = registry.length - 1; i >= 0; i--) {
		if (registry[i]?.() !== false) return true
	}
	return false
}

/** True when the element is on screen (not display:none, hidden or inside either). */
export function isRendered(element: HTMLElement): boolean {
	return typeof element.checkVisibility === 'function' ? element.checkVisibility() : true
}

/** Focuses an input and selects its text. False when it is missing or not rendered. */
export function focusField(input: HTMLInputElement | null | undefined): boolean {
	if (!input || !isRendered(input)) return false
	input.focus()
	input.select()
	return true
}

function dialogIsOpen(): boolean {
	return document.querySelector('[role="dialog"], [role="alertdialog"]') !== null
}

/** The keydown handler. Calls preventDefault only when a page search took the key. */
export function handlePageSearchKeydown(event: KeyboardEvent): void {
	if (event.key.toLowerCase() !== 'f') return
	if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return
	if (event.defaultPrevented) return
	// A palette, sheet or dialog on top owns the keyboard.
	if (dialogIsOpen()) return
	if (focusPageSearch()) event.preventDefault()
}

/** Mount once, in the workspace shell. */
export function usePageSearchShortcutListener(): void {
	useEffect(() => {
		document.addEventListener('keydown', handlePageSearchKeydown)
		return () => document.removeEventListener('keydown', handlePageSearchKeydown)
	}, [])
}

/** A page's search registers its focus function while mounted. */
export function usePageSearchShortcut(focus: PageSearchFocus): void {
	const latest = useRef(focus)
	latest.current = focus
	useEffect(() => registerPageSearch(() => latest.current()), [])
}
