import * as CheckboxPrimitive from '@radix-ui/react-checkbox'
import { Check } from 'lucide-react'
import * as React from 'react'

import { cn } from '@/lib/cn'

type CheckboxSize = 'sm' | 'touch'

// AC-T6: at ≤1024px viewports the visible checkbox must read as ≥44×44 CSS px,
// centered on the visible box. Tailwind v4 compiles `max-[value]:` to
// `@media not all and (min-width: value)`, which is EXCLUSIVE of value — at
// exactly 1024px (iPad landscape) that condition is false and the touch size
// never applies. Bumping the arbitrary value by a hair keeps 1024px itself
// inside the "not min-width" range without affecting any other breakpoint.
const TOUCH_ROOT = 'max-[1024.02px]:h-11 max-[1024.02px]:w-11 max-[1024.02px]:rounded-md'
const TOUCH_INDICATOR = 'max-[1024.02px]:h-6 max-[1024.02px]:w-6'

interface CheckboxProps extends React.ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root> {
	size?: CheckboxSize
}

const Checkbox = React.forwardRef<React.ElementRef<typeof CheckboxPrimitive.Root>, CheckboxProps>(
	({ className, size = 'sm', ...props }, ref) => (
		<CheckboxPrimitive.Root
			ref={ref}
			data-size={size}
			className={cn(
				'grid place-content-center peer h-4 w-4 shrink-0 rounded-sm border border-primary ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground',
				size === 'touch' && TOUCH_ROOT,
				className,
			)}
			{...props}
		>
			<CheckboxPrimitive.Indicator className={cn('grid place-content-center text-current')}>
				<Check className={cn('h-4 w-4', size === 'touch' && TOUCH_INDICATOR)} />
			</CheckboxPrimitive.Indicator>
		</CheckboxPrimitive.Root>
	),
)
Checkbox.displayName = CheckboxPrimitive.Root.displayName

export { Checkbox }
