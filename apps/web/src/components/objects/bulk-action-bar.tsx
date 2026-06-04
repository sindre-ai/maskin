import { Button } from '@/components/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@/components/ui/dialog'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/cn'
import { Brackets, ExternalLink, Link, Trash2, Type, X } from 'lucide-react'
import * as React from 'react'

export interface BulkActionBarOption {
	value: string
	label: string
}

export interface BulkActionBarOwnerOption {
	id: string
	name: string
}

export interface BulkActionBarProps {
	selectedCount: number
	statusOptions?: BulkActionBarOption[]
	ownerOptions?: BulkActionBarOwnerOption[]
	onStatusChange?: (status: string) => void
	onOwnerChange?: (actorId: string) => void
	onCopyLink?: () => void
	onCopyTitle?: () => void
	onCopyTitleAsLink?: () => void
	onOpenLinks?: () => void
	onDelete?: () => void
	onClear: () => void
}

function usePrefersReducedMotion() {
	const [reduced, setReduced] = React.useState(false)
	React.useEffect(() => {
		if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
		const mql = window.matchMedia('(prefers-reduced-motion: reduce)')
		const onChange = () => setReduced(mql.matches)
		onChange()
		mql.addEventListener('change', onChange)
		return () => mql.removeEventListener('change', onChange)
	}, [])
	return reduced
}

export function BulkActionBar({
	selectedCount,
	statusOptions = [],
	ownerOptions = [],
	onStatusChange,
	onOwnerChange,
	onCopyLink,
	onCopyTitle,
	onCopyTitleAsLink,
	onOpenLinks,
	onDelete,
	onClear,
}: BulkActionBarProps) {
	const visible = selectedCount > 0
	const reducedMotion = usePrefersReducedMotion()
	const [confirmOpen, setConfirmOpen] = React.useState(false)
	// Bump these keys after each pick so the Selects remount and don't latch onto
	// the last-chosen value — otherwise re-selecting the same status/owner on a
	// new row selection wouldn't refire onValueChange.
	const [statusKey, setStatusKey] = React.useState(0)
	const [ownerKey, setOwnerKey] = React.useState(0)

	React.useEffect(() => {
		if (!visible) return
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape' && !confirmOpen) onClear()
		}
		window.addEventListener('keydown', onKey)
		return () => window.removeEventListener('keydown', onKey)
	}, [visible, confirmOpen, onClear])

	// Close the confirm dialog automatically when the selection is cleared.
	React.useEffect(() => {
		if (!visible && confirmOpen) setConfirmOpen(false)
	}, [visible, confirmOpen])

	const transitionClass = reducedMotion ? '' : 'transition-all duration-200 ease-out'

	const plural = selectedCount === 1 ? '' : 's'
	const copyLinkLabel = `Copy link${plural}`
	const copyTitleLabel = `Copy title${plural}`
	const copyTitleAsLinkLabel = `Copy title${plural} as link${plural}`
	const openLinksLabel = `Open in new tab${plural}`

	return (
		<TooltipProvider delayDuration={150}>
			<section
				aria-label="Bulk actions"
				aria-hidden={!visible}
				inert={!visible || undefined}
				className={cn(
					'fixed left-1/2 bottom-10 z-50 -translate-x-1/2',
					'flex w-[calc(100%-2rem)] max-w-[44rem] items-center gap-2',
					'overflow-x-auto rounded-md border border-border bg-white px-3 py-2 shadow-lg',
					transitionClass,
					visible
						? 'pointer-events-auto opacity-100 translate-y-0'
						: 'pointer-events-none opacity-0 translate-y-4',
				)}
			>
				<span
					className="inline-flex h-7 min-w-7 shrink-0 items-center justify-center rounded-full bg-accent px-2 text-xs font-medium text-accent-foreground"
					aria-label={`${selectedCount} selected`}
				>
					{selectedCount}
				</span>
				<span className="hidden text-sm text-text-secondary sm:inline">selected</span>

				<div className="mx-1 h-5 w-px shrink-0 bg-border" aria-hidden="true" />

				{onStatusChange && statusOptions.length > 0 && (
					<Select
						key={`status-${statusKey}`}
						onValueChange={(value) => {
							onStatusChange(value)
							setStatusKey((k) => k + 1)
						}}
					>
						<SelectTrigger
							aria-label="Set status"
							className="shrink-0 text-sm data-[placeholder]:text-text-secondary"
						>
							<SelectValue placeholder="Status" />
						</SelectTrigger>
						<SelectContent>
							{statusOptions.map((opt) => (
								<SelectItem key={opt.value} value={opt.value}>
									{opt.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				)}

				<Select
					key={`owner-${ownerKey}`}
					onValueChange={(value) => {
						if (onOwnerChange) onOwnerChange(value)
						setOwnerKey((k) => k + 1)
					}}
					disabled={ownerOptions.length === 0 || !onOwnerChange}
				>
					<SelectTrigger
						aria-label="Set owner"
						className="shrink-0 text-sm data-[placeholder]:text-text-secondary"
					>
						<SelectValue placeholder="Owner" />
					</SelectTrigger>
					<SelectContent>
						{ownerOptions.map((opt) => (
							<SelectItem key={opt.id} value={opt.id}>
								{opt.name}
							</SelectItem>
						))}
					</SelectContent>
				</Select>

				<div className="ml-auto flex shrink-0 items-center gap-1">
					{onCopyLink && (
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									type="button"
									variant="outline"
									size="icon"
									className="size-8"
									onClick={onCopyLink}
									aria-label={copyLinkLabel}
								>
									<Link className="size-4" />
								</Button>
							</TooltipTrigger>
							<TooltipContent>{copyLinkLabel}</TooltipContent>
						</Tooltip>
					)}
					{onCopyTitle && (
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									type="button"
									variant="outline"
									size="icon"
									className="size-8"
									onClick={onCopyTitle}
									aria-label={copyTitleLabel}
								>
									<Type className="size-4" />
								</Button>
							</TooltipTrigger>
							<TooltipContent>{copyTitleLabel}</TooltipContent>
						</Tooltip>
					)}
					{onCopyTitleAsLink && (
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									type="button"
									variant="outline"
									size="icon"
									className="size-8"
									onClick={onCopyTitleAsLink}
									aria-label={copyTitleAsLinkLabel}
								>
									<Brackets className="size-4" />
								</Button>
							</TooltipTrigger>
							<TooltipContent>{`${copyTitleAsLinkLabel} (Markdown)`}</TooltipContent>
						</Tooltip>
					)}
					{onOpenLinks && (
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									type="button"
									variant="outline"
									size="icon"
									className="size-8"
									onClick={onOpenLinks}
									aria-label={openLinksLabel}
								>
									<ExternalLink className="size-4" />
								</Button>
							</TooltipTrigger>
							<TooltipContent>{openLinksLabel}</TooltipContent>
						</Tooltip>
					)}
					{onDelete && (
						<Button
							type="button"
							variant="outline"
							size="sm"
							className="text-destructive hover:bg-destructive/10 hover:text-destructive"
							onClick={() => setConfirmOpen(true)}
							aria-label="Delete selected"
						>
							<Trash2 className="size-4" />
							Delete
						</Button>
					)}
					<Button
						type="button"
						variant="ghost"
						size="icon"
						className="size-8 rounded-full"
						onClick={onClear}
						aria-label="Clear selection"
					>
						<X className="size-4" />
					</Button>
				</div>
			</section>

			<Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Delete {selectedCount} selected?</DialogTitle>
						<DialogDescription>
							This permanently removes the selected objects. This action cannot be undone.
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button type="button" variant="outline" onClick={() => setConfirmOpen(false)}>
							Cancel
						</Button>
						<Button
							type="button"
							variant="destructive"
							onClick={() => {
								setConfirmOpen(false)
								if (onDelete) onDelete()
							}}
						>
							Delete
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</TooltipProvider>
	)
}
