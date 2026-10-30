import { ExtensionDetail } from '@/components/extensions/extension-detail'
import { RouteError } from '@/components/shared/route-error'
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/_authed/$workspaceId/settings/extensions/$extId')({
	component: ExtensionDetailPage,
	errorComponent: ({ error }) => <RouteError error={error} />,
})

function ExtensionDetailPage() {
	const { extId } = Route.useParams()
	return <ExtensionDetail extId={extId} />
}
