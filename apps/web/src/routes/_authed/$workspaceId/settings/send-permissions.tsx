import { SendPermissionsSection } from '@/components/settings/send-permissions-section'
import { RouteError } from '@/components/shared/route-error'
import { useFeatureFlag } from '@/hooks/use-feature-flag'
import { useWorkspace } from '@/lib/workspace-context'
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/_authed/$workspaceId/settings/send-permissions')({
	component: SendPermissionsPage,
	errorComponent: ({ error }) => <RouteError error={error} />,
})

/**
 * Settings → Send permissions. Behind the send-permissions-screen flag: the send gate itself is
 * always on (it reads the saved settings), only this screen is for the testers until it graduates.
 */
function SendPermissionsPage() {
	const { workspaceId } = useWorkspace()
	const enabled = useFeatureFlag('send-permissions-screen')
	if (!enabled) return null

	return (
		<div className="flex flex-col gap-6">
			<SendPermissionsSection workspaceId={workspaceId} />
		</div>
	)
}
