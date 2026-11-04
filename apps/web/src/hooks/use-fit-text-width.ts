import { useLayoutEffect, useRef } from 'react'

/**
 * Shrinks a message column to its widest line of text. A wrapped line leaves a gap on the right of
 * a box that grew to its max width, and plain CSS cannot close it, so the lines are measured and
 * the column gets that width in pixels. The width is cleared before each measure, so a wider
 * container lets the text re-wrap before it is fitted again.
 *
 * `column` holds the plate and anything that should match its width, `plate` is the padded box
 * around `text`. `minWidth` keeps the plate (padding included) from going narrower than that.
 */
export function useFitTextWidth({
	enabled,
	minWidth = 0,
	contentKey,
}: {
	enabled: boolean
	minWidth?: number
	/** Changes whenever the text does, so it is measured again. */
	contentKey: string
}) {
	const columnRef = useRef<HTMLDivElement>(null)
	const plateRef = useRef<HTMLDivElement>(null)
	const textRef = useRef<HTMLSpanElement>(null)

	// biome-ignore lint/correctness/useExhaustiveDependencies: contentKey re-runs the measure when the text changes
	useLayoutEffect(() => {
		const column = columnRef.current
		const plate = plateRef.current
		const text = textRef.current
		if (!enabled || !column || !plate || !text) return
		const range = document.createRange()
		// Not every environment can measure text (jsdom cannot): the column stays at its natural width.
		if (typeof range.getClientRects !== 'function') return

		const fit = () => {
			column.style.width = ''
			range.selectNodeContents(text)
			const rects = Array.from(range.getClientRects()).filter((rect) => rect.width > 0)
			if (rects.length === 0) return
			const plateBox = plate.getBoundingClientRect()
			const gutter = column.getBoundingClientRect().right - plateBox.right
			const padding = Number.parseFloat(getComputedStyle(plate).paddingRight) || 0
			const widest = Math.max(...rects.map((rect) => rect.right))
			const fitted = Math.max(Math.ceil(widest - plateBox.left) + padding, minWidth) + gutter
			// The column's own max-width still caps this, so a long message wraps as it did.
			column.style.width = `${fitted}px`
		}

		fit()
		if (typeof ResizeObserver === 'undefined') {
			return () => {
				column.style.width = ''
			}
		}
		// The container changing width re-wraps the text; the plate changing height means a chip got
		// its name or a font loaded. Setting the width back to the same value changes nothing.
		const observer = new ResizeObserver(fit)
		observer.observe(plate)
		if (column.parentElement) observer.observe(column.parentElement)
		return () => {
			observer.disconnect()
			column.style.width = ''
		}
	}, [enabled, minWidth, contentKey])

	return { columnRef, plateRef, textRef }
}
