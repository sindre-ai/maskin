import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
	ResponsivePopover,
	ResponsivePopoverContent,
	ResponsivePopoverTrigger,
} from '@/components/ui/responsive-popover'
import { Command } from 'cmdk'
import { Check, ChevronDown, X } from 'lucide-react'
import type * as React from 'react'
import { useMemo, useState } from 'react'

export interface MultiSelectItem {
	id: string
	label: string
	hint?: string
}

interface SearchableMultiSelectProps {
	items: MultiSelectItem[]
	selectedIds: string[]
	onChange: (ids: string[]) => void
	placeholder?: string
	emptyText?: string
	loading?: boolean
	disabled?: boolean
	// Rendered next to each row in the popover — used by SlackFilters to show a
	// per-channel "not a member" hint when the bot hasn't joined that channel yet.
	trailing?: (item: MultiSelectItem) => React.ReactNode
	// Rendered at the bottom of the popover, below the row list — used by
	// SlackFilters to surface the >2000-channel truncation notice.
	footer?: React.ReactNode
	// Rendered inside each selected chip after the label, before the remove
	// button — used by SlackFilters to attach a per-chip warning dot when the
	// bot isn't a member of the picked channel.
	renderSelected?: (item: MultiSelectItem) => React.ReactNode
}

export function SearchableMultiSelect({
	items,
	selectedIds,
	onChange,
	placeholder = 'Select...',
	emptyText = 'No options',
	loading = false,
	disabled = false,
	trailing,
	footer,
	renderSelected,
}: SearchableMultiSelectProps) {
	const [open, setOpen] = useState(false)
	const [search, setSearch] = useState('')

	const itemsById = useMemo(() => new Map(items.map((i) => [i.id, i])), [items])
	const filtered = useMemo(() => {
		const q = search.trim().toLowerCase()
		if (!q) return items
		return items.filter(
			(i) => i.label.toLowerCase().includes(q) || i.hint?.toLowerCase().includes(q),
		)
	}, [items, search])

	function toggle(id: string) {
		if (selectedIds.includes(id)) {
			onChange(selectedIds.filter((s) => s !== id))
		} else {
			onChange([...selectedIds, id])
		}
	}

	function remove(id: string) {
		onChange(selectedIds.filter((s) => s !== id))
	}

	return (
		<div className="space-y-2">
			{selectedIds.length > 0 && (
				<div className="flex flex-wrap gap-1">
					{selectedIds.map((id) => {
						const item = itemsById.get(id)
						return (
							<Badge key={id} variant="secondary" className="gap-1 pr-1">
								<span>{item?.label ?? id}</span>
								{item && renderSelected?.(item)}
								<button
									type="button"
									className="rounded-sm hover:bg-accent"
									onClick={() => remove(id)}
									aria-label={`Remove ${item?.label ?? id}`}
								>
									<X size={12} />
								</button>
							</Badge>
						)
					})}
				</div>
			)}
			<ResponsivePopover open={open} onOpenChange={setOpen}>
				<ResponsivePopoverTrigger asChild>
					<Button
						type="button"
						variant="outline"
						size="sm"
						disabled={disabled}
						className="w-fit gap-1.5"
					>
						+ Add
						<ChevronDown size={12} />
					</Button>
				</ResponsivePopoverTrigger>
				<ResponsivePopoverContent align="start" className="w-72 p-0" accessibleTitle={placeholder}>
					<Command shouldFilter={false} label={placeholder}>
						<div className="border-b border-border p-2">
							<Command.Input
								autoFocus
								value={search}
								onValueChange={setSearch}
								placeholder={placeholder}
								className="flex h-8 w-full rounded-md border border-input bg-background px-3 py-2 text-base placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:text-sm"
							/>
						</div>
						<Command.List className="max-h-64 overflow-y-auto p-1">
							{loading ? (
								<div className="px-2 py-1.5 text-xs text-muted-foreground">Loading…</div>
							) : filtered.length === 0 ? (
								<div className="px-2 py-1.5 text-xs text-muted-foreground">{emptyText}</div>
							) : (
								filtered.map((item) => (
									<Command.Item
										key={item.id}
										value={item.id}
										onSelect={() => toggle(item.id)}
										className="flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm data-[selected=true]:bg-accent"
									>
										<div className="flex h-4 w-4 shrink-0 items-center justify-center">
											{selectedIds.includes(item.id) ? <Check size={14} /> : null}
										</div>
										<span className="flex-1 truncate">{item.label}</span>
										{item.hint && (
											<span className="shrink-0 text-xs text-muted-foreground">{item.hint}</span>
										)}
										{trailing?.(item)}
									</Command.Item>
								))
							)}
						</Command.List>
					</Command>
					{footer && (
						<div className="border-t border-border px-2 py-1.5 text-xs text-muted-foreground">
							{footer}
						</div>
					)}
				</ResponsivePopoverContent>
			</ResponsivePopover>
		</div>
	)
}
