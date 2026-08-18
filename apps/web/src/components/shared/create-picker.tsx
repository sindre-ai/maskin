import { ActorAvatar } from '@/components/shared/actor-avatar'
import { TypeBadge } from '@/components/shared/type-badge'
import { Button } from '@/components/ui/button'
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import {
	ResponsiveDialog,
	ResponsiveDialogContent,
	ResponsiveDialogDescription,
	ResponsiveDialogTitle,
} from '@/components/ui/responsive-dialog'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@/components/ui/select'
import { useActors, useCreateActor, useDefaultChatAgent } from '@/hooks/use-actors'
import { useAvailableObjectTypes } from '@/hooks/use-available-object-types'
import { useCreateConversation } from '@/hooks/use-conversations'
import { useCreateObject } from '@/hooks/use-objects'
import { useCreateTrigger } from '@/hooks/use-triggers'
import { trackAgentCreated, trackObjectCreated, trackTriggerCreated } from '@/lib/analytics'
import { api } from '@/lib/api'
import { getStoredActor } from '@/lib/auth'
import { cn } from '@/lib/cn'
import { TYPE_LABELS, getTypeColor } from '@/lib/constants'
import { useWorkspace } from '@/lib/workspace-context'
import { useNavigate } from '@tanstack/react-router'
import {
	ArrowRight,
	ArrowUp,
	Bot,
	Maximize2,
	MessageSquare,
	Minimize2,
	Plus,
	RefreshCw,
	X,
	Zap,
} from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'

export type CreatableType = 'object' | 'agent' | 'trigger' | 'loop'

interface CreatePickerProps {
	open: boolean
	onOpenChange: (open: boolean) => void
	/** Seeds the composer's type. Header opens with no defaultType; list pages
	 *  pass their own. The type is always clearable from the pill. */
	defaultType?: CreatableType
	/** When defaultType='object', seeds the object subtype from the active
	 *  type tab (e.g. 'bet', 'insight'). Omit to let the operator pick. */
	defaultObjectSubtype?: string
}

/** Entities the workspace creates directly from a name — no structuring
 *  involved, so they never route through an agent. `object` is deliberately
 *  absent: an object is created by an agent from a description (see
 *  `handleSubmit`), not by this form. */
type EntityKind = Exclude<CreatableType, 'object'>

const ENTITY_KINDS: { value: EntityKind; label: string; description: string; icon: typeof Bot }[] =
	[
		{
			value: 'loop',
			label: 'Loop',
			description: 'A new outcome for agents to own',
			icon: RefreshCw,
		},
		{ value: 'agent', label: 'Agent', description: 'A new teammate with one job to do', icon: Bot },
		{
			value: 'trigger',
			label: 'Trigger',
			description: 'A schedule or event that starts work',
			icon: Zap,
		},
	]

// Type copy for the three built-in object types (mockup NEWKINDS). Module and
// custom types deliberately have no entry — we describe a type only when the
// product actually defines it, and fall back to the bare label otherwise.
const OBJECT_TYPE_DESCRIPTION: Record<string, string> = {
	insight: 'A structured finding, linked to its evidence',
	bet: 'A hypothesis to run across cycles',
	task: 'A piece of work to track through to done',
}

const OBJECT_TYPE_PLACEHOLDER: Record<string, string> = {
	insight: 'State the finding in one line…',
	bet: 'What outcome are you betting on?',
	task: 'Name the task, then say what needs to happen…',
}

// The 5px spine is a text-free indicator, so it needs a saturated fill that
// survives both themes — the `-text` tokens are (#4338ca / #a5b4fc etc.), the
// `-bg` tokens are pale tints. Never `bg-accent` here: see
// `.claude/rules/known-pitfalls.md`.
const SPINE_CLASS: Record<string, string> = {
	insight: 'bg-type-insight-text',
	bet: 'bg-type-bet-text',
	task: 'bg-type-task-text',
}

const ENTITY_PLACEHOLDER = 'What are you creating?'

interface AgentOption {
	id: string
	name: string
}

function article(word: string): string {
	return /^[aeiou]/i.test(word) ? 'an' : 'a'
}

function titleCase(value: string): string {
	return value.charAt(0).toUpperCase() + value.slice(1)
}

export function CreatePicker({
	open,
	onOpenChange,
	defaultType,
	defaultObjectSubtype,
}: CreatePickerProps) {
	const { workspaceId, workspace } = useWorkspace()
	const navigate = useNavigate()
	const createObject = useCreateObject(workspaceId)
	const createActor = useCreateActor(workspaceId)
	const createTrigger = useCreateTrigger(workspaceId)
	const createConversation = useCreateConversation(workspaceId)
	const objectTypes = useAvailableObjectTypes()
	const defaultAgent = useDefaultChatAgent()
	const { data: actors } = useActors(workspaceId, { enabled: open })

	const typeGroupId = useId()
	const commandListId = useId()

	// `entityKind` is set only for loop/agent/trigger; `objectType` only for an
	// object subtype. Both null = the conversation branch.
	const [entityKind, setEntityKind] = useState<EntityKind | null>(null)
	const [objectType, setObjectType] = useState<string | null>(null)
	const [text, setText] = useState('')
	const [agentId, setAgentId] = useState<string | null>(null)
	const [full, setFull] = useState(false)
	const [commandIndex, setCommandIndex] = useState(0)
	const [submitting, setSubmitting] = useState(false)
	const inputRef = useRef<HTMLInputElement>(null)

	// Reset on each open so a cancelled draft doesn't leak into the next one.
	// Also re-seeds from defaultType, which changes when a caller reuses one
	// picker instance across type tabs.
	useEffect(() => {
		if (!open) return
		setEntityKind(defaultType && defaultType !== 'object' ? defaultType : null)
		setObjectType(defaultType === 'object' ? defaultObjectSubtype?.trim() || null : null)
		setText('')
		setAgentId(null)
		setFull(false)
		setCommandIndex(0)
		setSubmitting(false)
	}, [open, defaultType, defaultObjectSubtype])

	useEffect(() => {
		if (!open) return
		const id = requestAnimationFrame(() => inputRef.current?.focus())
		return () => cancelAnimationFrame(id)
	}, [open])

	const displayNames = (
		workspace.settings as { display_names?: Record<string, string> } | undefined
	)?.display_names
	const fieldDefinitions = (
		workspace.settings as
			| { field_definitions?: Record<string, { name: string; type?: string }[]> }
			| undefined
	)?.field_definitions

	function objectTypeLabel(type: string): string {
		return displayNames?.[type] ?? TYPE_LABELS[type] ?? titleCase(type)
	}

	const agentOptions: AgentOption[] = useMemo(
		() =>
			(actors ?? [])
				.filter((a) => a.type === 'agent' && !a.isSystem)
				.map((a) => ({ id: a.id, name: a.name })),
		[actors],
	)

	// The routing target has to be a real agent — this app has no auto-router,
	// so the picker never claims one. Default to the workspace's configured chat
	// agent when it exists, otherwise the first agent in the workspace.
	const routedAgent: AgentOption | null = useMemo(() => {
		if (agentId) return agentOptions.find((a) => a.id === agentId) ?? null
		if (defaultAgent && agentOptions.some((a) => a.id === defaultAgent.id)) return defaultAgent
		return agentOptions[0] ?? null
	}, [agentId, agentOptions, defaultAgent])

	const trimmed = text.trim()
	const commandOpen = entityKind === null && objectType === null && text.startsWith('/')
	const commandQuery = commandOpen ? text.slice(1).trim().toLowerCase() : ''

	interface CommandRow {
		key: string
		group: 'OBJECTS' | 'WORKSPACE'
		label: string
		description: string
		select: () => void
	}

	const allCommandRows: CommandRow[] = [
		...objectTypes.map((t) => ({
			key: `object:${t.value}`,
			group: 'OBJECTS' as const,
			label: objectTypeLabel(t.value),
			description: OBJECT_TYPE_DESCRIPTION[t.value] ?? `Create ${article(t.value)} ${t.value}`,
			select: () => selectObjectType(t.value),
		})),
		...ENTITY_KINDS.map((k) => ({
			key: `entity:${k.value}`,
			group: 'WORKSPACE' as const,
			label: k.label,
			description: k.description,
			select: () => selectEntityKind(k.value),
		})),
	]
	const commandRows = commandQuery
		? allCommandRows.filter(
				(r) =>
					r.label.toLowerCase().includes(commandQuery) ||
					r.description.toLowerCase().includes(commandQuery),
			)
		: allCommandRows

	const activeCommand = commandRows[Math.min(commandIndex, commandRows.length - 1)] ?? null

	function selectObjectType(type: string) {
		setEntityKind(null)
		setObjectType(type)
		setText('')
		setCommandIndex(0)
		requestAnimationFrame(() => inputRef.current?.focus())
	}

	function selectEntityKind(kind: EntityKind) {
		setObjectType(null)
		setEntityKind(kind)
		setText('')
		setCommandIndex(0)
		requestAnimationFrame(() => inputRef.current?.focus())
	}

	function clearType() {
		setEntityKind(null)
		setObjectType(null)
		setText('')
		setCommandIndex(0)
		requestAnimationFrame(() => inputRef.current?.focus())
	}

	function pickDefaultStatus(subtype: string): string {
		const statusMap = (workspace.settings as { statuses?: Record<string, string[]> } | undefined)
			?.statuses
		const first = statusMap?.[subtype]?.[0]
		return first && first.length > 0 ? first : 'todo'
	}

	const activeEntity = entityKind
		? (ENTITY_KINDS.find((k) => k.value === entityKind) ?? null)
		: null
	const activeLabel = objectType ? objectTypeLabel(objectType) : (activeEntity?.label ?? '')

	const contextLabel = activeLabel
		? `Creating ${article(activeLabel)} ${activeLabel.toLowerCase()}`
		: 'Create something — or type freely and it becomes a chat'

	const spineClass = objectType
		? (SPINE_CLASS[objectType] ?? 'bg-border-strong')
		: entityKind
			? 'bg-border-strong'
			: trimmed
				? 'bg-primary'
				: 'bg-border'

	const placeholder = objectType
		? (OBJECT_TYPE_PLACEHOLDER[objectType] ?? `Describe the ${activeLabel.toLowerCase()}…`)
		: entityKind
			? ENTITY_PLACEHOLDER
			: 'Describe it — or press / to pick a type'

	// Object types are structured by an agent, so they need a routing target.
	// Entity kinds are created directly from the name they're given.
	const needsAgent = entityKind === null
	const messageContent = objectType
		? `Create ${article(activeLabel)} ${activeLabel.toLowerCase()} from this:\n\n${trimmed}`
		: trimmed

	const sendLabel = entityKind
		? `Create ${activeLabel.toLowerCase()}`
		: routedAgent
			? `Send to ${routedAgent.name}`
			: 'Send'

	const canSubmit =
		trimmed.length > 0 && !submitting && !commandOpen && (!needsAgent || routedAgent !== null)

	async function handleSubmit(event: React.FormEvent) {
		event.preventDefault()
		if (!canSubmit) return
		setSubmitting(true)
		try {
			// Object types and free text both become a conversation with the
			// routed agent. The agent is the only thing in this system that can
			// structure prose into a typed object — it holds `get_workspace_schema`
			// and `create_objects`, so it knows this workspace's real types,
			// statuses and fields. Nothing here guesses at them.
			if (entityKind === null) {
				if (!routedAgent) return
				const conversation = await createConversation.mutateAsync({
					title: trimmed.slice(0, 60),
					participant_actor_ids: [routedAgent.id],
					initial_message: messageContent,
				})
				onOpenChange(false)
				navigate({
					to: '/$workspaceId/chats/$conversationId',
					params: { workspaceId, conversationId: conversation.id },
				})
				return
			}
			if (entityKind === 'loop') {
				// A loop is an object row with type='loop' (see apps/dev/src/routes/loops.ts) —
				// not a trigger. Status uses the loop lifecycle enum (LOOP_STATUSES), not the
				// workspace's per-object-type status list, so it can't go through
				// pickDefaultStatus. entry/close conditions and trigger wiring are configured
				// later from the loop detail page; the picker only seeds a name.
				const created = await createObject.mutateAsync({
					type: 'loop',
					title: trimmed,
					status: 'running',
				})
				trackObjectCreated({
					entity_id: created.id,
					entity_type: 'object',
					object_subtype: 'loop',
				})
				onOpenChange(false)
				navigate({
					to: '/$workspaceId/loops/$loopId',
					params: { workspaceId, loopId: created.id },
				})
				return
			}
			if (entityKind === 'agent') {
				const created = await createActor.mutateAsync({ type: 'agent', name: trimmed })
				try {
					await api.workspaces.members.add(workspaceId, {
						actor_id: created.id,
						role: 'member',
					})
				} catch {
					// Membership may already exist — the detail page also tries this.
				}
				trackAgentCreated({ entity_id: created.id, entity_type: 'agent' })
				onOpenChange(false)
				navigate({
					to: '/$workspaceId/agents/$agentId',
					params: { workspaceId, agentId: created.id },
				})
				return
			}
			// Trigger. The picker only captures a name — the schema requires more.
			// We create the trigger disabled with placeholder config; the detail
			// page's TriggerForm captures the remaining fields before the user
			// enables it, so it never fires in the placeholder state.
			// `action_prompt` must be non-empty (Zod `.min(1)`) — reuse the name so
			// the trigger has a meaningful starting value the user can rewrite.
			const currentActorId = getStoredActor()?.id
			if (!currentActorId) {
				toast.error('Sign in required to create a trigger')
				return
			}
			const created = await createTrigger.mutateAsync({
				name: trimmed,
				type: 'cron',
				config: { expression: '0 0 * * *' },
				action_prompt: trimmed,
				target_actor_id: currentActorId,
				enabled: false,
			})
			trackTriggerCreated({ entity_id: created.id, entity_type: 'trigger' })
			onOpenChange(false)
			navigate({
				to: '/$workspaceId/triggers/$triggerId',
				params: { workspaceId, triggerId: created.id },
			})
		} catch (err) {
			toast.error(err instanceof Error ? err.message : 'Failed to create')
		} finally {
			setSubmitting(false)
		}
	}

	function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
		if (commandOpen) {
			if (event.key === 'ArrowDown') {
				event.preventDefault()
				setCommandIndex((i) => Math.min(commandRows.length - 1, i + 1))
			} else if (event.key === 'ArrowUp') {
				event.preventDefault()
				setCommandIndex((i) => Math.max(0, i - 1))
			} else if (event.key === 'Enter') {
				event.preventDefault()
				activeCommand?.select()
			}
			return
		}
		if (event.key === 'Backspace' && text.length === 0 && (objectType || entityKind)) {
			event.preventDefault()
			clearType()
		}
	}

	function openChats() {
		onOpenChange(false)
		navigate({ to: '/$workspaceId/chats/new', params: { workspaceId } })
	}

	const showGreet = !objectType && !entityKind && !trimmed && !commandOpen
	const showConversation = !objectType && !entityKind && trimmed.length > 0 && !commandOpen
	const objectFields = objectType ? (fieldDefinitions?.[objectType] ?? []) : []

	const routingBlock = needsAgent ? (
		<div className="overflow-hidden rounded-xl border border-border">
			<div className="eyebrow border-b border-border px-4 py-2.5">Routing</div>
			{routedAgent ? (
				<div className="flex items-center gap-3 p-3">
					<ActorAvatar id={routedAgent.id} name={routedAgent.name} type="agent" size="lg" />
					<div className="flex min-w-0 flex-1 flex-col gap-1">
						<Select value={routedAgent.id} onValueChange={setAgentId}>
							<SelectTrigger className="w-full" aria-label="Agent that picks this up">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{agentOptions.map((a) => (
									<SelectItem key={a.id} value={a.id}>
										{a.name}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
						<span className="text-xs text-muted-foreground">picks this up when you send</span>
					</div>
				</div>
			) : (
				<p className="p-3 text-xs leading-relaxed text-muted-foreground">
					This workspace has no agent to pick it up yet. Create an agent first — press{' '}
					<kbd className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">/</kbd> and choose
					Agent.
				</p>
			)}
		</div>
	) : null

	return (
		<ResponsiveDialog open={open} onOpenChange={onOpenChange}>
			<ResponsiveDialogContent
				onEscapeKeyDown={(event) => {
					if (full) {
						event.preventDefault()
						setFull(false)
					}
				}}
				className={cn(
					'flex flex-row gap-0 overflow-hidden p-0 md:max-h-[86vh] md:max-w-[780px]',
					full && 'md:max-h-[95vh] md:max-w-[1120px]',
				)}
			>
				<div aria-hidden className={cn('w-[5px] shrink-0 transition-colors', spineClass)} />
				<div className="flex min-w-0 flex-1 flex-col">
					<div className="flex shrink-0 items-center gap-2.5 border-b border-border py-3 pl-4 pr-14">
						<ResponsiveDialogTitle className="flex min-w-0 items-center gap-2.5 text-sm font-semibold">
							<span className="eyebrow shrink-0 tracking-[0.16em] text-foreground">New</span>
							<span aria-hidden className="shrink-0 text-border-strong">
								/
							</span>
							<span className="min-w-0 truncate text-xs font-medium text-muted-foreground">
								{contextLabel}
							</span>
						</ResponsiveDialogTitle>
						<Button
							type="button"
							variant="ghost"
							size="icon"
							className="ml-auto hidden shrink-0 md:inline-flex"
							aria-label={full ? 'Exit full page' : 'Open in full page'}
							onClick={() => setFull((v) => !v)}
						>
							{full ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
						</Button>
					</div>

					<ResponsiveDialogDescription className="sr-only">
						Pick a type and describe what you want, or type freely to start a chat.
					</ResponsiveDialogDescription>

					<div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-4">
						{showGreet && (
							<>
								<Button
									type="button"
									variant="outline"
									onClick={openChats}
									className="h-auto w-full justify-start gap-3 whitespace-normal rounded-xl px-3.5 py-3 text-left"
								>
									<span className="grid size-[30px] shrink-0 place-items-center rounded-lg bg-foreground text-background">
										<MessageSquare size={15} aria-hidden />
									</span>
									<span className="min-w-0 flex-1">
										<span className="block text-[13px] font-bold">
											Just want to talk? Open a chat
										</span>
										<span className="mt-0.5 block text-xs font-normal leading-relaxed text-muted-foreground">
											Conversations live in Chats — searchable, resumable, already grounded in your
											work
										</span>
									</span>
									<ArrowRight size={14} className="shrink-0 text-muted-foreground" aria-hidden />
								</Button>

								<div className="mt-3 flex items-center gap-2.5">
									<span className="eyebrow shrink-0">Create</span>
									<span className="shrink-0 text-xs text-muted-foreground">
										— pick a type, then describe it; an agent structures it
									</span>
									<div aria-hidden className="h-px flex-1 bg-border" />
								</div>
								<RadioGroup
									value={objectType ?? ''}
									onValueChange={selectObjectType}
									className="flex flex-wrap gap-2"
									aria-label="Type"
								>
									{objectTypes.map((t) => {
										const itemId = `${typeGroupId}-${t.value}`
										return (
											<label
												key={t.value}
												htmlFor={itemId}
												className="flex h-[38px] cursor-pointer items-center gap-2 rounded-lg border border-border px-4 text-[13px] font-semibold text-foreground transition-colors hover:border-border-strong hover:bg-muted"
											>
												<RadioGroupItem id={itemId} value={t.value} className="sr-only" />
												<span
													aria-hidden
													className={cn('size-2.5 shrink-0 rounded-sm', getTypeColor(t.value).bg)}
												/>
												{objectTypeLabel(t.value)}
											</label>
										)
									})}
								</RadioGroup>
							</>
						)}

						{objectType && (
							<>
								<div className="flex items-center gap-3">
									<TypeBadge type={objectType} variant="tile" size="lg" />
									<div className="min-w-0">
										<div className="text-sm font-bold">New {activeLabel.toLowerCase()}</div>
										{OBJECT_TYPE_DESCRIPTION[objectType] && (
											<div className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
												{OBJECT_TYPE_DESCRIPTION[objectType]}
											</div>
										)}
									</div>
								</div>
								{trimmed.length > 0 && (
									<div className="flex flex-col items-end gap-1">
										<div className="max-w-[88%] whitespace-pre-wrap rounded-[15px] rounded-br-[4px] bg-foreground px-4 py-2.5 text-sm leading-relaxed text-background">
											{messageContent}
										</div>
										<span className="text-[10.5px] text-muted-foreground">
											exactly what gets sent
										</span>
									</div>
								)}
								{objectFields.length > 0 && (
									<div className="overflow-hidden rounded-xl border border-border">
										<div className="flex items-center justify-between border-b border-border px-4 py-2.5">
											<span className="eyebrow">Properties</span>
											<span className="text-[10.5px] text-muted-foreground">
												fields this workspace defines
											</span>
										</div>
										{objectFields.map((field) => (
											<div
												key={field.name}
												className="flex items-center gap-3 border-t border-border px-4 py-2.5 first:border-t-0"
											>
												<span className="w-[118px] shrink-0 text-xs font-semibold">
													{field.name}
												</span>
												<span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
													{field.type ?? 'text'}
												</span>
											</div>
										))}
									</div>
								)}
								{routingBlock}
								<p className="px-0.5 text-xs leading-relaxed text-muted-foreground">
									Sending asks {routedAgent?.name ?? 'an agent'} to create the{' '}
									{activeLabel.toLowerCase()} from what you wrote. It reads this workspace's own
									types, statuses and fields first. You'll land in the chat and can steer it from
									there.
								</p>
							</>
						)}

						{activeEntity && (
							<div className="flex items-center gap-3">
								<span className="grid size-[38px] shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
									<activeEntity.icon size={18} aria-hidden />
								</span>
								<div className="min-w-0">
									<div className="text-sm font-bold">New {activeLabel.toLowerCase()}</div>
									<div className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
										{activeEntity.description}
									</div>
								</div>
							</div>
						)}

						{showConversation && (
							<>
								<div className="flex flex-col items-end gap-1">
									<div className="max-w-[88%] whitespace-pre-wrap rounded-[15px] rounded-br-[4px] bg-foreground px-4 py-2.5 text-sm leading-relaxed text-background">
										{messageContent}
									</div>
									<span className="text-[10.5px] text-muted-foreground">you</span>
								</div>
								{routingBlock}
								<p className="px-0.5 text-xs leading-relaxed text-muted-foreground">
									Sending this opens it as a chat in{' '}
									<span className="font-semibold text-foreground">Chats</span> — kept in full,
									searchable later, and it can still become an object any time. Press{' '}
									<kbd className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">/</kbd> to
									pick a type instead.
								</p>
							</>
						)}
					</div>

					<form onSubmit={handleSubmit} className="relative shrink-0 px-4 pb-4 pt-2">
						{commandOpen && commandRows.length > 0 && (
							<div
								id={commandListId}
								// biome-ignore lint/a11y/useSemanticElements: a listbox is the correct role for a combobox popup
								role="listbox"
								tabIndex={-1}
								aria-label="Pick a type"
								className="absolute inset-x-4 bottom-[calc(100%-0.5rem)] z-10 max-h-[300px] overflow-y-auto rounded-xl border border-border bg-popover p-1.5 shadow-lg"
							>
								{commandRows.map((row, index) => {
									const previous = commandRows[index - 1]
									const showHeading = !previous || previous.group !== row.group
									return (
										<div key={row.key}>
											{showHeading && <div className="eyebrow px-2.5 pb-1 pt-2">{row.group}</div>}
											<Button
												type="button"
												variant="ghost"
												id={`${commandListId}-${index}`}
												// biome-ignore lint/a11y/useSemanticElements: rendered inside a listbox
												role="option"
												aria-selected={activeCommand?.key === row.key}
												onMouseEnter={() => setCommandIndex(index)}
												onClick={row.select}
												className={cn(
													'h-auto w-full justify-start gap-2.5 whitespace-normal px-2.5 py-2 text-left',
													activeCommand?.key === row.key && 'bg-muted',
												)}
											>
												<span className="min-w-0 flex-1">
													<span className="block text-[13px] font-semibold">{row.label}</span>
													<span className="mt-0.5 block truncate text-xs font-normal text-muted-foreground">
														{row.description}
													</span>
												</span>
											</Button>
										</div>
									)
								})}
							</div>
						)}

						<div
							className={cn(
								'rounded-2xl border bg-card px-3 py-2.5 shadow-xs transition-colors',
								objectType || entityKind || trimmed ? 'border-border-strong' : 'border-border',
							)}
						>
							<div className="flex items-center gap-2.5">
								{(objectType || entityKind) && (
									<span
										className={cn(
											'inline-flex h-[26px] shrink-0 items-center gap-1.5 rounded-lg pl-2.5 pr-1 font-mono text-[10px] font-bold uppercase tracking-[0.05em]',
											objectType
												? cn(getTypeColor(objectType).bg, getTypeColor(objectType).text)
												: 'bg-muted text-muted-foreground',
										)}
									>
										{activeLabel}
										<Button
											type="button"
											variant="ghost"
											size="icon"
											aria-label={`Remove ${activeLabel.toLowerCase()} type`}
											onClick={clearType}
											className="size-4 rounded-sm text-current opacity-60 hover:bg-transparent hover:opacity-100"
										>
											<X size={11} />
										</Button>
									</span>
								)}
								<Input
									ref={inputRef}
									value={text}
									onChange={(e) => {
										setText(e.target.value)
										setCommandIndex(0)
									}}
									onKeyDown={handleKeyDown}
									placeholder={placeholder}
									aria-label="Title"
									autoComplete="off"
									role={commandOpen ? 'combobox' : undefined}
									aria-expanded={commandOpen || undefined}
									aria-controls={commandOpen ? commandListId : undefined}
									aria-activedescendant={
										commandOpen && activeCommand
											? `${commandListId}-${commandRows.indexOf(activeCommand)}`
											: undefined
									}
									disabled={submitting}
									className="h-auto border-0 bg-transparent px-0 text-[15px] shadow-none focus-visible:ring-0"
								/>
							</div>
							<div className="mt-2 flex items-center gap-2.5">
								<DropdownMenu>
									<DropdownMenuTrigger asChild>
										<Button
											type="button"
											variant="outline"
											size="icon"
											aria-label="Pick a type"
											className="size-7 shrink-0 rounded-full"
										>
											<Plus size={15} />
										</Button>
									</DropdownMenuTrigger>
									<DropdownMenuContent align="start" side="top" className="w-64">
										{objectTypes.map((t) => (
											<DropdownMenuItem key={t.value} onSelect={() => selectObjectType(t.value)}>
												<span
													aria-hidden
													className={cn('size-2.5 shrink-0 rounded-sm', getTypeColor(t.value).bg)}
												/>
												{objectTypeLabel(t.value)}
											</DropdownMenuItem>
										))}
										<DropdownMenuSeparator />
										{ENTITY_KINDS.map((k) => (
											<DropdownMenuItem key={k.value} onSelect={() => selectEntityKind(k.value)}>
												<k.icon size={14} className="text-muted-foreground" />
												{k.label}
											</DropdownMenuItem>
										))}
									</DropdownMenuContent>
								</DropdownMenu>
								<Button
									type="submit"
									size="icon"
									aria-label={sendLabel}
									title={sendLabel}
									disabled={!canSubmit}
									className="ml-auto size-7 shrink-0 rounded-full"
								>
									<ArrowUp size={15} />
								</Button>
							</div>
						</div>
					</form>
				</div>
			</ResponsiveDialogContent>
		</ResponsiveDialog>
	)
}

// Shared keydown guard for the `C` list-page shortcut. Ignores keystrokes
// arriving inside inputs, textareas, or contenteditable so it never hijacks
// typing (Linear convention).
export function isCreateShortcut(event: KeyboardEvent): boolean {
	if (event.key !== 'c' && event.key !== 'C') return false
	if (event.metaKey || event.ctrlKey || event.altKey) return false
	const target = event.target
	if (target instanceof HTMLInputElement) return false
	if (target instanceof HTMLTextAreaElement) return false
	if (target instanceof HTMLSelectElement) return false
	if (target instanceof HTMLElement) {
		if (target.isContentEditable) return false
		// Fallback for detached nodes and shadow trees where isContentEditable
		// resolves to false even when the attribute is set — matches Linear/Radix.
		const editable = target.getAttribute('contenteditable')
		if (editable === '' || editable === 'true' || editable === 'plaintext-only') {
			return false
		}
	}
	return true
}
