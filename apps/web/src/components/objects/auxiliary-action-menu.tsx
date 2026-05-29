import { Button } from '@/components/ui/button'
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuShortcut,
	DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { useIsMobile } from '@/hooks/use-mobile'
import { useSubscribe, useUnsubscribe } from '@/hooks/use-subscriptions'
import type { ObjectResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import { Bell, BellOff, Copy, ExternalLink, FileText, MoreHorizontal, Trash2 } from 'lucide-react'
import { useCallback, useMemo } from 'react'
import { toast } from 'sonner'

type Visibility = 'hide' | 'disable'

interface MenuItemDef {
	id: string
	label: string
	icon: typeof Copy
	shortcut?: string
	visibility?: Visibility
	disabledReason?: string
	separatorBefore?: boolean
	variant?: 'default' | 'destructive'
	onSelect: () => void
}

export interface AuxiliaryActionMenuProps {
	object: ObjectResponse
	onDeleteRequest: () => void
	isDeleting?: boolean
	workspaceId: string
	open?: boolean
	onOpenChange?: (open: boolean) => void
}

export function AuxiliaryActionMenu({
	object,
	onDeleteRequest,
	isDeleting = false,
	workspaceId,
	open,
	onOpenChange,
}: AuxiliaryActionMenuProps) {
	const isMobile = useIsMobile()
	const subscribe = useSubscribe(workspaceId)
	const unsubscribe = useUnsubscribe(workspaceId)

	const handleClipboard = useCallback((text: string, label: string) => {
		navigator.clipboard.writeText(text).then(
			() => toast.success(`${label} copied`),
			() => toast.error(`Failed to copy ${label.toLowerCase()}`),
		)
	}, [])

	const handleSubscribeToggle = useCallback(() => {
		if (object.is_subscribed) {
			unsubscribe.mutate({ entityType: 'object', entityId: object.id })
		} else {
			subscribe.mutate({ entityType: 'object', entityId: object.id })
		}
	}, [object.is_subscribed, object.id, subscribe, unsubscribe])

	const items = useMemo<MenuItemDef[]>(
		() => [
			{
				id: 'copy-link',
				label: 'Copy link',
				icon: ExternalLink,
				shortcut: 'E',
				onSelect: () => handleClipboard(window.location.href, 'Link'),
			},
			{
				id: 'copy-title',
				label: 'Copy title',
				icon: FileText,
				shortcut: '⇧T',
				onSelect: () => handleClipboard(object.title ?? '', 'Title'),
			},
			{
				id: 'copy-content',
				label: 'Copy content',
				icon: Copy,
				shortcut: '⇧C',
				onSelect: () => handleClipboard(object.content ?? '', 'Content'),
			},
			{
				id: 'subscribe',
				label: object.is_subscribed ? 'Unsubscribe' : 'Subscribe',
				icon: object.is_subscribed ? BellOff : Bell,
				shortcut: 'S',
				onSelect: handleSubscribeToggle,
			},
			{
				id: 'delete',
				label: 'Delete',
				icon: Trash2,
				shortcut: '⌘⌫',
				separatorBefore: true,
				variant: 'destructive',
				onSelect: onDeleteRequest,
			},
		],
		[object, handleClipboard, handleSubscribeToggle, onDeleteRequest],
	)

	const visibleItems = items.filter((item) => item.visibility !== 'hide')

	const handleOpenChange = (next: boolean) => {
		if (next) console.log('menu_opened', { objectType: object.type, objectId: object.id })
		onOpenChange?.(next)
	}

	const trigger = (
		<Button
			variant="ghost"
			size="icon"
			className="h-7 w-7 text-muted-foreground"
			aria-label="More actions"
		>
			<MoreHorizontal size={15} />
		</Button>
	)

	if (isMobile) {
		return (
			<Sheet open={open} onOpenChange={handleOpenChange}>
				{trigger}
				<SheetContent side="bottom" className="rounded-t-xl px-0 pb-6">
					<SheetHeader className="px-4">
						<SheetTitle>Actions</SheetTitle>
					</SheetHeader>
					<div className="mt-2 flex flex-col">
						{visibleItems.map((item) =>
							item.separatorBefore ? (
								<div key={item.id}>
									<div className="my-1 h-px bg-border" />
									<SheetMenuItemImpl item={item} closeSheet={() => onOpenChange?.(false)} />
								</div>
							) : (
								<SheetMenuItemImpl
									key={item.id}
									item={item}
									closeSheet={() => onOpenChange?.(false)}
								/>
							),
						)}
					</div>
				</SheetContent>
			</Sheet>
		)
	}

	return (
		<DropdownMenu open={open} onOpenChange={handleOpenChange}>
			<DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="min-w-[200px]">
				{visibleItems.map((item) =>
					item.separatorBefore ? (
						<div key={item.id}>
							<DropdownMenuSeparator />
							<DropdownMenuItemImpl item={item} isMobile={isMobile} />
						</div>
					) : (
						<DropdownMenuItemImpl key={item.id} item={item} isMobile={isMobile} />
					),
				)}
			</DropdownMenuContent>
		</DropdownMenu>
	)
}

function DropdownMenuItemImpl({
	item,
	isMobile,
}: {
	item: MenuItemDef
	isMobile: boolean
}) {
	return (
		<DropdownMenuItem
			disabled={item.visibility === 'disable'}
			title={item.visibility === 'disable' ? item.disabledReason : undefined}
			onClick={(e) => {
				e.preventDefault()
				item.onSelect()
			}}
			className={cn(
				item.variant === 'destructive' && 'text-error focus:bg-error/10 focus:text-error',
			)}
		>
			<item.icon className={cn('h-4 w-4', item.variant === 'destructive' && 'text-error')} />
			{item.label}
			{item.shortcut && !isMobile && <DropdownMenuShortcut>{item.shortcut}</DropdownMenuShortcut>}
		</DropdownMenuItem>
	)
}

function SheetMenuItemImpl({
	item,
	closeSheet,
}: {
	item: MenuItemDef
	closeSheet: () => void
}) {
	return (
		<Button
			variant="ghost"
			disabled={item.visibility === 'disable'}
			title={item.visibility === 'disable' ? item.disabledReason : undefined}
			onClick={() => {
				item.onSelect()
				closeSheet()
			}}
			className={cn(
				'h-[44px] justify-start gap-3 rounded-none px-4 font-normal',
				item.variant === 'destructive' && 'text-error hover:text-error',
			)}
		>
			<item.icon className={cn('h-4 w-4', item.variant === 'destructive' && 'text-error')} />
			{item.label}
		</Button>
	)
}
