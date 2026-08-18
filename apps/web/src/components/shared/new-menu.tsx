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
	// v2 splits the control: the label half runs the screen's most likely create
	// action, the caret half opens the full menu (mockup lines 262–265). The
	// kind is the caller's only say — the action and its tooltip are resolved
	// here so the copy lives with the menu it mirrors. Omit to keep the whole
	// button as the menu trigger.
	primaryKind?: PrimaryKind
}

export type PrimaryKind = 'chat' | 'object' | 'loop' | 'agent'

// The label always reads "New", so the tooltip is the only place the contextual
// behaviour is discoverable — it must name the outcome, not repeat the label.
const PRIMARY_TITLE: Record<PrimaryKind, string> = {
	chat: 'New chat — your agents already have the context',
	object: 'New insight — capture what you noticed',
	loop: 'New loop — describe it in a sentence',
	agent: 'New agent — describe what it should own',
}

// The single "+ New" control used everywhere (global header, For You page) so
// the trigger and dropdown contents can never drift apart between pages.
export function NewMenu({ onNewChat, hideObjectSection, primaryKind }: NewMenuProps) {
	const [createConfig, setCreateConfig] = useState<CreateConfig | null>(null)
	const { setOpen: setPaletteOpen } = useCommandPalette()

	// Object-detail hides the object section, so its primary must not be the
	// object picker either — fall back to chat rather than opening a surface the
	// menu itself deliberately withholds.
	const kind: PrimaryKind | undefined =
		primaryKind === 'object' && hideObjectSection ? 'chat' : primaryKind

	const runPrimary = () => {
		if (kind === 'chat') return onNewChat()
		if (kind === 'object') return setCreateConfig({ type: 'object', subtype: 'insight' })
		if (kind === 'loop') return setCreateConfig({ type: 'loop' })
		if (kind === 'agent') return setCreateConfig({ type: 'agent' })
	}

	return (
		<>
			<div className="inline-flex h-[30px] shrink-0 items-stretch">
				{kind && (
					<Button
						size="sm"
						onClick={runPrimary}
						title={PRIMARY_TITLE[kind]}
						aria-label={PRIMARY_TITLE[kind]}
						className="h-[30px] gap-1.5 rounded-lg rounded-r-none px-2.5 text-xs font-semibold"
					>
						<Plus aria-hidden className="size-[14px]" />
						<span className="hidden sm:inline">New</span>
					</Button>
				)}
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<Button
							size="sm"
							aria-label={kind ? 'More ways to start' : 'New'}
							title={kind ? 'More ways to start' : undefined}
							className={
								kind
									? 'h-[30px] w-6 rounded-lg rounded-l-none border-l border-l-muted-foreground px-0'
									: 'h-[30px] gap-1.5 rounded-lg px-3 text-[11.5px] font-semibold'
							}
						>
							{!kind && <Plus aria-hidden className="size-[13px]" />}
							{!kind && <span className="hidden sm:inline">New</span>}
							<ChevronDown aria-hidden className="size-3 opacity-70" />
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
								<div className="eyebrow px-2 py-1">Create an object</div>
								{OBJECT_TYPE_ITEMS.map((item) => (
									<DropdownMenuItem
										key={item.subtype}
										onSelect={() => setCreateConfig({ type: 'object', subtype: item.subtype })}
									>
										<span className={`h-2.5 w-2.5 shrink-0 rounded-sm ${item.swatchClassName}`} />
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
			</div>
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
