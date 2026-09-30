import { MarketplaceV3Page } from '@/components/marketplace/v3/page'
import { RouteError } from '@/components/shared/route-error'
import { useWorkspace } from '@/lib/workspace-context'
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/_authed/$workspaceId/marketplace/')({
	component: MarketplaceRoute,
	errorComponent: ({ error }) => <RouteError error={error} />,
})

function MarketplaceRoute() {
	const { workspaceId } = useWorkspace()
	return <MarketplaceV3Page workspaceId={workspaceId} />
}
