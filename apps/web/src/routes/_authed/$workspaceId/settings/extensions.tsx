import { ExtensionsManager } from '@/components/extensions/extensions-manager'
import { RouteError } from '@/components/shared/route-error'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/_authed/$workspaceId/settings/extensions')({
	component: ExtensionsPage,
	errorComponent: ({ error }) => <RouteError error={error} />,
})

function ExtensionsPage() {
	return (
		<div className="space-y-4">
			<Card>
				<CardHeader>
					<CardTitle>Extensions</CardTitle>
				</CardHeader>
				<CardContent>
					<p className="mb-3 text-sm text-muted-foreground">
						Enable or disable extensions for this workspace. Enabled extensions add object types,
						statuses, and navigation to the app.
					</p>
					<ExtensionsManager />
				</CardContent>
			</Card>
		</div>
	)
}
