import { isCurrentActorAdmin } from '@/components/agents/agent-avatar-upload'
import {
	AgentStatusPill,
	type PortraitStatus,
	agentTileClass,
} from '@/components/agents/agent-portrait-card'
import { ActorAvatar } from '@/components/shared/actor-avatar'
import { ViewerTooltip } from '@/components/shared/viewer-tooltip'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { useUpdateActor, useUploadActorAvatar } from '@/hooks/use-actors'
import { useCanWrite } from '@/hooks/use-can-write'
import { useLoops } from '@/hooks/use-loops'
import { useWorkspaceMembers } from '@/hooks/use-workspaces'
import type { ActorResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import { useWorkspace } from '@/lib/workspace-context'
import { ACTOR_DESCRIPTION_MAX_LENGTH } from '@maskin/shared'
import { Link } from '@tanstack/react-router'
import { Camera } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
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
	const { workspaceId } = useWorkspace()
	const updateActor = useUpdateActor(workspaceId)
	const uploadAvatar = useUploadActorAvatar(workspaceId)
	const { data: members } = useWorkspaceMembers(workspaceId)
	const { data: loops } = useLoops(workspaceId)
	const canChangeAvatar = isCurrentActorAdmin(members)
	const avatarInputRef = useRef<HTMLInputElement>(null)
	// A loop-managed agent's identity is owned by its loop — fork to edit.
	const isManaged = !!agent.installedLoopId

	const outcome = agent.description?.trim() || 'No outcome set yet'

	// "Works in": the flows this agent runs, A to Z. A row with none is not drawn.
	const flows = useMemo(
		() =>
			(loops ?? [])
				.filter((loop) => loop.agentIds.includes(agent.id))
				.map((loop) => ({ id: loop.id, name: loop.name?.trim() || 'Untitled loop' }))
				.sort((a, b) =>
					a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }),
				),
		[loops, agent.id],
	)

	const save = (data: { name?: string; description?: string }, label: string) =>
		updateActor.mutate(
			{ id: agent.id, data },
			{ onError: () => toast.error(`Couldn't save ${label} for ${agent.name}`) },
		)

	return (
		<header className="flex items-start gap-4.5 px-1">
			<div className="relative shrink-0">
				<ActorAvatar
					name={agent.name}
					type={agent.type}
					size="xl"
					tone="strong"
					className={cn(
						'size-17 rounded-2xl text-2xl font-bold [&>img]:rounded-2xl',
						agentTileClass(portrait),
					)}
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
			<div className="flex min-w-0 flex-1 flex-col gap-3">
				<div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
					{/* Named explicitly: the heading's only child is the edit button,
					    and a control contributes its *accessible name* to the name of
					    an ancestor computed from content — so without this the page's
					    one <h1> announces "Edit agent name" instead of the agent's. */}
					<h1
						aria-label={agent.name}
						className="min-w-0 max-w-full truncate text-2xl font-bold tracking-tight text-foreground sm:text-3xl"
					>
						<EditableField
							value={agent.name}
							label="Agent name"
							readOnly={isManaged}
							onSave={(next) => {
								if (next) save({ name: next }, 'the name')
							}}
							inputClassName="text-2xl font-bold tracking-tight sm:text-3xl"
						/>
					</h1>
					<span className="text-[13px]">
						<AgentStatusPill status={portrait} pulse />
					</span>
				</div>
				<p className="flex items-baseline gap-1.5 text-[15px] text-muted-foreground">
					<span className="shrink-0 text-muted-foreground">Owns</span>
					<EditableField
						value={agent.description ?? ''}
						displayValue={outcome}
						label="Outcome"
						readOnly={isManaged}
						maxLength={ACTOR_DESCRIPTION_MAX_LENGTH}
						placeholder="What does this agent own?"
						onSave={(next) => save({ description: next }, 'the outcome')}
						fill
						className={cn(
							'w-full rounded-none border-b border-dashed border-border text-[15px]',
							agent.description?.trim() ? 'text-foreground' : 'text-muted-foreground',
						)}
						inputClassName="text-[15px]"
					/>
				</p>
				{flows.length > 0 && (
					<div className="flex flex-wrap items-center gap-2 text-[13px] text-muted-foreground">
						<span>Works in</span>
						{flows.map((flow) => (
							<Link
								key={flow.id}
								to="/$workspaceId/loops/$loopId"
								params={{ workspaceId, loopId: flow.id }}
								className="rounded-full border border-border px-3 py-0.5 text-[13px] font-bold text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
							>
								{flow.name}
							</Link>
						))}
					</div>
				)}
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
	fill = false,
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
	/** Takes the rest of the row, so a border on the button runs the full width. */
	fill?: boolean
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
		<ViewerTooltip className={fill ? 'flex min-w-0 flex-1' : 'inline-flex min-w-0 max-w-full'}>
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
