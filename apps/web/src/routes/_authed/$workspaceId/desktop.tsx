import { DesktopViewer } from '@/components/desktop/desktop-viewer'
import { PageHeader } from '@/components/layout/page-header'
import { EmptyState } from '@/components/shared/empty-state'
import { RouteError } from '@/components/shared/route-error'
import { useFeatureFlag } from '@/hooks/use-feature-flag'
import { DESKTOP_FLAG } from '@/lib/nav-items'
import { useWorkspace } from '@/lib/workspace-context'
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/_authed/$workspaceId/desktop')({
	component: DesktopRoute,
	errorComponent: ({ error }) => <RouteError error={error} />,
})

// The flag is read once here: this route is the boundary for the whole page,
// so DesktopViewer and everything under it stay flag-free.
function DesktopRoute() {
	const { workspaceId } = useWorkspace()
	const enabled = useFeatureFlag(DESKTOP_FLAG)

	return (
		<>
			<PageHeader title="Desktop" />
			<div className="p-4 md:p-6">
				{enabled ? (
					<DesktopViewer workspaceId={workspaceId} />
				) : (
					<EmptyState
						title="Desktop isn't available yet"
						description="This workspace doesn't have access to the desktop."
					/>
				)}
			</div>
		</>
	)
}
