import { Button } from '@/components/ui/button'
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuShortcut,
	DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Separator } from '@/components/ui/separator'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { useIsMobile, useIsTouchViewport } from '@/hooks/use-mobile'
import { useSubscribe, useUnsubscribe } from '@/hooks/use-subscriptions'
import { trackEvent } from '@/lib/analytics'
import type { MemberResponse, ObjectResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import {
	Archive,
	Bell,
	BellOff,
	Copy,
	ExternalLink,
	FileText,
	MoreHorizontal,
	Trash2,
} from 'lucide-react'
import { Fragment, useCallback, useEffect, useMemo } from 'react'
import { toast } from 'sonner'
import { OwnerSelect, StatusSelect } from './property-selects'

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
	onArchiveRequest?: () => void
	workspaceId: string
	open?: boolean
	onOpenChange?: (open: boolean) => void
	// Properties group inputs — when all present and the viewport is narrow
	// (mobile Sheet or touch-viewport popover), the menu leads with a
	// Status + Driver row pair that mounts the same selects used in the hero.
	statuses?: string[]
	members?: MemberResponse[]
	currentDriverId?: string | null
	onStatusChange?: (status: string) => void
	onDriverChange?: (driver: string | null) => void
}

export function AuxiliaryActionMenu({
	object,
	onDeleteRequest,
	onArchiveRequest,
	workspaceId,
	open,
	onOpenChange,
	statuses,
	members,
	currentDriverId,
	onStatusChange,
	onDriverChange,
}: AuxiliaryActionMenuProps) {
	const isMobile = useIsMobile()
	// ≤1024 CSS px — the design brief targets ≤1080 for the narrow-desktop
	// compaction, but useIsTouchViewport is the existing hook and the closest
	// standard breakpoint. Wide desktop (>1024) leaves the Properties group off.
	const isTouchViewport = useIsTouchViewport()
	const subscribe = useSubscribe(workspaceId)
	const unsubscribe = useUnsubscribe(workspaceId)

	const showProperties =
		!!statuses &&
		statuses.length > 0 &&
		!!members &&
		!!onStatusChange &&
		!!onDriverChange &&
		(isMobile || isTouchViewport)

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

	const canArchive = object.type === 'bet' && !!onArchiveRequest && object.status !== 'archived'

	const items = useMemo<MenuItemDef[]>(() => {
		const base: MenuItemDef[] = [
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
		]
		if (canArchive && onArchiveRequest) {
			base.push({
				id: 'archive',
				label: 'Archive',
				icon: Archive,
				shortcut: 'A',
				separatorBefore: true,
				onSelect: onArchiveRequest,
			})
		}
		base.push({
			id: 'delete',
			label: 'Delete',
			icon: Trash2,
			shortcut: '⌘⌫',
			// Only draw a separator before Delete when Archive isn't sitting right
			// above it — otherwise the destructive-actions group gets a double rule.
			separatorBefore: !canArchive,
			variant: 'destructive',
			onSelect: onDeleteRequest,
		})
		return base
	}, [
		object,
		handleClipboard,
		handleSubscribeToggle,
		onDeleteRequest,
		onArchiveRequest,
		canArchive,
	])

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
			else if (e.key === 'a' && !e.shiftKey && !isMeta) itemId = 'archive'
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
		if (next) trackEvent('menu_opened', { objectType: object.type, objectId: object.id })
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

	const propertiesGroup = showProperties ? (
		<PropertiesGroup
			currentStatus={object.status}
			statuses={statuses ?? []}
			members={members ?? []}
			currentDriverId={currentDriverId ?? null}
			onStatusChange={onStatusChange ?? (() => {})}
			onDriverChange={onDriverChange ?? (() => {})}
		/>
	) : null

	if (isMobile) {
		return (
			<Sheet open={open} onOpenChange={handleOpenChange}>
				<SheetTrigger asChild>{trigger}</SheetTrigger>
				<SheetContent side="bottom" className="rounded-t-xl px-0 pb-6">
					<SheetHeader className="px-4">
						<SheetTitle>Actions</SheetTitle>
					</SheetHeader>
					{propertiesGroup && (
						<>
							<div className="mt-2 px-4">{propertiesGroup}</div>
							<Separator className="my-2" />
						</>
					)}
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
		<DropdownMenu open={open} onOpenChange={handleOpenChange} modal={false}>
			<DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="min-w-[200px]">
				{propertiesGroup && (
					<>
						<DropdownMenuLabel className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
							Properties
						</DropdownMenuLabel>
						<div className="px-2 pb-1.5 space-y-1.5">{propertiesGroup}</div>
						<DropdownMenuSeparator />
					</>
				)}
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

function PropertiesGroup({
	currentStatus,
	statuses,
	members,
	currentDriverId,
	onStatusChange,
	onDriverChange,
}: {
	currentStatus: string
	statuses: string[]
	members: MemberResponse[]
	currentDriverId: string | null
	onStatusChange: (status: string) => void
	onDriverChange: (driver: string | null) => void
}) {
	return (
		<div className="flex flex-col gap-1">
			<div className="flex min-h-[44px] items-center gap-2">
				<span className="w-14 shrink-0 text-[11px] uppercase tracking-wide text-muted-foreground">
					Status
				</span>
				<div className="flex-1 min-w-0">
					<StatusSelect current={currentStatus} options={statuses} onChange={onStatusChange} />
				</div>
			</div>
			<div className="flex min-h-[44px] items-center gap-2">
				<span className="w-14 shrink-0 text-[11px] uppercase tracking-wide text-muted-foreground">
					Driver
				</span>
				<div className="flex-1 min-w-0">
					<OwnerSelect
						members={members}
						currentOwnerId={currentDriverId}
						onChange={onDriverChange}
					/>
				</div>
			</div>
		</div>
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
