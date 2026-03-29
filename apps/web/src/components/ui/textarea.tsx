import * as React from 'react'

import { cn } from '@/lib/cn'

interface TextareaProps extends React.ComponentProps<'textarea'> {
	autoResize?: boolean
}

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
	({ className, autoResize, ...props }, ref) => {
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

		React.useEffect(() => {
			adjustHeight()
		}, [adjustHeight, props.value])

		return (
			<textarea
				className={cn(
					'flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-base ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 md:text-sm',
					autoResize && 'resize-none',
					className,
				)}
				ref={setRefs}
				onInput={(e) => {
					adjustHeight()
					props.onInput?.(e)
				}}
				{...props}
			/>
		)
	},
)
Textarea.displayName = 'Textarea'

export { Textarea }
