import { CustomExtensionsSection } from '@/components/extensions/custom-extensions-section'
import { ExtensionsManager } from '@/components/extensions/extensions-manager'
import { RouteError } from '@/components/shared/route-error'
import { useFeatureFlag } from '@/hooks/use-feature-flag'
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/_authed/$workspaceId/settings/extensions/')({
	component: ExtensionsPage,
	errorComponent: ({ error }) => <RouteError error={error} />,
})

function ExtensionsPage() {
	// One boundary for the bring-your-own surface: the list below the built-in
	// extensions. Off is exactly today's page.
	const byoExtensionsUi = useFeatureFlag('byo-extensions-ui')
	return (
		<div className="max-w-[580px]">
			<p className="mb-3 text-xs leading-relaxed text-muted-foreground">
				Extensions add object types and tabs for this workspace. Turning one off hides its objects —
				it never deletes them.
			</p>
			<ExtensionsManager />
			{byoExtensionsUi && <CustomExtensionsSection />}
		</div>
	)
}
