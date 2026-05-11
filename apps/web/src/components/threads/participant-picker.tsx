import { ActorAvatar } from '@/components/shared/actor-avatar'
import { Input } from '@/components/ui/input'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { useActors } from '@/hooks/use-actors'
import type { ActorListItem } from '@/lib/api'
import { getStoredActor } from '@/lib/auth'
import { cn } from '@/lib/cn'
import { X } from 'lucide-react'
import { useRef, useState } from 'react'

interface ParticipantPickerProps {
	workspaceId: string
	selected: ActorListItem[]
	onAdd: (actor: ActorListItem) => void
	onRemove: (actorId: string) => void
	disabled?: boolean
}

export function ParticipantPicker({
	workspaceId,
	selected,
	onAdd,
	onRemove,
	disabled,
}: ParticipantPickerProps) {
	const [search, setSearch] = useState('')
	const [open, setOpen] = useState(false)
	const inputRef = useRef<HTMLInputElement>(null)
	const { data: actors } = useActors(workspaceId)
	const currentActorId = getStoredActor()?.id

	const selectedIds = new Set(selected.map((a) => a.id))

	const filtered = (actors ?? []).filter((a) => {
		if (a.id === currentActorId) return false
		if (selectedIds.has(a.id)) return false
		if (!search.trim()) return true
		return a.name.toLowerCase().includes(search.toLowerCase())
	})

	const handleSelect = (actor: ActorListItem) => {
		onAdd(actor)
		setSearch('')
		setOpen(false)
		inputRef.current?.focus()
	}

	return (
		<div className="flex flex-col gap-1.5">
			{selected.length > 0 && (
				<div className="flex flex-wrap gap-1">
					{selected.map((actor) => (
						<span
							key={actor.id}
							className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs text-foreground"
						>
							<ActorAvatar name={actor.name} type={actor.type} size="sm" />
							<span>{actor.name}</span>
							{!disabled && (
								<button
									type="button"
									onClick={() => onRemove(actor.id)}
									className="ml-0.5 text-muted-foreground hover:text-foreground transition-colors"
									aria-label={`Remove ${actor.name}`}
								>
									<X size={11} />
								</button>
							)}
						</span>
					))}
				</div>
			)}

			<Popover open={open} onOpenChange={setOpen}>
				<PopoverAnchor asChild>
					<Input
						ref={inputRef}
						placeholder={selected.length === 0 ? 'Add people or agents…' : 'Add more…'}
						value={search}
						onChange={(e) => {
							setSearch(e.target.value)
							setOpen(true)
						}}
						onFocus={() => setOpen(true)}
						disabled={disabled}
						className="h-7 text-sm"
						autoComplete="off"
					/>
				</PopoverAnchor>
				<PopoverContent
					align="start"
					sideOffset={4}
					className={cn('p-1 w-64', filtered.length === 0 && 'hidden')}
					onOpenAutoFocus={(e) => e.preventDefault()}
				>
					{filtered.map((actor) => (
						<button
							key={actor.id}
							type="button"
							className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-bg-hover transition-colors"
							onClick={() => handleSelect(actor)}
						>
							<ActorAvatar name={actor.name} type={actor.type} size="sm" />
							<span className="flex-1 truncate text-left">{actor.name}</span>
							<span className="text-[10px] text-muted-foreground capitalize">{actor.type}</span>
						</button>
					))}
				</PopoverContent>
			</Popover>
		</div>
	)
}
