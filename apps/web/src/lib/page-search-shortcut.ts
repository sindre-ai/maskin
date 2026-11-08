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

// A modal on top: the palette (aria-modal), a Radix dialog or sheet (data-state="open"), an
// alert dialog. The inline, non-modal role=dialog cards (the link preview, the secret card)
// do not count, and neither does one that is hidden.
const MODAL_SELECTOR =
	'[role="alertdialog"], [role="dialog"][aria-modal="true"], [role="dialog"][data-state="open"]'

function dialogIsOpen(): boolean {
	return Array.from(document.querySelectorAll<HTMLElement>(MODAL_SELECTOR)).some(isRendered)
}

// Where the person is typing prose or code, or reading a chat: Cmd+F is the browser's find
// there (a thread has its own in-page search to reach). The page search field itself is an
// input, so it is not in this list.
function ownsFind(event: KeyboardEvent): boolean {
	const target = event.target
	if (target instanceof HTMLElement) {
		if (target instanceof HTMLTextAreaElement || target.isContentEditable) return true
		if (target.closest('.cm-editor, [contenteditable="true"]')) return true
	}
	return /\/chats\/[^/]+/.test(window.location.pathname)
}

/** The keydown handler. Calls preventDefault only when a page search took the key. */
export function handlePageSearchKeydown(event: KeyboardEvent): void {
	if (event.key.toLowerCase() !== 'f') return
	if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return
	if (event.defaultPrevented) return
	// A palette, sheet or dialog on top owns the keyboard.
	if (dialogIsOpen()) return
	if (ownsFind(event)) return
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
