import { ExtensionsManager } from '@/components/extensions/extensions-manager'
import { RouteError } from '@/components/shared/route-error'
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/_authed/$workspaceId/settings/extensions')({
	component: ExtensionsPage,
	errorComponent: ({ error }) => <RouteError error={error} />,
})

function ExtensionsPage() {
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
