import * as TabsPrimitive from '@radix-ui/react-tabs'
import * as React from 'react'

import { cn } from '@/lib/cn'

const Tabs = TabsPrimitive.Root

/**
 * `default` is shadcn's filled tab strip. `segmented` is the compact 2-way
 * switch v2 puts at the right of a section rule (mockup 1140–1143): a hairline
 * box holding 24px items, where the active item takes the muted fill instead
 * of the strip doing so.
 */
type TabsVariant = 'default' | 'segmented'

const TabsVariantContext = React.createContext<TabsVariant>('default')

const TabsList = React.forwardRef<
	React.ElementRef<typeof TabsPrimitive.List>,
	React.ComponentPropsWithoutRef<typeof TabsPrimitive.List> & { variant?: TabsVariant }
>(({ className, variant = 'default', ...props }, ref) => (
	<TabsVariantContext.Provider value={variant}>
		<TabsPrimitive.List
			ref={ref}
			className={cn(
				'inline-flex items-center justify-center text-muted-foreground',
				variant === 'segmented'
					? 'gap-0.5 rounded-[9px] border border-border p-0.5'
					: 'h-10 rounded-md bg-muted p-1',
				className,
			)}
			{...props}
		/>
	</TabsVariantContext.Provider>
))
TabsList.displayName = TabsPrimitive.List.displayName

const TabsTrigger = React.forwardRef<
	React.ElementRef<typeof TabsPrimitive.Trigger>,
	React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref) => {
	const variant = React.useContext(TabsVariantContext)
	return (
		<TabsPrimitive.Trigger
			ref={ref}
			className={cn(
				'inline-flex items-center justify-center whitespace-nowrap ring-offset-background transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 data-[state=active]:text-foreground',
				variant === 'segmented'
					? 'h-6 gap-1.5 rounded-[7px] px-2.5 text-[11.5px] font-semibold data-[state=active]:bg-muted'
					: 'rounded-sm px-3 py-1.5 text-sm font-medium data-[state=active]:bg-background data-[state=active]:shadow-sm',
				className,
			)}
			{...props}
		/>
	)
})
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName

const TabsContent = React.forwardRef<
	React.ElementRef<typeof TabsPrimitive.Content>,
	React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
	<TabsPrimitive.Content
		ref={ref}
		className={cn(
			'mt-2 ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
			className,
		)}
		{...props}
	/>
))
TabsContent.displayName = TabsPrimitive.Content.displayName

export { Tabs, TabsList, TabsTrigger, TabsContent }
