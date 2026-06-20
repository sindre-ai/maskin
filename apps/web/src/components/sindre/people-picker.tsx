import { ActorAvatar } from '@/components/shared/actor-avatar'
import {
	ResponsivePopover,
	ResponsivePopoverContent,
	ResponsivePopoverTrigger,
} from '@/components/ui/responsive-popover'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import type { ConversationParticipant } from '@/hooks/use-sindre-conversation'
import { cn } from '@/lib/cn'
import { Bot, Check, Search } from 'lucide-react'
import { type ReactNode, useMemo, useState } from 'react'

type PickerTab = 'all' | 'people' | 'agents'

interface PeoplePickerProps {
	trigger: ReactNode
	participants: ConversationParticipant[]
	allActors: ConversationParticipant[]
	onAdd: (id: string) => void
	defaultTab?: PickerTab
	align?: 'start' | 'center' | 'end'
}

/**
 * Tabbed popover that invites humans and/or agents into a conversation.
 * Reused by `ParticipantBar` (header `+` chip) and `ConversationComposer`
 * (toolbar People button). On <768px collapses to a bottom Sheet via
 * `ResponsivePopover` so the picker stays in the thumb zone on mobile.
 */
export function PeoplePicker({
	trigger,
	participants,
	allActors,
	onAdd,
	defaultTab = 'all',
	align = 'start',
}: PeoplePickerProps) {
	const [open, setOpen] = useState(false)
	const [tab, setTab] = useState<PickerTab>(defaultTab)
	const [query, setQuery] = useState('')

	const presentIds = useMemo(() => new Set(participants.map((p) => p.id)), [participants])

	const matches = useMemo(() => {
		const q = query.trim().toLowerCase()
		return allActors.filter((a) => {
			if (q.length === 0) return true
			if (a.name.toLowerCase().includes(q)) return true
			if (a.role?.toLowerCase().includes(q)) return true
			return false
		})
	}, [allActors, query])

	const people = useMemo(() => matches.filter((a) => a.kind === 'human'), [matches])
	const agents = useMemo(() => matches.filter((a) => a.kind === 'agent'), [matches])

	function handleAdd(id: string) {
		onAdd(id)
		// Keep the picker open so a host can invite several people in one go —
		// matches the prototype's "add several, close when done" loop.
	}

	return (
		<ResponsivePopover
			open={open}
			onOpenChange={(next) => {
				setOpen(next)
				if (!next) setQuery('')
			}}
		>
			<ResponsivePopoverTrigger asChild>{trigger}</ResponsivePopoverTrigger>
			<ResponsivePopoverContent
				align={align}
				className="flex w-80 flex-col gap-2 p-0"
				accessibleTitle="Add people or agents"
			>
				<div className="flex items-center gap-2 border-border border-b px-3 py-2">
					<Search size={14} className="text-text-muted" aria-hidden />
					<input
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						placeholder="Search workspace…"
						aria-label="Search workspace"
						className="flex-1 border-0 bg-transparent p-0 text-foreground text-sm outline-none placeholder:text-text-muted"
					/>
				</div>
				<Tabs value={tab} onValueChange={(v) => setTab(v as PickerTab)} className="px-3">
					<TabsList className="h-8 w-full bg-transparent p-0">
						<PickerTab value="all" label="All" />
						<PickerTab value="people" label="People" />
						<PickerTab value="agents" label="Agents" />
					</TabsList>
					<TabsContent value="all" className="mt-2 max-h-72 overflow-y-auto px-0 py-1">
						<Section label="People" actors={people} present={presentIds} onAdd={handleAdd} />
						<Section label="Agents" actors={agents} present={presentIds} onAdd={handleAdd} />
						{people.length === 0 && agents.length === 0 ? <EmptyHint /> : null}
					</TabsContent>
					<TabsContent value="people" className="mt-2 max-h-72 overflow-y-auto px-0 py-1">
						{people.length === 0 ? <EmptyHint /> : null}
						<List actors={people} present={presentIds} onAdd={handleAdd} />
					</TabsContent>
					<TabsContent value="agents" className="mt-2 max-h-72 overflow-y-auto px-0 py-1">
						{agents.length === 0 ? <EmptyHint /> : null}
						<List actors={agents} present={presentIds} onAdd={handleAdd} />
					</TabsContent>
				</Tabs>
			</ResponsivePopoverContent>
		</ResponsivePopover>
	)
}

function PickerTab({ value, label }: { value: PickerTab; label: string }) {
	return (
		<TabsTrigger
			value={value}
			className="h-8 flex-1 rounded-none border-border border-b bg-transparent px-2 text-text-secondary text-xs shadow-none data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:font-medium data-[state=active]:text-foreground data-[state=active]:shadow-none"
		>
			{label}
		</TabsTrigger>
	)
}

function Section({
	label,
	actors,
	present,
	onAdd,
}: {
	label: string
	actors: ConversationParticipant[]
	present: Set<string>
	onAdd: (id: string) => void
}) {
	if (actors.length === 0) return null
	return (
		<div className="pb-1">
			<div className="px-2 pt-2 pb-1 font-medium text-[10px] text-text-muted uppercase tracking-wider">
				{label}
			</div>
			<List actors={actors} present={present} onAdd={onAdd} />
		</div>
	)
}

function List({
	actors,
	present,
	onAdd,
}: {
	actors: ConversationParticipant[]
	present: Set<string>
	onAdd: (id: string) => void
}) {
	return (
		<ul className="flex flex-col gap-0.5">
			{actors.map((actor) => {
				const isPresent = present.has(actor.id)
				return (
					<li key={actor.id}>
						<button
							type="button"
							disabled={isPresent}
							onClick={() => onAdd(actor.id)}
							aria-label={isPresent ? `${actor.name} already in conversation` : `Add ${actor.name}`}
							className={cn(
								'flex min-h-[44px] w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm',
								isPresent ? 'cursor-default text-text-muted' : 'text-foreground hover:bg-bg-hover',
							)}
						>
							<ActorAvatar name={actor.name} type={actor.kind} size="sm" />
							<span className="min-w-0 flex-1">
								<span className="block truncate font-medium">{actor.name}</span>
								{actor.role ? (
									<span className="block truncate text-[11px] text-text-muted">{actor.role}</span>
								) : null}
							</span>
							{actor.kind === 'agent' ? (
								<Bot size={12} className="shrink-0 text-text-muted" aria-hidden />
							) : null}
							{isPresent ? <Check size={14} className="shrink-0 text-success" aria-hidden /> : null}
						</button>
					</li>
				)
			})}
		</ul>
	)
}

function EmptyHint() {
	return (
		<p className="px-2 py-6 text-center text-sm text-text-muted">No matches in this workspace.</p>
	)
}
