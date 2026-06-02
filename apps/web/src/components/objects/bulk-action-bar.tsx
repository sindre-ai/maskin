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

export type BulkActionBarScope = 'ids' | 'filter'

/** Filter chip shown in the destructive confirm dialog when the user is acting
 * on filter scope — so the predicate they're about to apply is verifiable. */
export interface BulkActionBarFilterChip {
	label: string
	value: string
}

export interface BulkActionBarScopeNotice {
	/** Loaded rows currently selected (the "X selected" the user just made). */
	loadedCount: number
	/** Total rows the active filter matches across the workspace. */
	matchingCount: number
	/** Promote selection from "all loaded" to "all matching this filter". */
	onSelectAllMatching: () => void
}

export interface BulkActionBarProps {
	selectedCount: number
	/** `'ids'` for the loaded-rows selection (default). `'filter'` once the user
	 * has promoted to "all N matching this filter" — switches the badge color,
	 * label, and disables per-row icon actions (which can't act on unloaded
	 * rows). */
	scope?: BulkActionBarScope
	/** Notice chip stacked above the pill — appears only when every loaded row
	 * is selected and more rows match the filter, mirroring Gmail's pattern. */
	scopeNotice?: BulkActionBarScopeNotice
	/** Active filter chips listed in the destructive confirm dialog body so the
	 * user can verify the predicate before deleting. Empty array = no chips
	 * rendered. */
	filterChips?: BulkActionBarFilterChip[]
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
	scope = 'ids',
	scopeNotice,
	filterChips = [],
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
	const isFilterScope = scope === 'filter'
	const scopeLabel = isFilterScope ? 'matching filter' : 'selected'

	// Per-row icon actions can't act on rows the virtualizer never loaded — at
	// filter scope they'd silently miss the unloaded majority of the selection.
	// Disable them with an explaining tooltip rather than firing a partial op.
	const loadedOnlyTooltip = 'Loaded rows only — narrow the filter to act on these'

	// The scope notice should only render alongside a visible pill; aria-hidden
	// follows the same `visible` flag the pill uses below.
	const showScopeNotice = scopeNotice !== undefined && visible && scope === 'ids'

	return (
		<TooltipProvider delayDuration={150}>
			{showScopeNotice && (
				<aside
					aria-label="Selection scope notice"
					className={cn(
						'fixed left-1/2 bottom-[5.75rem] z-50 -translate-x-1/2',
						'flex w-[calc(100%-2rem)] max-w-[44rem] items-center gap-2',
						'rounded-full border border-accent/40 bg-bg-surface px-3 py-1.5 text-xs shadow-md',
						transitionClass,
					)}
				>
					<span className="text-text-secondary">
						All <strong className="text-text">{scopeNotice.loadedCount}</strong> loaded selected.
					</span>
					<button
						type="button"
						onClick={scopeNotice.onSelectAllMatching}
						className="text-accent underline-offset-2 hover:underline"
					>
						Select all {scopeNotice.matchingCount.toLocaleString()} matching this filter
					</button>
				</aside>
			)}
			<section
				aria-label="Bulk actions"
				aria-hidden={!visible}
				inert={!visible || undefined}
				className={cn(
					'fixed left-1/2 bottom-10 z-50 -translate-x-1/2',
					'flex w-[calc(100%-2rem)] max-w-[44rem] items-center gap-2',
					'rounded-full border border-border bg-bg-surface px-3 py-2 shadow-lg',
					transitionClass,
					visible
						? 'pointer-events-auto opacity-100 translate-y-0'
						: 'pointer-events-none opacity-0 translate-y-4',
				)}
			>
				<span
					className={cn(
						'inline-flex h-7 min-w-7 items-center justify-center rounded-full px-2 text-xs font-medium',
						isFilterScope ? 'bg-indigo-500 text-white' : 'bg-accent text-accent-foreground',
					)}
					aria-label={`${selectedCount} ${scopeLabel}`}
				>
					{selectedCount.toLocaleString()}
				</span>
				<span className="text-sm text-text-secondary">{scopeLabel}</span>

				<div className="mx-1 h-5 w-px bg-border" aria-hidden="true" />

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
							className="text-sm data-[placeholder]:text-text-secondary"
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
						className="text-sm data-[placeholder]:text-text-secondary"
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

				<div className="ml-auto flex items-center gap-1">
					{onCopyLink && (
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									type="button"
									variant="outline"
									size="icon"
									className="size-8"
									onClick={onCopyLink}
									disabled={isFilterScope}
									aria-label={copyLinkLabel}
								>
									<Link className="size-4" />
								</Button>
							</TooltipTrigger>
							<TooltipContent>{isFilterScope ? loadedOnlyTooltip : copyLinkLabel}</TooltipContent>
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
									disabled={isFilterScope}
									aria-label={copyTitleLabel}
								>
									<Type className="size-4" />
								</Button>
							</TooltipTrigger>
							<TooltipContent>{isFilterScope ? loadedOnlyTooltip : copyTitleLabel}</TooltipContent>
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
									disabled={isFilterScope}
									aria-label={copyTitleAsLinkLabel}
								>
									<Brackets className="size-4" />
								</Button>
							</TooltipTrigger>
							<TooltipContent>
								{isFilterScope ? loadedOnlyTooltip : `${copyTitleAsLinkLabel} (Markdown)`}
							</TooltipContent>
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
									disabled={isFilterScope}
									aria-label={openLinksLabel}
								>
									<ExternalLink className="size-4" />
								</Button>
							</TooltipTrigger>
							<TooltipContent>{isFilterScope ? loadedOnlyTooltip : openLinksLabel}</TooltipContent>
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
						<DialogTitle>
							{isFilterScope
								? `Delete all ${selectedCount.toLocaleString()} matching this filter?`
								: `Delete ${selectedCount} selected?`}
						</DialogTitle>
						<DialogDescription>
							{`${selectedCount.toLocaleString()} object${plural} · permanent · cannot be undone.`}
						</DialogDescription>
					</DialogHeader>
					{isFilterScope && filterChips.length > 0 && (
						<div className="flex flex-wrap gap-1.5 text-xs" aria-label="Active filters">
							{filterChips.map((chip) => (
								<span
									key={`${chip.label}-${chip.value}`}
									className="inline-flex items-center gap-1 rounded-full border border-border bg-bg-hover px-2 py-0.5"
								>
									<span className="text-text-secondary">{chip.label}:</span>
									<span className="text-text">{chip.value}</span>
								</span>
							))}
						</div>
					)}
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
