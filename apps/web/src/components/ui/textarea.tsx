import * as React from 'react'

import { cn } from '@/lib/cn'

interface TextareaProps extends React.ComponentProps<'textarea'> {
	autoResize?: boolean
}

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
	({ className, autoResize, onInput, ...props }, ref) => {
		const internalRef = React.useRef<HTMLTextAreaElement | null>(null)

		const setRefs = React.useCallback(
			(node: HTMLTextAreaElement | null) => {
				internalRef.current = node
				if (typeof ref === 'function') ref(node)
				else if (ref) ref.current = node
			},
			[ref],
		)

		const adjustHeight = React.useCallback(() => {
			const el = internalRef.current
			if (!el || !autoResize) return
			el.style.height = 'auto'
			// Cap the inline height at the CSS-declared max-height so a paste that
			// blows scrollHeight into the thousands (a huge markdown table) can't
			// stamp a matching inline height onto the element. The CSS max-height
			// alone visually clamps the rendered box, but the runaway inline height
			// wrecks the textarea's own scroll thumb (thumb-to-track ratio collapses
			// to a pixel) and forces the parent flex layout to reason about a
			// multi-thousand-pixel child. Falling back to scrollHeight when no
			// max-height is set preserves the "grow to fit" caller (agent-document).
			const maxHeight = Number.parseFloat(window.getComputedStyle(el).maxHeight)
			const nextHeight = Number.isFinite(maxHeight)
				? Math.min(el.scrollHeight, maxHeight)
				: el.scrollHeight
			el.style.height = `${nextHeight}px`
		}, [autoResize])

		// biome-ignore lint/correctness/useExhaustiveDependencies: props.value triggers resize on programmatic changes
		React.useEffect(() => {
			adjustHeight()
		}, [adjustHeight, props.value])

		React.useEffect(() => {
			if (!autoResize || typeof document === 'undefined' || !document.fonts?.ready) return
			let cancelled = false
			document.fonts.ready.then(() => {
				if (!cancelled) adjustHeight()
			})
			return () => {
				cancelled = true
			}
		}, [adjustHeight, autoResize])

		return (
			<textarea
				className={cn(
					'flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-base ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 md:text-sm',
					autoResize && 'resize-none overflow-hidden',
					className,
				)}
				ref={setRefs}
				{...props}
				onInput={(e) => {
					adjustHeight()
					onInput?.(e)
				}}
			/>
		)
	},
)
Textarea.displayName = 'Textarea'

export { Textarea }
