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
// so DesktopViewer and everything under it stay flag-free. DesktopViewer
// publishes its own nav row (status + Take over) and fills the page; this route
// only owns the header for the flag-off state, so there is one writer at a time.
function DesktopRoute() {
	const { workspaceId } = useWorkspace()
	const enabled = useFeatureFlag(DESKTOP_FLAG)

	if (enabled) return <DesktopViewer workspaceId={workspaceId} />

	return (
		<>
			<PageHeader title="Desktop" />
			<EmptyState
				title="Desktop isn't available yet"
				description="This workspace doesn't have access to the desktop."
			/>
		</>
	)
}
