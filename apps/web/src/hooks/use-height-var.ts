import { type RefObject, useLayoutEffect } from 'react'

/**
 * Publishes an element's height as a CSS variable on its parent, so a sibling that scrolls
 * under it (a floating bar over a transcript) can pad itself by exactly that much. Follows
 * the element as it resizes and clears the variable when it goes away.
 *
 * `keepAtBottom` names a scroller inside the parent. One that was resting at its bottom stays
 * there when the height changes, so a composer growing a line does not cover the last message.
 */
export function useHeightVar(
	ref: RefObject<HTMLElement | null>,
	name: `--${string}`,
	options?: { keepAtBottom?: string },
) {
	const keepAtBottom = options?.keepAtBottom
	useLayoutEffect(() => {
		const el = ref.current
		const host = el?.parentElement
		if (!el || !host) return
		let first = true
		const apply = () => {
			// The first measurement only publishes the height: the scroller has not been placed yet.
			const scroller = !first && keepAtBottom ? host.querySelector<HTMLElement>(keepAtBottom) : null
			const wasAtBottom =
				!!scroller && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 24
			host.style.setProperty(name, `${el.getBoundingClientRect().height}px`)
			if (scroller && wasAtBottom) scroller.scrollTop = scroller.scrollHeight
		}
		apply()
		first = false
		const observer = new ResizeObserver(apply)
		observer.observe(el)
		return () => {
			observer.disconnect()
			host.style.removeProperty(name)
		}
	}, [ref, name, keepAtBottom])
}
