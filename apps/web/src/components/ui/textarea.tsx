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
			el.style.height = `${el.scrollHeight}px`
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
