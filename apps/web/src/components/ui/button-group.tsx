import type * as React from 'react'

import { cn } from '@/lib/cn'

function ButtonGroup({ className, ...props }: React.ComponentProps<'div'>) {
	return (
		<div
			className={cn(
				'inline-flex items-center rounded-md border border-input shadow-xs',
				'[&>button]:rounded-none [&>button]:border-0 [&>button]:shadow-none',
				'[&>button:first-child]:rounded-l-md [&>button:last-child]:rounded-r-md',
				'[&>button:not(:last-child)]:border-r [&>button:not(:last-child)]:border-input',
				className,
			)}
			{...props}
		/>
	)
}

export { ButtonGroup }
