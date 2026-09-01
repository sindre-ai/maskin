import { ExtensionsManager } from '@/components/extensions/extensions-manager'
import { RouteError } from '@/components/shared/route-error'
import { useFeatureFlag } from '@/hooks/use-feature-flag'
import { useWorkspace } from '@/lib/workspace-context'
import { Navigate, createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/_authed/$workspaceId/settings/extensions')({
	component: ExtensionsPage,
	errorComponent: ({ error }) => <RouteError error={error} />,
})

function ExtensionsPageV2() {
	return (
		<div className="max-w-[580px]">
			<p className="mb-3 text-xs leading-relaxed text-muted-foreground">
				Extensions add object types and tabs for this workspace. Turning one off hides its objects —
				it never deletes them.
			</p>
			<ExtensionsManager />
		</div>
	)
}

// `new-design` boundary. This route has no pre-v2 counterpart — before v2,
// extension toggles lived on Settings → General and the pre-v2 nav never linked
// here, so with the flag off we send the user back there.
function ExtensionsPage() {
	const { workspaceId } = useWorkspace()
	return useFeatureFlag('new-design') ? (
		<ExtensionsPageV2 />
	) : (
		<Navigate to="/$workspaceId/settings" params={{ workspaceId }} replace />
	)
}
