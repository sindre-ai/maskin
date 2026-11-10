import { useHeightVar } from '@/hooks/use-height-var'
import { cn } from '@/lib/cn'
import { type ReactNode, useRef } from 'react'

/**
 * The controls that take clicks inside a floating strip. The strip itself has no background and
 * lets clicks through to the content behind it, and `pointer-events` is inherited, so anything
 * interactive that is not matched here would be dead. One list, shared by every strip; add the
 * new kind of control here rather than in a copy.
 */
export const FLOATING_CONTROLS =
	'[&_:is(h1,a,button,input,select,textarea,form,label,summary,[role=button],[role=tab],[role=combobox],[role=checkbox],[role=switch],[role=link],[contenteditable=true])]:pointer-events-auto'

export const FLOATING_EDGE = `pointer-events-none absolute inset-x-0 z-10 ${FLOATING_CONTROLS}`

/**
 * A composer strip pinned to the bottom of its container and drawn over the content, which
 * scrolls up behind it. It publishes its height as `name` on the container, so the scroller
 * beside it pads itself by exactly that much (`pb-[calc(var(--name)+8px)]`) and the last row
 * rests clear of it. The container must be `relative`.
 */
export function FloatingFooter({
	name,
	className,
	keepAtBottom = false,
	children,
}: {
	name: `--${string}`
	className?: string
	/** The scroller beside it is a transcript: stay at its bottom when the strip changes height. */
	keepAtBottom?: boolean
	children: ReactNode
}) {
	const ref = useRef<HTMLDivElement>(null)
	useHeightVar(ref, name, keepAtBottom ? { keepAtBottom: '[data-floating-scroller]' } : undefined)
	return (
		<div ref={ref} className={cn(FLOATING_EDGE, 'bottom-0', className)}>
			{children}
		</div>
	)
}
