import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useCanWrite } from '@/hooks/use-can-write'
import { VIEWER_READ_ONLY_MESSAGE } from '@/lib/workspace-role'
import type { ReactNode } from 'react'

/**
 * Wraps a write control the viewer cannot use. The caller still disables the
 * control with `useCanWrite()`; this adds the explanation. A disabled button
 * swallows pointer events, so the tooltip hangs off a wrapping span instead.
 * For everyone else it renders the child untouched.
 */
export function ViewerTooltip({
	children,
	className = 'inline-flex',
}: {
	children: ReactNode
	/** Layout of the wrapping span, for a control that fills its row. */
	className?: string
}) {
	const canWrite = useCanWrite()
	if (canWrite) return <>{children}</>
	return (
		<TooltipProvider delayDuration={150}>
			<Tooltip>
				<TooltipTrigger asChild>
					<span className={className}>{children}</span>
				</TooltipTrigger>
				<TooltipContent>{VIEWER_READ_ONLY_MESSAGE}</TooltipContent>
			</Tooltip>
		</TooltipProvider>
	)
}
