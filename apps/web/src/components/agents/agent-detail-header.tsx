import { isCurrentActorAdmin } from '@/components/agents/agent-avatar-upload'
import { AgentCallButton } from '@/components/agents/agent-call-button'
import { AgentStatusPill, type PortraitStatus } from '@/components/agents/agent-portrait-card'
import { ActorAvatar } from '@/components/shared/actor-avatar'
import { ViewerTooltip } from '@/components/shared/viewer-tooltip'
import { Input } from '@/components/ui/input'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import { useUpdateActor, useUploadActorAvatar } from '@/hooks/use-actors'
import { useCanWrite } from '@/hooks/use-can-write'
import { useWorkspaceMembers } from '@/hooks/use-workspaces'
import type { ActorResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import { useWorkspace } from '@/lib/workspace-context'
import { ACTOR_DESCRIPTION_MAX_LENGTH } from '@maskin/shared'
import { Camera } from 'lucide-react'
import { useRef, useState } from 'react'
import { toast } from 'sonner'

export function AgentDetailHeader({
	agent,
	portrait,
}: {
	agent: ActorResponse
	/** Derived once by the detail view, which also owns the run/pause action it
	 *  publishes to the nav row (mockup 2351). */
	portrait: PortraitStatus
}) {
	const { workspace, workspaceId } = useWorkspace()
	const updateActor = useUpdateActor(workspaceId)
	const uploadAvatar = useUploadActorAvatar(workspaceId)
	const { data: members } = useWorkspaceMembers(workspaceId)
	const canChangeAvatar = isCurrentActorAdmin(members)
	const avatarInputRef = useRef<HTMLInputElement>(null)
	// A loop-managed agent's identity is owned by its loop — fork to edit.
	const isManaged = !!agent.installedLoopId

	const outcome = agent.description?.trim() || 'No outcome set yet'

	const save = (data: { name?: string; description?: string }, label: string) =>
		updateActor.mutate(
			{ id: agent.id, data },
			{ onError: () => toast.error(`Couldn't save ${label} for ${agent.name}`) },
		)

	return (
		<header className="flex flex-col gap-3">
			<div className="flex flex-wrap items-center gap-3">
				<div className="relative shrink-0">
					<ActorAvatar
						name={agent.name}
						type={agent.type}
						size="xl"
						tone="strong"
						className="size-14 rounded-2xl text-[22px] font-bold [&>img]:rounded-2xl"
						id={agent.id}
						imageUrl={agent.avatar_url ?? undefined}
					/>
					{canChangeAvatar && (
						<>
							{/* Always visible, not a hover reveal: there is no hover on touch. */}
							<button
								type="button"
								onClick={() => avatarInputRef.current?.click()}
								disabled={uploadAvatar.isPending}
								aria-label={`Change profile picture for ${agent.name}`}
								className="absolute inset-0 flex items-end justify-end rounded-2xl focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed"
							>
								<span className="-mb-1 -mr-1 flex size-5 items-center justify-center rounded-full border border-border bg-background text-muted-foreground shadow-sm">
									{uploadAvatar.isPending ? <Spinner className="size-3" /> : <Camera size={12} />}
								</span>
							</button>
							<input
								ref={avatarInputRef}
								type="file"
								accept="image/png,image/jpeg"
								className="hidden"
								onChange={(e) => {
									const file = e.target.files?.[0]
									e.target.value = ''
									if (!file) return
									if (file.type !== 'image/png' && file.type !== 'image/jpeg') {
										toast.error('Only PNG or JPG images are supported.')
										return
									}
									uploadAvatar.mutate(
										{ id: agent.id, file },
										{ onError: (err) => toast.error(err.message || "Couldn't upload the picture") },
									)
								}}
							/>
						</>
					)}
				</div>
				<div className="flex min-w-0 flex-1 flex-col gap-1.5">
					<div className="flex flex-wrap items-center gap-2.5">
						{/* Named explicitly: the heading's only child is the edit button,
						    and a control contributes its *accessible name* to the name of
						    an ancestor computed from content — so without this the page's
						    one <h1> announces "Edit agent name" instead of the agent's. */}
						<h1
							aria-label={agent.name}
							className="min-w-0 flex-1 truncate text-xl font-semibold tracking-tight text-foreground sm:text-2xl"
						>
							<EditableField
								value={agent.name}
								label="Agent name"
								readOnly={isManaged}
								onSave={(next) => {
									if (next) save({ name: next }, 'the name')
								}}
								inputClassName="text-xl font-semibold tracking-tight sm:text-2xl"
							/>
						</h1>
						{/* The bare coloured word — no dot, no plate. v2 dropped both here
						    because the name already carries the eye and the identity row
						    should read as one line of text (mockup 2321). */}
						<span className="text-[11px]">
							<AgentStatusPill status={portrait} variant="bare" />
						</span>
						<Select value={workspace.id} disabled>
							<SelectTrigger
								aria-label="Team"
								className="h-[22px] gap-1.5 rounded-full border-dashed bg-muted/40 px-2.5 py-0 text-[11px] font-semibold text-muted-foreground"
							>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value={workspace.id}>{workspace.name}</SelectItem>
							</SelectContent>
						</Select>
					</div>
					<p className="flex flex-wrap items-center gap-1 text-sm text-muted-foreground">
						<span className="text-muted-foreground">Owns one outcome: </span>
						<EditableField
							value={agent.description ?? ''}
							displayValue={outcome}
							label="Outcome"
							readOnly={isManaged}
							maxLength={ACTOR_DESCRIPTION_MAX_LENGTH}
							placeholder="What does this agent own?"
							onSave={(next) => save({ description: next }, 'the outcome')}
							className={cn(
								'text-sm',
								agent.description?.trim() ? 'text-foreground' : 'text-muted-foreground',
							)}
							inputClassName="text-sm"
						/>
					</p>
				</div>
				{/* Voice call entry point. Sits right of the identity block on the same
				    row. */}
				<AgentCallButton agent={agent} />
			</div>
		</header>
	)
}

/**
 * Click-to-edit text. Reads as plain text until you click it, so the header
 * stays a header — the v2 surfaces show identity, they don't look like a form.
 */
function EditableField({
	value,
	displayValue,
	label,
	readOnly = false,
	maxLength,
	placeholder,
	onSave,
	className,
	inputClassName,
}: {
	value: string
	/** What to render when not editing, if it differs from the raw value (e.g. a
	 *  placeholder for an unset outcome). Editing always starts from `value`. */
	displayValue?: string
	label: string
	readOnly?: boolean
	maxLength?: number
	placeholder?: string
	onSave: (next: string) => void
	className?: string
	inputClassName?: string
}) {
	const [editing, setEditing] = useState(false)
	const [draft, setDraft] = useState(value)
	const canWrite = useCanWrite()

	if (readOnly) return <span className={className}>{displayValue ?? value}</span>

	const commit = () => {
		setEditing(false)
		const next = draft.trim()
		if (next !== value.trim()) onSave(next)
	}

	if (editing) {
		return (
			<Input
				// The field replaces the text the user just clicked — focus follows the click.
				autoFocus
				aria-label={label}
				value={draft}
				maxLength={maxLength}
				placeholder={placeholder}
				onChange={(e) => setDraft(e.target.value)}
				onBlur={commit}
				onKeyDown={(e) => {
					if (e.key === 'Enter') e.currentTarget.blur()
					if (e.key === 'Escape') {
						setDraft(value)
						setEditing(false)
					}
				}}
				className={cn('h-8 w-full min-w-0 px-2 py-0', inputClassName)}
			/>
		)
	}

	return (
		<ViewerTooltip className="inline-flex min-w-0 max-w-full">
			<button
				type="button"
				aria-label={`Edit ${label.toLowerCase()}`}
				disabled={!canWrite}
				onClick={() => {
					setDraft(value)
					setEditing(true)
				}}
				className={cn(
					'max-w-full truncate rounded-md px-1 py-0.5 text-left transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:hover:bg-transparent',
					className,
				)}
			>
				{displayValue ?? value}
			</button>
		</ViewerTooltip>
	)
}
