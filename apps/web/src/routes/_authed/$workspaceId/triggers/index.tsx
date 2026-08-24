import { RouteError } from '@/components/shared/route-error'
import { LegacyTriggersIndexPage } from '@/components/triggers/legacy/triggers-index-page'
import { useNewDesign } from '@/lib/new-design-context'
import { Navigate, createFileRoute, useParams } from '@tanstack/react-router'

/**
 * v2 folds triggers into Loops: the Loops list renders every standalone trigger
 * under "Not tied to a loop", and the sidebar has no Triggers entry. Keeping a
 * second surface that lists the same rows would guarantee drift, so under the
 * flag this route redirects instead of being deleted — `/{ws}/triggers`
 * bookmarks and `lib/navigation.ts`'s trigger entity resolution both keep
 * resolving, and `/{ws}/triggers/{id}` stays fully mounted.
 *
 * With `new-design` OFF the pre-v2 Triggers index still renders here. The
 * redirect lives in the component rather than `beforeLoad` so the flag is still
 * read at its single boundary and travels down as context — `beforeLoad` runs
 * outside React and could not read it.
 */
export const Route = createFileRoute('/_authed/$workspaceId/triggers/')({
	component: TriggersRoute,
	errorComponent: ({ error }) => <RouteError error={error} />,
})

function TriggersRoute() {
	const { workspaceId } = useParams({ from: '/_authed/$workspaceId/triggers/' })
	const newDesign = useNewDesign()
	if (!newDesign) return <LegacyTriggersIndexPage />
	return <Navigate to="/$workspaceId/loops" params={{ workspaceId }} replace />
}
