import { ImportDialog } from '@/components/imports/import-dialog'
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
import { useAvailableObjectTypes } from '@/hooks/use-available-object-types'
import { useImportToast } from '@/hooks/use-imports'
import { cn } from '@/lib/cn'
import { useCommandPalette } from '@/lib/command-palette-context'
import { defaultTypeColor, objectTypeDescriptions, typeColors } from '@/lib/constants'
import { useWorkspace } from '@/lib/workspace-context'
import { Bot, ChevronDown, MessageSquare, Plus, RefreshCw, Search, Upload } from 'lucide-react'
import { useState } from 'react'

interface CreateConfig {
	type: CreatableType
	subtype?: string
}

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

// The visible label always reads "New", so the accessible name has to carry the
// contextual behaviour — E2E specs target the primary half by these names.
const PRIMARY_LABEL: Record<PrimaryKind, string> = {
	chat: 'New chat',
	object: 'New object',
	loop: 'New loop',
	agent: 'New agent',
}

// The tooltip is where the outcome gets spelled out — it must name what the
// action produces, not repeat the label.
const PRIMARY_TITLE: Record<PrimaryKind, string> = {
	chat: 'New chat — your agents already have the context',
	object: 'New insight — capture what you noticed',
	loop: 'New loop — describe it in a sentence',
	agent: 'New agent — describe what it should own',
}

function ImportFlow({ onOpenChange }: { onOpenChange: (open: boolean) => void }) {
	const { workspaceId } = useWorkspace()
	const { startTracking } = useImportToast(workspaceId)
	return <ImportDialog open onOpenChange={onOpenChange} onImportStarted={startTracking} />
}

// The single "+ New" control used everywhere (global header, For You page) so
// the trigger and dropdown contents can never drift apart between pages.
export function NewMenu({ onNewChat, hideObjectSection, primaryKind }: NewMenuProps) {
	const [createConfig, setCreateConfig] = useState<CreateConfig | null>(null)
	const [importOpen, setImportOpen] = useState(false)
	const { setOpen: setPaletteOpen } = useCommandPalette()
	// The menu lists the types this workspace actually defines — modules and
	// custom extensions included. Hardcoding the three built-ins hid every
	// workspace-defined type behind the create picker.
	const objectTypes = useAvailableObjectTypes()

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
						aria-label={PRIMARY_LABEL[kind]}
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
								{objectTypes.map((item) => {
									const description = objectTypeDescriptions[item.value]
									return (
										<DropdownMenuItem
											key={item.value}
											onSelect={() => setCreateConfig({ type: 'object', subtype: item.value })}
											className="items-start gap-2.5"
										>
											<span
												className={cn(
													'mt-1 h-2.5 w-2.5 shrink-0 rounded-sm',
													typeColors[item.value]?.bg ?? defaultTypeColor.bg,
												)}
											/>
											<span className="min-w-0 flex-1">
												<span className="block text-sm">New {item.label.toLowerCase()}</span>
												{description && (
													<span className="block truncate text-xs text-muted-foreground">
														{description}
													</span>
												)}
											</span>
										</DropdownMenuItem>
									)
								})}
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
						{/* Import lives in the New menu, not a page toolbar (mockup 245–247):
						    bringing a CSV in is a way of starting something, and it is not
						    specific to whichever list happens to be on screen. */}
						<DropdownMenuItem onSelect={() => setImportOpen(true)}>
							<Upload size={14} className="text-muted-foreground" />
							<span className="min-w-0 flex-1">
								<span className="block text-sm">Import</span>
								<span className="block truncate text-xs text-muted-foreground">
									Bring files, docs, or a CSV into the workspace
								</span>
							</span>
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			</div>
			{/* Mounted only while open: it owns the import toast subscription, which
			    needs a QueryClient and a workspace. Keeping that behind the open flag
			    means the New button itself carries no data dependency, so every
			    surface that renders it stays cheap. */}
			{importOpen && <ImportFlow onOpenChange={setImportOpen} />}
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
