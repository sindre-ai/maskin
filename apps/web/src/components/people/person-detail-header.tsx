import { isCurrentActorAdmin } from '@/components/agents/agent-avatar-upload'
import { AvatarUploadButton, EditableField } from '@/components/agents/agent-detail-header'
import { StatusPill } from '@/components/integrations/drive/status-pill'
import { ActorAvatar } from '@/components/shared/actor-avatar'
import { useUpdateActor } from '@/hooks/use-actors'
import { useWorkspaceMembers } from '@/hooks/use-workspaces'
import type { ActorResponse, MemberResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import { useWorkspace } from '@/lib/workspace-context'
import { ACTOR_DESCRIPTION_MAX_LENGTH } from '@maskin/shared'
import { toast } from 'sonner'

const ROLE_LABELS: Record<string, string> = { owner: 'Owner', admin: 'Admin', member: 'Member' }

/** Picture, name, role, email and the click-to-edit focus line: the agent page's header, for a person. */
export function PersonDetailHeader({
	person,
	member,
	isSelf,
}: {
	person: ActorResponse
	member: MemberResponse | undefined
	isSelf: boolean
}) {
	const { workspaceId } = useWorkspace()
	const updateActor = useUpdateActor(workspaceId)
	const { data: members } = useWorkspaceMembers(workspaceId)
	// The server lets a person set their own picture and a workspace admin set anyone's.
	const canChangeAvatar = isSelf || isCurrentActorAdmin(members)
	const focus = person.description?.trim() ?? ''

	return (
		<header className="flex items-start gap-4.5 px-1 leading-tight">
			<div className="relative shrink-0">
				<ActorAvatar
					name={person.name}
					type="human"
					size="xl"
					className="size-17"
					id={person.id}
					imageUrl={person.avatar_url ?? undefined}
				/>
				{canChangeAvatar && <AvatarUploadButton actorId={person.id} name={person.name} />}
			</div>
			<div className="flex min-w-0 flex-1 flex-col gap-2.5">
				<div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
					<h1 className="min-w-0 max-w-full truncate text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
						{person.name}
					</h1>
					{isSelf && (
						<span className="rounded-full border border-border px-2.5 py-0.5 text-xs font-semibold text-muted-foreground">
							You
						</span>
					)}
					{member && (
						<StatusPill soft tone="ok">
							{ROLE_LABELS[member.role] ?? member.role}
						</StatusPill>
					)}
				</div>
				{person.email && (
					<p className="truncate text-[15px] text-muted-foreground">{person.email}</p>
				)}
				<p className="flex items-baseline gap-1.5 text-[15px] text-muted-foreground">
					<span className="shrink-0">Focus</span>
					<EditableField
						value={person.description ?? ''}
						displayValue={focus || 'No focus set yet'}
						label="Focus"
						maxLength={ACTOR_DESCRIPTION_MAX_LENGTH}
						placeholder="What is this person focused on?"
						onSave={(next) =>
							updateActor.mutate(
								{ id: person.id, data: { description: next } },
								{ onError: () => toast.error(`Couldn't save focus for ${person.name}`) },
							)
						}
						fill
						className={cn(
							'w-full rounded-none border-b border-dashed border-border text-[15px]',
							focus ? 'text-foreground' : 'text-muted-foreground',
						)}
						inputClassName="text-[15px]"
					/>
				</p>
			</div>
		</header>
	)
}
