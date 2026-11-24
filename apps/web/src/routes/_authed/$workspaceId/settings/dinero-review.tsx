import { DineroReviewSection } from '@/components/settings/dinero-review-section'
import { RouteError } from '@/components/shared/route-error'
import { useFeatureFlag } from '@/hooks/use-feature-flag'
import { useWorkspace } from '@/lib/workspace-context'
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/_authed/$workspaceId/settings/dinero-review')({
	component: DineroReviewPage,
	errorComponent: ({ error }) => <RouteError error={error} />,
})

/**
 * Settings → Dinero review. Behind the dinero-review-screen flag: the review routes behind it are
 * for admins and owners only, and only this screen is for the testers until it graduates.
 */
function DineroReviewPage() {
	const { workspaceId } = useWorkspace()
	const enabled = useFeatureFlag('dinero-review-screen')
	if (!enabled) return null

	return (
		<div className="flex flex-col gap-6">
			<DineroReviewSection workspaceId={workspaceId} />
		</div>
	)
}
