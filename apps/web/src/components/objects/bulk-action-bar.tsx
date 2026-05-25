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
import { cn } from '@/lib/cn'
import { Trash2, X } from 'lucide-react'
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
	onDelete,
	onClear,
}: BulkActionBarProps) {
	const visible = selectedCount > 0
	const reducedMotion = usePrefersReducedMotion()
	const [confirmOpen, setConfirmOpen] = React.useState(false)

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

	return (
		<>
			<section
				aria-label="Bulk actions"
				aria-hidden={!visible}
				inert={!visible || undefined}
				className={cn(
					'fixed left-1/2 bottom-6 z-50 -translate-x-1/2',
					'flex w-[calc(100%-2rem)] max-w-[36rem] items-center gap-2',
					'rounded-full border border-border bg-bg-surface px-3 py-2 shadow-lg',
					transitionClass,
					visible
						? 'pointer-events-auto opacity-100 translate-y-0'
						: 'pointer-events-none opacity-0 translate-y-4',
				)}
			>
				<span
					className="inline-flex h-7 min-w-7 items-center justify-center rounded-full bg-accent px-2 text-xs font-medium text-accent-foreground"
					aria-label={`${selectedCount} selected`}
				>
					{selectedCount}
				</span>
				<span className="text-sm text-text-secondary">selected</span>

				<div className="mx-1 h-5 w-px bg-border" aria-hidden="true" />

				<Select
					onValueChange={(value) => {
						if (onStatusChange) onStatusChange(value)
					}}
					disabled={statusOptions.length === 0 || !onStatusChange}
				>
					<SelectTrigger aria-label="Set status">
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

				<Select
					onValueChange={(value) => {
						if (onOwnerChange) onOwnerChange(value)
					}}
					disabled={ownerOptions.length === 0 || !onOwnerChange}
				>
					<SelectTrigger aria-label="Set owner">
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
					{onDelete && (
						<Button
							type="button"
							variant="ghost"
							size="sm"
							className="rounded-full text-destructive hover:bg-destructive/10 hover:text-destructive"
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
		</>
	)
}
