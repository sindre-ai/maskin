import { useHeightVar } from '@/hooks/use-height-var'
import { cn } from '@/lib/cn'
import { type ReactNode, useRef } from 'react'

// The strip has no background and lets clicks through; only the controls inside it take them.
export const FLOATING_EDGE =
	'pointer-events-none absolute inset-x-0 z-10 [&_:is(a,button,input,select,textarea,form,label,[role=button],[role=checkbox],[contenteditable=true])]:pointer-events-auto'

/**
 * A composer strip pinned to the bottom of its container and drawn over the content, which
 * scrolls up behind it. It publishes its height as `name` on the container, so the scroller
 * beside it pads itself by exactly that much (`pb-[calc(var(--name)+8px)]`) and the last row
 * rests clear of it. The container must be `relative`.
 */
export function FloatingFooter({
	name,
	className,
	children,
}: {
	name: `--${string}`
	className?: string
	children: ReactNode
}) {
	const ref = useRef<HTMLDivElement>(null)
	useHeightVar(ref, name, { keepAtBottom: '[data-floating-scroller]' })
	return (
		<div ref={ref} className={cn(FLOATING_EDGE, 'bottom-0', className)}>
			{children}
		</div>
	)
}
