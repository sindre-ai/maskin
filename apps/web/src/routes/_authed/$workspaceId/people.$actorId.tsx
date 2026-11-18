import { PersonDetailView } from '@/components/people/person-detail-view'
import { RouteError } from '@/components/shared/route-error'
import { useActor } from '@/hooks/use-actors'
import { useDocumentTitle } from '@/hooks/use-document-title'
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/_authed/$workspaceId/people/$actorId')({
	component: PersonDetailPage,
	errorComponent: ({ error }) => <RouteError error={error} />,
})

function PersonDetailPage() {
	const { actorId } = Route.useParams()
	const { data: person } = useActor(actorId)
	useDocumentTitle(person?.name)
	return <PersonDetailView actorId={actorId} />
}
