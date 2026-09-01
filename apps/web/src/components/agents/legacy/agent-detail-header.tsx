// PRE-V2 COMPONENT — governed by the `new-design` feature flag. Rendered only
// by the pre-v2 branch of the `agents/` routes when the flag is off.
// This directory dies with the flag; edit the v2 component instead.

import { AgentStatusPill, type PortraitStatus } from '@/components/agents/agent-portrait-card'
import { ActorAvatar } from '@/components/shared/actor-avatar'
import { Input } from '@/components/ui/input'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@/components/ui/select'
import { useUpdateActor } from '@/hooks/use-actors'
import type { ActorResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import { useWorkspace } from '@/lib/workspace-context'
import { ACTOR_DESCRIPTION_MAX_LENGTH } from '@maskin/shared'
import { useState } from 'react'
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
				{/* Read-only until POST /api/actors/:id/avatar exists — there is no
				    backend to accept an upload yet. */}
				<ActorAvatar
					name={agent.name}
					type={agent.type}
					size="xl"
					className="rounded-2xl"
					id={agent.id}
				/>
				<div className="flex min-w-0 flex-1 flex-col gap-1.5">
					<div className="flex flex-wrap items-center gap-2.5">
						<h1 className="min-w-0 flex-1 truncate text-xl font-semibold tracking-tight text-foreground sm:text-2xl">
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
						{/* Dot form of the single status renderer — it pulses while live
						    (mockup 2360). */}
						<span className="text-[11px]">
							<AgentStatusPill status={portrait} pulse />
						</span>
						<Select value={workspace.id} disabled>
							<SelectTrigger
								aria-label="Team"
								className="h-7 rounded-full border-dashed px-2.5 text-[11px] font-medium text-muted-foreground"
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
		<button
			type="button"
			aria-label={`Edit ${label.toLowerCase()}`}
			onClick={() => {
				setDraft(value)
				setEditing(true)
			}}
			className={cn(
				'max-w-full truncate rounded-md px-1 py-0.5 text-left transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
				className,
			)}
		>
			{displayValue ?? value}
		</button>
	)
}
