import { ExtensionDetail } from '@/components/extensions/extension-detail'
import { EmptyState } from '@/components/shared/empty-state'
import { RouteError } from '@/components/shared/route-error'
import { useFeatureFlag } from '@/hooks/use-feature-flag'
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/_authed/$workspaceId/settings/extensions/$extId')({
	component: ExtensionDetailPage,
	errorComponent: ({ error }) => <RouteError error={error} />,
})

function ExtensionDetailPage() {
	const { extId } = Route.useParams()
	// The detail page is part of the bring-your-own surface, so it sits behind
	// the same flag as the list that links to it.
	const byoExtensionsUi = useFeatureFlag('byo-extensions-ui')
	if (!byoExtensionsUi) return <EmptyState title="Page not found" />
	return <ExtensionDetail extId={extId} />
}
