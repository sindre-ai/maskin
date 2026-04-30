import { ObjectDocumentView } from '@/components/objects/object-document'
import { StatusBadge } from '@/components/shared/status-badge'
import { TypeBadge } from '@/components/shared/type-badge'
import { useCallback, useState } from 'react'
import { CompactEmpty } from '../shared/compact-empty'
import { useCallTool, useToolResult } from '../shared/mcp-app-provider'
import { isArray, safeParseJson, unwrapEnvelope } from '../shared/parse'
import { renderMcpApp } from '../shared/render'
import { ToolHistoryBreadcrumb } from '../shared/tool-history'
import type { ObjectResponse, RelationshipResponse } from '../shared/types'
import { useWorkspaceSchema } from '../shared/use-workspace-schema'
import { WebAppLink } from '../shared/web-app-link'
import {
	extractCreateObjectsList,
	extractFirstUpdatedObject,
	extractGetObjectsBundles,
	extractUpdateObjectsList,
	summarizeUpdateResults,
} from './extractors'
import { MetadataEditor } from './metadata-editor'
import { RelationshipsEditor, type V1RelationshipType } from './relationships-editor'

function ObjectsApp() {
	const toolResult = useToolResult()
	const callTool = useCallTool()
	const [localObject, setLocalObject] = useState<ObjectResponse | null>(null)
	const [localRelationships, setLocalRelationships] = useState<RelationshipResponse[] | null>(null)
	const [localConnected, setLocalConnected] = useState<ObjectResponse[] | null>(null)

	const handleUpdateTitle = useCallback(
		(obj: ObjectResponse) => async (title: string) => {
			setLocalObject({ ...obj, title })
			const result = await callTool('update_objects', { updates: [{ id: obj.id, title }] })
			const updated = extractFirstUpdatedObject(result)
			if (updated) setLocalObject(updated)
		},
		[callTool],
	)

	const handleUpdateContent = useCallback(
		(obj: ObjectResponse) => async (content: string) => {
			setLocalObject({ ...obj, content })
			const result = await callTool('update_objects', { updates: [{ id: obj.id, content }] })
			const updated = extractFirstUpdatedObject(result)
			if (updated) setLocalObject(updated)
		},
		[callTool],
	)

	const handleUpdateStatus = useCallback(
		(obj: ObjectResponse) => async (status: string) => {
			setLocalObject({ ...obj, status })
			const result = await callTool('update_objects', { updates: [{ id: obj.id, status }] })
			const updated = extractFirstUpdatedObject(result)
			if (updated) setLocalObject(updated)
		},
		[callTool],
	)

	const handleUpdateOwner = useCallback(
		(obj: ObjectResponse) => async (owner: string | null) => {
			setLocalObject({ ...obj, owner })
			const result = await callTool('update_objects', { updates: [{ id: obj.id, owner }] })
			const updated = extractFirstUpdatedObject(result)
			if (updated) setLocalObject(updated)
		},
		[callTool],
	)

	const handleDelete = useCallback(
		(obj: ObjectResponse) => async () => {
			await callTool('delete_object', { id: obj.id })
			setLocalObject(null)
		},
		[callTool],
	)

	const handleUpdateMetadata = useCallback(
		(obj: ObjectResponse) => async (metadata: Record<string, unknown>) => {
			// Server-side metadata is constrained to SafeMetadata (primitives + flat
			// arrays of primitives). The schema-form's broader value domain — which
			// includes arbitrary JSON objects — is forwarded as-is and validated by
			// the API; we cast on the optimistic local-object echo so the local
			// state doesn't reject schema-form payloads it can't statically verify.
			setLocalObject({
				...obj,
				metadata: metadata as unknown as ObjectResponse['metadata'],
			})
			const result = await callTool('update_objects', {
				updates: [{ id: obj.id, metadata }],
			})
			const updated = extractFirstUpdatedObject(result)
			if (updated) setLocalObject(updated)
		},
		[callTool],
	)

	const applyRefreshedBundle = useCallback((rawResult: { content?: unknown }) => {
		const content = rawResult?.content as Array<{ type: string; text?: string }> | undefined
		const text = content?.find((c) => c.type === 'text')?.text
		if (!text) return
		const parsed = safeParseJson(text)
		const bundles = extractGetObjectsBundles(parsed)
		const first = bundles[0]
		if (!first) return
		setLocalObject(first.object)
		setLocalRelationships(first.relationships)
		setLocalConnected(first.connected_objects)
	}, [])

	const handleAddRelationship = useCallback(
		(obj: ObjectResponse) =>
			async (input: { source_id: string; target_id: string; type: V1RelationshipType }) => {
				await callTool('update_objects', {
					updates: [],
					edges: [input],
				})
				// Re-fetch the object's graph so the relationships list reflects the new
				// edge (and the connected_objects map gets the target object's title +
				// status). Fabricating a synthetic relationship row without an
				// authoritative id breaks the remove affordance, so we round-trip.
				const refreshed = await callTool('get_objects', { ids: [obj.id] })
				applyRefreshedBundle(refreshed)
			},
		[callTool, applyRefreshedBundle],
	)

	const handleRemoveRelationship = useCallback(
		(obj: ObjectResponse) => async (relationshipId: string) => {
			await callTool('delete_relationship', { id: relationshipId })
			const refreshed = await callTool('get_objects', { ids: [obj.id] })
			applyRefreshedBundle(refreshed)
		},
		[callTool, applyRefreshedBundle],
	)

	if (!toolResult) {
		return <div className="p-4 text-muted-foreground text-sm">Waiting for data...</div>
	}

	const text = toolResult.result.content?.find(
		(c: { type: string; text?: string }) => c.type === 'text',
	)?.text
	if (!text) {
		return <div className="p-4 text-muted-foreground text-sm">No data received</div>
	}

	const data = safeParseJson(text)
	if (!data) return <div className="p-4 text-sm text-foreground">{text}</div>

	const renderDocumentOrList = (
		objects: ObjectResponse[],
		bundle?: { relationships: RelationshipResponse[]; connected_objects: ObjectResponse[] },
	) => {
		if (objects.length === 1) {
			const base = objects[0]
			const obj = localObject?.id === base.id ? localObject : base
			const relationships =
				localObject?.id === base.id && localRelationships !== null
					? localRelationships
					: (bundle?.relationships ?? [])
			const connected =
				localObject?.id === base.id && localConnected !== null
					? localConnected
					: (bundle?.connected_objects ?? [])
			return (
				<ObjectDocument
					obj={obj}
					handlers={editHandlers(obj)}
					relationships={relationships}
					connectedObjects={connected}
					relationshipHandlers={{
						onAdd: handleAddRelationship(obj),
						onRemove: handleRemoveRelationship(obj),
					}}
				/>
			)
		}
		return <ObjectListView objects={objects} />
	}

	const editHandlers = (obj: ObjectResponse) => ({
		onUpdateTitle: handleUpdateTitle(obj),
		onUpdateContent: handleUpdateContent(obj),
		onUpdateStatus: handleUpdateStatus(obj),
		onUpdateOwner: handleUpdateOwner(obj),
		onDelete: handleDelete(obj),
		onUpdateMetadata: handleUpdateMetadata(obj),
	})

	switch (toolResult.toolName) {
		case 'list_objects':
		case 'search_objects': {
			const unwrapped = unwrapEnvelope(data)
			const objects = isArray(unwrapped) ? (unwrapped as ObjectResponse[]) : []
			const query = toolResult.input?.query as string | undefined
			return (
				<div>
					<ToolHistoryBreadcrumb toolName={toolResult.toolName} queryKey="query" />
					<ObjectListView objects={objects} toolName={toolResult.toolName} query={query} />
				</div>
			)
		}
		case 'get_objects': {
			const bundles = extractGetObjectsBundles(data)
			const objects = bundles.map((b) => b.object)
			return renderDocumentOrList(objects, bundles[0])
		}
		case 'update_objects': {
			const updated = extractUpdateObjectsList(data)
			if (updated.length > 0) return renderDocumentOrList(updated)
			return <UpdateSummaryView summary={summarizeUpdateResults(data)} rawText={text} />
		}
		case 'create_objects':
			return renderDocumentOrList(extractCreateObjectsList(data))
		case 'delete_object':
			return <DeletedView />
		default:
			return <div className="p-4 text-sm text-foreground">{text}</div>
	}
}

function ObjectDocument({
	obj,
	handlers,
	relationships,
	connectedObjects,
	relationshipHandlers,
}: {
	obj: ObjectResponse
	handlers: {
		onUpdateTitle: (title: string) => Promise<void>
		onUpdateContent: (content: string) => Promise<void>
		onUpdateStatus: (status: string) => Promise<void>
		onUpdateOwner: (owner: string | null) => Promise<void>
		onDelete: () => Promise<void>
		onUpdateMetadata: (metadata: Record<string, unknown>) => Promise<void>
	}
	relationships: RelationshipResponse[]
	connectedObjects: ObjectResponse[]
	relationshipHandlers: {
		onAdd: (input: {
			source_id: string
			target_id: string
			type: V1RelationshipType
		}) => Promise<void>
		onRemove: (relationshipId: string) => Promise<void>
	}
}) {
	const { schema } = useWorkspaceSchema(obj.workspaceId ?? undefined)
	const statuses = schema?.types[obj.type]?.statuses ?? []
	return (
		<div className="p-4 space-y-6">
			<div className="flex justify-end">
				<WebAppLink target={{ kind: 'object', id: obj.id }} label="Open in Maskin" />
			</div>
			<ObjectDocumentView
				object={obj}
				workspaceId={obj.workspaceId ?? ''}
				statuses={statuses}
				onUpdateTitle={handlers.onUpdateTitle}
				onUpdateContent={handlers.onUpdateContent}
				onUpdateStatus={handlers.onUpdateStatus}
				onUpdateOwner={handlers.onUpdateOwner}
				onDelete={handlers.onDelete}
			/>
			<section className="border-t border-border pt-4">
				<h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
					Metadata
				</h3>
				<MetadataEditor
					objectId={obj.id}
					objectType={obj.type}
					workspaceId={obj.workspaceId ?? undefined}
					metadata={(obj.metadata as Record<string, unknown> | null) ?? null}
					onSubmit={handlers.onUpdateMetadata}
				/>
			</section>
			<section className="border-t border-border pt-4">
				<RelationshipsEditor
					objectId={obj.id}
					objectType={obj.type}
					relationships={relationships}
					connectedObjects={connectedObjects}
					onAdd={relationshipHandlers.onAdd}
					onRemove={relationshipHandlers.onRemove}
				/>
			</section>
		</div>
	)
}

function ObjectListView({
	objects,
	toolName,
	query,
}: { objects: ObjectResponse[]; toolName?: string; query?: string }) {
	if (!objects.length) {
		return <CompactEmpty toolName={toolName ?? 'list_objects'} query={query} />
	}

	return (
		<div className="p-4 space-y-1">
			{objects.map((obj) => (
				<div
					key={obj.id}
					className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-accent hover:text-accent-foreground transition-colors"
				>
					<TypeBadge type={obj.type} />
					<span className="flex-1 text-sm text-foreground truncate">{obj.title || 'Untitled'}</span>
					<StatusBadge status={obj.status} />
					<WebAppLink target={{ kind: 'object', id: obj.id }} label="Open" />
				</div>
			))}
		</div>
	)
}

function DeletedView() {
	return (
		<div className="p-4 text-center">
			<p className="text-sm text-muted-foreground">Object deleted successfully.</p>
		</div>
	)
}

function UpdateSummaryView({
	summary,
	rawText,
}: {
	summary: {
		objectsUpdated: number
		objectsFailed: number
		relationshipsCreated: number
		relationshipsFailed: number
	}
	rawText: string
}) {
	const { objectsUpdated, objectsFailed, relationshipsCreated, relationshipsFailed } = summary
	const hasAny = objectsUpdated + objectsFailed + relationshipsCreated + relationshipsFailed > 0
	if (!hasAny) return <div className="p-4 text-sm text-foreground">{rawText}</div>
	const hasFailures = objectsFailed + relationshipsFailed > 0
	return (
		<div className="p-4 max-w-2xl space-y-1">
			<h2 className="text-sm font-semibold text-foreground mb-2">Update complete</h2>
			{relationshipsCreated > 0 && (
				<p className="text-sm text-muted-foreground">
					{relationshipsCreated} relationship{relationshipsCreated === 1 ? '' : 's'} created
				</p>
			)}
			{objectsUpdated > 0 && (
				<p className="text-sm text-muted-foreground">
					{objectsUpdated} object{objectsUpdated === 1 ? '' : 's'} updated
				</p>
			)}
			{hasFailures && (
				<p className="text-sm text-destructive">
					{objectsFailed > 0 && (
						<>
							{objectsFailed} object update{objectsFailed === 1 ? '' : 's'} failed
						</>
					)}
					{objectsFailed > 0 && relationshipsFailed > 0 && ', '}
					{relationshipsFailed > 0 && (
						<>
							{relationshipsFailed} relationship{relationshipsFailed === 1 ? '' : 's'} failed
						</>
					)}
				</p>
			)}
		</div>
	)
}

renderMcpApp('Objects', <ObjectsApp />)
