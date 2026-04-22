import { ObjectDocumentView } from '@/components/objects/object-document'
import { EmptyState } from '@/components/shared/empty-state'
import { StatusBadge } from '@/components/shared/status-badge'
import { TypeBadge } from '@/components/shared/type-badge'
import { useCallback, useState } from 'react'
import { useCallTool, useToolResult } from '../shared/mcp-app-provider'
import { isArray, safeParseJson, unwrapEnvelope } from '../shared/parse'
import { renderMcpApp } from '../shared/render'
import type { ObjectResponse } from '../shared/types'
import {
	extractCreateObjectsList,
	extractFirstUpdatedObject,
	extractGetObjectsList,
	extractUpdateObjectsList,
} from './extractors'

function ObjectsApp() {
	const toolResult = useToolResult()
	const callTool = useCallTool()
	const [localObject, setLocalObject] = useState<ObjectResponse | null>(null)

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
	if (data === null) return <div className="p-4 text-sm text-foreground">{text}</div>

	const renderDocumentOrList = (objects: ObjectResponse[]) => {
		if (objects.length === 1) {
			const base = objects[0]
			const obj = localObject?.id === base.id ? localObject : base
			return <ObjectDocument obj={obj} handlers={editHandlers(obj)} />
		}
		return <ObjectListView objects={objects} />
	}

	const editHandlers = (obj: ObjectResponse) => ({
		onUpdateTitle: handleUpdateTitle(obj),
		onUpdateContent: handleUpdateContent(obj),
		onUpdateStatus: handleUpdateStatus(obj),
		onUpdateOwner: handleUpdateOwner(obj),
		onDelete: handleDelete(obj),
	})

	switch (toolResult.toolName) {
		case 'list_objects':
		case 'search_objects': {
			const unwrapped = unwrapEnvelope(data)
			return <ObjectListView objects={isArray(unwrapped) ? (unwrapped as ObjectResponse[]) : []} />
		}
		case 'get_objects':
			return renderDocumentOrList(extractGetObjectsList(data))
		case 'update_objects':
			return renderDocumentOrList(extractUpdateObjectsList(data))
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
}: {
	obj: ObjectResponse
	handlers: {
		onUpdateTitle: (title: string) => Promise<void>
		onUpdateContent: (content: string) => Promise<void>
		onUpdateStatus: (status: string) => Promise<void>
		onUpdateOwner: (owner: string | null) => Promise<void>
		onDelete: () => Promise<void>
	}
}) {
	return (
		<div className="p-4">
			<ObjectDocumentView
				object={obj}
				workspaceId={obj.workspaceId ?? ''}
				statuses={[]}
				onUpdateTitle={handlers.onUpdateTitle}
				onUpdateContent={handlers.onUpdateContent}
				onUpdateStatus={handlers.onUpdateStatus}
				onUpdateOwner={handlers.onUpdateOwner}
				onDelete={handlers.onDelete}
			/>
		</div>
	)
}

function ObjectListView({ objects }: { objects: ObjectResponse[] }) {
	if (!objects.length) {
		return <EmptyState title="No objects" description="No objects found matching the criteria" />
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

renderMcpApp('Objects', <ObjectsApp />)
