import { type CreatableType, CreatePicker } from '@/components/shared/create-picker'
import { Button } from '@/components/ui/button'
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuShortcut,
	DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useCommandPalette } from '@/lib/command-palette-context'
import { Bot, ChevronDown, MessageSquare, Plus, RefreshCw, Search } from 'lucide-react'
import { useState } from 'react'

interface CreateConfig {
	type: CreatableType
	subtype?: string
}

const OBJECT_TYPE_ITEMS: { subtype: string; label: string; swatchClassName: string }[] = [
	{ subtype: 'task', label: 'Task', swatchClassName: 'bg-type-task-bg' },
	{ subtype: 'insight', label: 'Insight', swatchClassName: 'bg-type-insight-bg' },
	{ subtype: 'bet', label: 'Bet', swatchClassName: 'bg-type-bet-bg' },
]

interface NewMenuProps {
	// Only step that varies by page — the global header opens the docked chat
	// panel, the For You page opens its own inline conversation composer.
	onNewChat: () => void
	// Object-detail pages drop the "Create an object" section — landing users
	// on the generic object picker is disorienting when they're mid-edit on a
	// specific object. New chat/loop/agent/search stay.
	hideObjectSection?: boolean
}

// The single "+ New" menu used everywhere (global header, For You page) so
// the trigger and dropdown contents can never drift apart between pages.
export function NewMenu({ onNewChat, hideObjectSection }: NewMenuProps) {
	const [createConfig, setCreateConfig] = useState<CreateConfig | null>(null)
	const { setOpen: setPaletteOpen } = useCommandPalette()

	return (
		<>
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<Button size="sm" aria-label="New" className="h-7 gap-1 px-2">
						<Plus size={14} aria-hidden />
						<span className="hidden sm:inline">New</span>
						<ChevronDown size={12} aria-hidden className="opacity-70" />
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end" className="w-72">
					<DropdownMenuItem onSelect={onNewChat} className="items-start gap-2.5 py-2">
						<span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-foreground text-background">
							<MessageSquare size={13} />
						</span>
						<span className="min-w-0 flex-1">
							<span className="block text-sm font-medium">New chat</span>
							<span className="block text-xs text-muted-foreground">
								Talk — your agents have the context
							</span>
						</span>
					</DropdownMenuItem>
					{!hideObjectSection && (
						<>
							<DropdownMenuSeparator />
							<div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
								Create an object
							</div>
							{OBJECT_TYPE_ITEMS.map((item) => (
								<DropdownMenuItem
									key={item.subtype}
									onSelect={() => setCreateConfig({ type: 'object', subtype: item.subtype })}
								>
									<span className={`h-2.5 w-2.5 shrink-0 rounded-[3px] ${item.swatchClassName}`} />
									New {item.label.toLowerCase()}
								</DropdownMenuItem>
							))}
						</>
					)}
					<DropdownMenuSeparator />
					<DropdownMenuItem onSelect={() => setCreateConfig({ type: 'loop' })}>
						<RefreshCw size={14} className="text-muted-foreground" />
						New loop
					</DropdownMenuItem>
					<DropdownMenuItem onSelect={() => setCreateConfig({ type: 'agent' })}>
						<Bot size={14} className="text-muted-foreground" />
						New agent
					</DropdownMenuItem>
					<DropdownMenuSeparator />
					<DropdownMenuItem onSelect={() => setPaletteOpen(true)}>
						<Search size={14} className="text-muted-foreground" />
						Find a past conversation
						<DropdownMenuShortcut>⌘K</DropdownMenuShortcut>
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
			<CreatePicker
				open={createConfig !== null}
				onOpenChange={(next) => {
					if (!next) setCreateConfig(null)
				}}
				defaultType={createConfig?.type}
				defaultObjectSubtype={createConfig?.subtype}
			/>
		</>
	)
}
