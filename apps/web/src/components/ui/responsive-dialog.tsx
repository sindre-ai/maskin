import type * as DialogPrimitive from '@radix-ui/react-dialog'
import * as React from 'react'

import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from '@/components/ui/dialog'
import {
	Sheet,
	SheetClose,
	SheetContent,
	SheetDescription,
	SheetFooter,
	SheetHeader,
	SheetTitle,
	SheetTrigger,
} from '@/components/ui/sheet'
import { useIsMobile } from '@/hooks/use-mobile'
import { cn } from '@/lib/cn'

// Switches Dialog to a bottom Sheet at <768px (content-sized, capped at 85dvh
// with rounded top corners). Pick this for any dialog whose content would clip
// on a phone — import flows, multi-step forms, larger forms. Small confirm
// dialogs should keep using <Dialog> directly.

const ResponsiveDialogModeContext = React.createContext<'dialog' | 'sheet'>('dialog')

function useMode() {
	return React.useContext(ResponsiveDialogModeContext)
}

function ResponsiveDialog({ children, ...props }: React.ComponentProps<typeof Dialog>) {
	const isMobile = useIsMobile()
	const mode = isMobile ? 'sheet' : 'dialog'
	const Root = isMobile ? Sheet : Dialog
	return (
		<ResponsiveDialogModeContext.Provider value={mode}>
			<Root {...props}>{children}</Root>
		</ResponsiveDialogModeContext.Provider>
	)
}

const ResponsiveDialogTrigger = React.forwardRef<
	React.ElementRef<typeof DialogPrimitive.Trigger>,
	React.ComponentPropsWithoutRef<typeof DialogPrimitive.Trigger>
>((props, ref) => {
	const Trigger = useMode() === 'sheet' ? SheetTrigger : DialogTrigger
	return <Trigger ref={ref} {...props} />
})
ResponsiveDialogTrigger.displayName = 'ResponsiveDialogTrigger'

const ResponsiveDialogClose = React.forwardRef<
	React.ElementRef<typeof DialogPrimitive.Close>,
	React.ComponentPropsWithoutRef<typeof DialogPrimitive.Close>
>((props, ref) => {
	const Close = useMode() === 'sheet' ? SheetClose : DialogClose
	return <Close ref={ref} {...props} />
})
ResponsiveDialogClose.displayName = 'ResponsiveDialogClose'

const ResponsiveDialogContent = React.forwardRef<
	React.ElementRef<typeof DialogPrimitive.Content>,
	React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(({ className, children, ...props }, ref) => {
	if (useMode() === 'sheet') {
		return (
			<SheetContent
				ref={ref}
				side="bottom"
				className={cn(
					'flex max-h-[85dvh] w-full max-w-none flex-col rounded-t-lg rounded-b-none pb-[max(1.5rem,env(safe-area-inset-bottom))]',
					className,
				)}
				{...props}
			>
				{children}
			</SheetContent>
		)
	}
	return (
		<DialogContent ref={ref} className={className} {...props}>
			{children}
		</DialogContent>
	)
})
ResponsiveDialogContent.displayName = 'ResponsiveDialogContent'

const ResponsiveDialogHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => {
	const Header = useMode() === 'sheet' ? SheetHeader : DialogHeader
	return <Header className={className} {...props} />
}
ResponsiveDialogHeader.displayName = 'ResponsiveDialogHeader'

const ResponsiveDialogFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => {
	const Footer = useMode() === 'sheet' ? SheetFooter : DialogFooter
	return <Footer className={className} {...props} />
}
ResponsiveDialogFooter.displayName = 'ResponsiveDialogFooter'

const ResponsiveDialogTitle = React.forwardRef<
	React.ElementRef<typeof DialogPrimitive.Title>,
	React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>((props, ref) => {
	const Title = useMode() === 'sheet' ? SheetTitle : DialogTitle
	return <Title ref={ref} {...props} />
})
ResponsiveDialogTitle.displayName = 'ResponsiveDialogTitle'

const ResponsiveDialogDescription = React.forwardRef<
	React.ElementRef<typeof DialogPrimitive.Description>,
	React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>((props, ref) => {
	const Description = useMode() === 'sheet' ? SheetDescription : DialogDescription
	return <Description ref={ref} {...props} />
})
ResponsiveDialogDescription.displayName = 'ResponsiveDialogDescription'

export {
	ResponsiveDialog,
	ResponsiveDialogTrigger,
	ResponsiveDialogClose,
	ResponsiveDialogContent,
	ResponsiveDialogHeader,
	ResponsiveDialogFooter,
	ResponsiveDialogTitle,
	ResponsiveDialogDescription,
}
