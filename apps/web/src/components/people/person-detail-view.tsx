import { PageHeader } from '@/components/layout/page-header'
import { PersonAccess } from '@/components/people/person-access'
import { PersonAgentContext } from '@/components/people/person-agent-context'
import { PersonDetailHeader } from '@/components/people/person-detail-header'
import { PersonWorksOn } from '@/components/people/person-works-on'
import { Skeleton } from '@/components/shared/loading-skeleton'
import { ViewerTooltip } from '@/components/shared/viewer-tooltip'
import { Button } from '@/components/ui/button'
import { useActor } from '@/hooks/use-actors'
import { useCanWrite } from '@/hooks/use-can-write'
import { useWorkspaceMembers } from '@/hooks/use-workspaces'
import { getStoredActor } from '@/lib/auth'
import { personMessageLink } from '@/lib/person-message-link'
import { useWorkspace } from '@/lib/workspace-context'
import { Link, Navigate, useNavigate } from '@tanstack/react-router'

/** A teammate's own page: who they are, what they drive, what agents know about them. */
export function PersonDetailView({ actorId }: { actorId: string }) {
	const { workspaceId } = useWorkspace()
	const navigate = useNavigate()
	const canWrite = useCanWrite()
	const actorQuery = useActor(actorId)
	const { data: members } = useWorkspaceMembers(workspaceId)
	const person = actorQuery.data
	const member = members?.find((m) => m.actorId === actorId)
	const isSelf = getStoredActor()?.id === actorId
	const firstName = person?.name.trim().split(/\s+/)[0] || 'them'

	const crumb = {
		parentLabel: 'Members',
		parentTo: '/$workspaceId/settings/members',
		parentParams: { workspaceId },
		label: person?.name ?? 'Member',
	}

	if (person?.type === 'agent') {
		return (
			<Navigate
				to="/$workspaceId/agents/$agentId"
				params={{ workspaceId, agentId: actorId }}
				replace
			/>
		)
	}

	if (actorQuery.isError) {
		return (
			<>
				<PageHeader crumb={crumb} />
				<div
					role="alert"
					className="flex w-full max-w-280 flex-col gap-3 rounded-xl border border-border bg-background p-5"
				>
					<h1 className="text-[17px] font-semibold text-foreground">Couldn't load this person</h1>
					<p className="text-[15px] text-muted-foreground">
						They may have left the workspace, or the connection dropped.
					</p>
					<div className="flex gap-2">
						<Button className="rounded-full font-semibold" onClick={() => actorQuery.refetch()}>
							Try again
						</Button>
						<Button variant="ghost" className="rounded-full font-semibold" asChild>
							<Link to="/$workspaceId/settings/members" params={{ workspaceId }}>
								Back to members
							</Link>
						</Button>
					</div>
				</div>
			</>
		)
	}

	if (!person) {
		return (
			<>
				<PageHeader crumb={crumb} />
				<div className="flex w-full max-w-280 flex-col gap-4" aria-busy="true">
					<div className="flex items-start gap-4.5 px-1">
						<Skeleton className="size-17 rounded-2xl" />
						<div className="flex flex-1 flex-col gap-2.5">
							<Skeleton className="h-8 w-64" />
							<Skeleton className="h-4 w-48" />
						</div>
					</div>
					<Skeleton className="h-12 w-full" />
					<Skeleton className="h-12 w-full" />
				</div>
			</>
		)
	}

	const message = (
		<ViewerTooltip>
			<Button
				size="sm"
				className="h-8 rounded-full px-4 text-[13px] font-semibold"
				disabled={!canWrite}
				onClick={() =>
					navigate(
						personMessageLink(
							workspaceId,
							{ id: person.id, name: person.name },
							'person_message_page',
						),
					)
				}
			>
				Message
			</Button>
		</ViewerTooltip>
	)

	return (
		<>
			<PageHeader crumb={crumb} actions={isSelf ? undefined : message} />
			<div className="flex w-full max-w-224 flex-col gap-6">
				<PersonDetailHeader person={person} member={member} isSelf={isSelf} />
				<PersonWorksOn person={person} />
				<PersonAgentContext person={person} firstName={firstName} />
				{member && (
					<PersonAccess member={member} name={person.name} firstName={firstName} isSelf={isSelf} />
				)}
			</div>
		</>
	)
}
