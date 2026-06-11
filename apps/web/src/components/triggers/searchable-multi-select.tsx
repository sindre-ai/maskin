import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
	ResponsivePopover,
	ResponsivePopoverContent,
	ResponsivePopoverTrigger,
} from '@/components/ui/responsive-popover'
import { cn } from '@/lib/cn'
import { Check, ChevronDown, X } from 'lucide-react'
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
}

export function SearchableMultiSelect({
	items,
	selectedIds,
	onChange,
	placeholder = 'Select...',
	emptyText = 'No options',
	loading = false,
	disabled = false,
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
								<button
									type="button"
									className="rounded-sm hover:bg-bg-hover"
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
					<div className="border-b border-border p-2">
						<Input
							autoFocus
							value={search}
							onChange={(e) => setSearch(e.target.value)}
							placeholder={placeholder}
							className="h-8"
						/>
					</div>
					<div className="max-h-64 overflow-y-auto p-1">
						{loading ? (
							<div className="px-2 py-1.5 text-xs text-muted-foreground">Loading…</div>
						) : filtered.length === 0 ? (
							<div className="px-2 py-1.5 text-xs text-muted-foreground">{emptyText}</div>
						) : (
							filtered.map((item) => {
								const selected = selectedIds.includes(item.id)
								return (
									<button
										key={item.id}
										type="button"
										onClick={() => toggle(item.id)}
										className={cn(
											'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-bg-hover',
											selected && 'bg-bg-hover',
										)}
									>
										<div className="flex h-4 w-4 shrink-0 items-center justify-center">
											{selected ? <Check size={14} /> : null}
										</div>
										<span className="flex-1 truncate">{item.label}</span>
										{item.hint && (
											<span className="shrink-0 text-xs text-muted-foreground">{item.hint}</span>
										)}
									</button>
								)
							})
						)}
					</div>
				</ResponsivePopoverContent>
			</ResponsivePopover>
		</div>
	)
}
