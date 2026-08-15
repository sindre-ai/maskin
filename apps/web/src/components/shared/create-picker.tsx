import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import {
	ResponsiveDialog,
	ResponsiveDialogContent,
	ResponsiveDialogDescription,
	ResponsiveDialogFooter,
	ResponsiveDialogHeader,
	ResponsiveDialogTitle,
} from '@/components/ui/responsive-dialog'
import { useCreateActor } from '@/hooks/use-actors'
import { useCreateObject } from '@/hooks/use-objects'
import { useCreateTrigger } from '@/hooks/use-triggers'
import { trackAgentCreated, trackObjectCreated, trackTriggerCreated } from '@/lib/analytics'
import { api } from '@/lib/api'
import { getStoredActor } from '@/lib/auth'
import { cn } from '@/lib/cn'
import { useWorkspace } from '@/lib/workspace-context'
import { useNavigate } from '@tanstack/react-router'
import { Bot, Layers, RefreshCw, Zap } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { toast } from 'sonner'

export type CreatableType = 'object' | 'agent' | 'trigger' | 'loop'

interface CreatePickerProps {
	open: boolean
	onOpenChange: (open: boolean) => void
	/** Skips the type step and locks it. Header opens with no defaultType;
	 *  list pages pass their own. */
	defaultType?: CreatableType
	/** When defaultType='object', seeds the object subtype from the active
	 *  type tab (e.g. 'bet', 'insight'). Falls back to 'task' when omitted. */
	defaultObjectSubtype?: string
}

interface TypeOption {
	value: CreatableType
	label: string
	icon: typeof Layers
}

const TYPE_OPTIONS: TypeOption[] = [
	{ value: 'object', label: 'Object', icon: Layers },
	{ value: 'agent', label: 'Agent', icon: Bot },
	{ value: 'trigger', label: 'Trigger', icon: Zap },
	{ value: 'loop', label: 'Loop', icon: RefreshCw },
]

const TYPE_TILE_STYLES = {
	base: 'flex cursor-pointer flex-col items-center gap-2 rounded-md border p-3 text-sm transition-colors',
	selected: 'border-primary bg-muted text-foreground',
	unselected: 'border-border text-muted-foreground hover:text-foreground',
} as const

const FALLBACK_OBJECT_SUBTYPE = 'task'

// One picker, three callers (header, page `+ New`, `C` shortcut). Sealed
// contract per T1: no onSubmit callback — the picker owns create + analytics
// + navigation so all three creation paths share one code path.
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

	const titleFieldId = useId()
	const typeGroupId = useId()

	const [type, setType] = useState<CreatableType>(defaultType ?? 'object')
	const [title, setTitle] = useState('')
	const [submitting, setSubmitting] = useState(false)
	const titleInputRef = useRef<HTMLInputElement>(null)

	// Reset state on each open so a cancelled draft doesn't leak into the next
	// creation. Also re-seeds the type from defaultType, which can change when
	// the caller reuses one picker instance across type tabs.
	useEffect(() => {
		if (!open) return
		setType(defaultType ?? 'object')
		setTitle('')
		setSubmitting(false)
	}, [open, defaultType])

	// Autofocus the title input when the type step is skipped. Radix handles
	// focus for the radio group when it's rendered.
	useEffect(() => {
		if (!open || !defaultType) return
		const id = requestAnimationFrame(() => titleInputRef.current?.focus())
		return () => cancelAnimationFrame(id)
	}, [open, defaultType])

	const objectSubtype = defaultObjectSubtype?.trim() || FALLBACK_OBJECT_SUBTYPE

	function pickDefaultStatus(subtype: string): string {
		const statusMap = (workspace.settings as { statuses?: Record<string, string[]> } | undefined)
			?.statuses
		const first = statusMap?.[subtype]?.[0]
		return first && first.length > 0 ? first : 'todo'
	}

	async function handleSubmit(event: React.FormEvent) {
		event.preventDefault()
		const trimmed = title.trim()
		if (!trimmed || submitting) return
		setSubmitting(true)
		try {
			if (type === 'object') {
				const created = await createObject.mutateAsync({
					type: objectSubtype,
					title: trimmed,
					status: pickDefaultStatus(objectSubtype),
				})
				trackObjectCreated({
					entity_id: created.id,
					entity_type: 'object',
					object_subtype: created.type,
				})
				onOpenChange(false)
				navigate({
					to: '/$workspaceId/objects/$objectId',
					params: { workspaceId, objectId: created.id },
				})
				return
			}
			if (type === 'loop') {
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
			if (type === 'agent') {
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

	const dialogTitle = defaultType
		? `New ${TYPE_OPTIONS.find((o) => o.value === defaultType)?.label.toLowerCase() ?? 'item'}`
		: 'Create new'

	return (
		<ResponsiveDialog open={open} onOpenChange={onOpenChange}>
			<ResponsiveDialogContent className="sm:max-w-md">
				<form onSubmit={handleSubmit} className="flex flex-col gap-4">
					<ResponsiveDialogHeader>
						<ResponsiveDialogTitle>{dialogTitle}</ResponsiveDialogTitle>
						<ResponsiveDialogDescription>
							{defaultType ? 'Give it a title to get started.' : 'Pick a type and give it a title.'}
						</ResponsiveDialogDescription>
					</ResponsiveDialogHeader>

					{!defaultType && (
						<RadioGroup
							value={type}
							onValueChange={(v) => setType(v as CreatableType)}
							className="grid grid-cols-3 gap-2"
							aria-label="Type"
						>
							{TYPE_OPTIONS.map((option) => {
								const Icon = option.icon
								const selected = type === option.value
								const itemId = `${typeGroupId}-${option.value}`
								return (
									<label
										key={option.value}
										htmlFor={itemId}
										className={cn(
											TYPE_TILE_STYLES.base,
											selected ? TYPE_TILE_STYLES.selected : TYPE_TILE_STYLES.unselected,
										)}
									>
										<RadioGroupItem id={itemId} value={option.value} className="sr-only" />
										<Icon size={20} />
										{option.label}
									</label>
								)
							})}
						</RadioGroup>
					)}

					<div className="flex flex-col gap-1">
						<label htmlFor={titleFieldId} className="text-xs font-medium text-muted-foreground">
							Title
						</label>
						<Input
							id={titleFieldId}
							ref={titleInputRef}
							value={title}
							onChange={(e) => setTitle(e.target.value)}
							placeholder="What are you creating?"
							autoComplete="off"
							required
							disabled={submitting}
						/>
					</div>

					<ResponsiveDialogFooter>
						<Button
							type="button"
							variant="ghost"
							onClick={() => onOpenChange(false)}
							disabled={submitting}
						>
							Cancel
						</Button>
						<Button type="submit" disabled={submitting || title.trim().length === 0}>
							{submitting ? 'Creating…' : 'Create'}
						</Button>
					</ResponsiveDialogFooter>
				</form>
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
