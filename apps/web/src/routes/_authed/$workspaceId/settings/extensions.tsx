import { ExtensionsSection } from '@/components/extensions/extensions-section'
import { RouteError } from '@/components/shared/route-error'
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/_authed/$workspaceId/settings/extensions')({
	component: ExtensionsPage,
	errorComponent: ({ error }) => <RouteError error={error} />,
})

function ExtensionsPage() {
	return (
		<div className="max-w-lg">
			<ExtensionsSection />
		</div>
	)
}
