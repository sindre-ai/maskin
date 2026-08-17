import { IntegrationsManager } from '@/components/integrations/integrations-manager'
import { RouteError } from '@/components/shared/route-error'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/_authed/$workspaceId/settings/integrations')({
	component: IntegrationsPage,
	errorComponent: ({ error }) => <RouteError error={error} />,
})

function IntegrationsPage() {
	return (
		<div className="space-y-4">
			<Card>
				<CardHeader>
					<CardTitle>Integrations</CardTitle>
				</CardHeader>
				<CardContent>
					<p className="mb-3 text-sm text-muted-foreground">
						Connect this workspace to third-party services. Connection state persists across reload
						— connect once and it stays connected until you disconnect it.
					</p>
					<IntegrationsManager />
				</CardContent>
			</Card>
		</div>
	)
}
