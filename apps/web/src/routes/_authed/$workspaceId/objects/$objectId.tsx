import { PageHeader } from '@/components/layout/page-header'
import { ObjectCreateForm } from '@/components/objects/object-create-form'
import { ObjectDetailShell } from '@/components/objects/object-detail-shell'
import { Skeleton } from '@/components/shared/loading-skeleton'
import { QueryStateError } from '@/components/shared/query-state'
import { RouteError } from '@/components/shared/route-error'
import { useDocumentTitle } from '@/hooks/use-document-title'
import { useCreateObject, useObject, useUpdateObject } from '@/hooks/use-objects'
import { trackKnowledgePageViewed } from '@/lib/analytics'
import { ApiError } from '@/lib/api'
import { type ObjectDetailTab, parseObjectDetailTab } from '@/lib/object-detail-tab'
import { useWorkspace } from '@/lib/workspace-context'
import { getDefaultStatusForType } from '@maskin/module-sdk'
import { createFileRoute } from '@tanstack/react-router'
import { useCallback, useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { z } from 'zod'

// `?comment=<event id>` deep-links to one comment (or reply) in the timeline.
// Number-typed so a malformed value is dropped rather than reaching a selector.
// `?tab=related` opens a tab directly; anything else is the Overview.
const objectSearchSchema = z.object({
	tab: z.unknown().transform(parseObjectDetailTab),
	comment: z.coerce.number().int().positive().optional().catch(undefined),
})

export const Route = createFileRoute('/_authed/$workspaceId/objects/$objectId')({
	component: ObjectDetailPage,
	validateSearch: objectSearchSchema,
	errorComponent: ({ error }) => <RouteError error={error} />,
})

function ObjectDetailPage() {
	const { objectId } = Route.useParams()
	const { tab, comment: focusCommentId } = Route.useSearch()
	const navigateTab = Route.useNavigate()
	const onTabChange = (next: ObjectDetailTab) =>
		navigateTab({
			search: (prev) => ({ ...prev, tab: next === 'overview' ? undefined : next }),
			replace: true,
		})
	const { workspaceId, workspace } = useWorkspace()
	// Derive default statuses from workspace settings (first status per type)
	const settings = workspace.settings as Record<string, unknown>
	const statusMap = (settings?.statuses ?? {}) as Record<string, string[]>
	const getDefaultStatus = (type: string) =>
		statusMap[type]?.[0] ?? getDefaultStatusForType(type) ?? 'new'
	const { data: object, isLoading, error, refetch } = useObject(objectId)
	useDocumentTitle(object?.title)
	const createObject = useCreateObject(workspaceId)
	const updateObject = useUpdateObject(workspaceId)
	const isCreatedRef = useRef(false)

	// Once the object exists in cache, mark as created
	useEffect(() => {
		if (object) isCreatedRef.current = true
	}, [object])
	const isCreated = isCreatedRef.current || !!object

	// One event per open of a knowledge page. Keyed on the id so refetches and
	// StrictMode's double effect do not repeat it.
	const knowledgeId = object?.type === 'knowledge' ? object.id : null
	const viewedKnowledgeRef = useRef<string | null>(null)
	useEffect(() => {
		if (!knowledgeId || viewedKnowledgeRef.current === knowledgeId) return
		viewedKnowledgeRef.current = knowledgeId
		trackKnowledgePageViewed({ entity_id: knowledgeId, entity_type: 'knowledge' })
	}, [knowledgeId])

	const handleAutoCreate = async (data: {
		type: string
		title: string
	}) => {
		if (isCreatedRef.current) return
		isCreatedRef.current = true
		try {
			await createObject.mutateAsync({
				id: objectId,
				type: data.type,
				title: data.title,
				status: getDefaultStatus(data.type),
			})
			toast.success('Item created')
		} catch (err) {
			isCreatedRef.current = false
			toast.error(err instanceof Error ? err.message : 'Failed to create item')
		}
	}

	const handleUpdate = useCallback(
		(data: { title?: string; content?: string; status?: string }) => {
			updateObject.mutate(
				{ id: objectId, data },
				{ onError: () => toast.error('Could not save your changes') },
			)
		},
		[objectId, updateObject],
	)

	if (isLoading && !isCreated) {
		return (
			<div className="max-w-3xl mx-auto space-y-4">
				<Skeleton className="h-8 w-64" />
				<Skeleton className="h-4 w-full max-w-96" />
				<Skeleton className="h-32 w-full" />
			</div>
		)
	}

	// Distinguish "id doesn't exist yet → create mode" from "fetch failed on
	// an existing id". A 404 legitimately means the create form (typing a new
	// object into a fresh URL) — any other error is a real load failure.
	const nonNotFoundError =
		error && !(error instanceof ApiError && error.status === 404) ? error : null
	if (nonNotFoundError && !isCreated) {
		return (
			<div className="max-w-3xl mx-auto">
				<QueryStateError
					title="Couldn't load this item"
					error={nonNotFoundError}
					onRetry={() => refetch()}
				/>
			</div>
		)
	}

	// Once fully loaded with object data, render the full document editor
	if (isCreated && object) {
		return (
			<ObjectDetailShell
				object={object}
				tab={tab}
				onTabChange={onTabChange}
				focusCommentId={focusCommentId}
			/>
		)
	}

	// Create mode — show form with document-like sections
	return (
		<>
			<PageHeader />
			<ObjectCreateForm
				objectId={objectId}
				object={object}
				onAutoCreate={handleAutoCreate}
				onUpdate={handleUpdate}
				isPending={createObject.isPending}
				error={createObject.error}
			/>
		</>
	)
}
