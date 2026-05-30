import { Button } from '@/components/ui/button'
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuShortcut,
	DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Separator } from '@/components/ui/separator'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { useIsMobile } from '@/hooks/use-mobile'
import { useSubscribe, useUnsubscribe } from '@/hooks/use-subscriptions'
import { trackEvent } from '@/lib/analytics'
import type { ObjectResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import { Bell, BellOff, Copy, ExternalLink, FileText, MoreHorizontal, Trash2 } from 'lucide-react'
import { Fragment, useCallback, useEffect, useMemo } from 'react'
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
	workspaceId: string
	open?: boolean
	onOpenChange?: (open: boolean) => void
}

export function AuxiliaryActionMenu({
	object,
	onDeleteRequest,
	workspaceId,
	open,
	onOpenChange,
}: AuxiliaryActionMenuProps) {
	const isMobile = useIsMobile()
	const subscribe = useSubscribe(workspaceId)
	const unsubscribe = useUnsubscribe(workspaceId)

	const handleClipboard = useCallback((text: string, label: string) => {
		if (!navigator.clipboard) {
			toast.error(`Failed to copy ${label.toLowerCase()}`)
			return
		}
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

	useEffect(() => {
		if (!open) return

		const handleKeyDown = (e: KeyboardEvent) => {
			const isMeta = e.metaKey || e.ctrlKey
			let itemId: string | null = null

			if (e.key === 'e' && !e.shiftKey && !isMeta) itemId = 'copy-link'
			else if (e.key === 'T' && e.shiftKey && !isMeta) itemId = 'copy-title'
			else if (e.key === 'C' && e.shiftKey && !isMeta) itemId = 'copy-content'
			else if (e.key === 's' && !e.shiftKey && !isMeta) itemId = 'subscribe'
			else if (e.key === 'Backspace' && isMeta) itemId = 'delete'

			if (!itemId) return

			const item = visibleItems.find((i) => i.id === itemId)
			if (!item || item.visibility === 'disable') return

			e.preventDefault()
			e.stopPropagation()
			item.onSelect()
			onOpenChange?.(false)
		}

		document.addEventListener('keydown', handleKeyDown, true)
		return () => document.removeEventListener('keydown', handleKeyDown, true)
	}, [open, visibleItems, onOpenChange])

	const handleOpenChange = (next: boolean) => {
		if (next) trackEvent('menu_opened', { object_type: object.type, object_id: object.id })
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
				<SheetTrigger asChild>{trigger}</SheetTrigger>
				<SheetContent side="bottom" className="rounded-t-xl px-0 pb-6">
					<SheetHeader className="px-4">
						<SheetTitle>Actions</SheetTitle>
					</SheetHeader>
					<div className="mt-2 flex flex-col">
						{visibleItems.map((item) => (
							<Fragment key={item.id}>
								{item.separatorBefore && <Separator className="my-1" />}
								<SheetMenuItemImpl item={item} closeSheet={() => onOpenChange?.(false)} />
							</Fragment>
						))}
					</div>
				</SheetContent>
			</Sheet>
		)
	}

	return (
		<DropdownMenu open={open} onOpenChange={handleOpenChange}>
			<DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="min-w-[200px]">
				{visibleItems.map((item) => (
					<Fragment key={item.id}>
						{item.separatorBefore && <DropdownMenuSeparator />}
						<DropdownMenuItemImpl item={item} isMobile={isMobile} />
					</Fragment>
				))}
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
			onSelect={item.onSelect}
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
