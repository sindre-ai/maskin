import { PageHeader } from '@/components/layout/page-header'
import { ProfileView } from '@/components/profile/profile-view'
import { EmptyState } from '@/components/shared/empty-state'
import { RouteError } from '@/components/shared/route-error'
import { useFeatureFlag } from '@/hooks/use-feature-flag'
import { getStoredActor } from '@/lib/auth'
import { useWorkspace } from '@/lib/workspace-context'
import { Navigate, createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/_authed/$workspaceId/profile')({
	component: ProfilePage,
	errorComponent: ({ error }) => <RouteError error={error} />,
})

function ProfilePageV2() {
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

// `new-design` boundary. Profile is a new v2 surface with no pre-v2 counterpart
// — before v2 there was no profile page and nothing linked here, so with the
// flag off we send the user back to the workspace.
function ProfilePage() {
	const { workspaceId } = useWorkspace()
	return useFeatureFlag('new-design') ? (
		<ProfilePageV2 />
	) : (
		<Navigate to="/$workspaceId" params={{ workspaceId }} replace />
	)
}
