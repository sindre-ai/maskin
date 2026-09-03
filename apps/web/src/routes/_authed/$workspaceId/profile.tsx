import { PageHeader } from '@/components/layout/page-header'
import { ProfileView } from '@/components/profile/profile-view'
import { EmptyState } from '@/components/shared/empty-state'
import { RouteError } from '@/components/shared/route-error'
import { getStoredActor } from '@/lib/auth'
import { useWorkspace } from '@/lib/workspace-context'
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/_authed/$workspaceId/profile')({
	component: ProfilePage,
	errorComponent: ({ error }) => <RouteError error={error} />,
})

function ProfilePage() {
	const { workspace, workspaceId } = useWorkspace()
	const actor = getStoredActor()

	return (
		<div className="flex flex-col gap-4">
			<PageHeader title="Profile" subtitle={actor?.name} />
			{actor ? (
				<ProfileView
					actorId={actor.id}
					workspaceId={workspaceId}
					workspaceName={workspace?.name ?? ''}
				/>
			) : (
				<EmptyState title="Not signed in" description="Sign in again to see your profile." />
			)}
		</div>
	)
}
