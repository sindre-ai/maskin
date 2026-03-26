import { ObjectDocumentView } from '@/components/objects/object-document'
import { EmptyState } from '@/components/shared/empty-state'
import { StatusBadge } from '@/components/shared/status-badge'
import { TypeBadge } from '@/components/shared/type-badge'
import { useCallback, useState } from 'react'
import { useCallTool, useToolResult } from '../shared/mcp-app-provider'
import { renderMcpApp } from '../shared/render'
import type { ObjectResponse } from '../shared/types'

function ObjectsApp() {
	const toolResult = useToolResult()
	const callTool = useCallTool()
	const [localObject, setLocalObject] = useState<ObjectResponse | null>(null)

	const handleUpdateTitle = useCallback(
		(obj: ObjectResponse) => async (title: string) => {
			setLocalObject({ ...obj, title })
			const result = await callTool('update_object', { id: obj.id, title })
			const text = result.content?.find((c) => c.type === 'text')?.text ?? null
			if (text) setLocalObject(JSON.parse(text))
		},
		[callTool],
	)

	const handleUpdateContent = useCallback(
		(obj: ObjectResponse) => async (content: string) => {
			setLocalObject({ ...obj, content })
			const result = await callTool('update_object', { id: obj.id, content })
			const text = result.content?.find((c) => c.type === 'text')?.text ?? null
			if (text) setLocalObject(JSON.parse(text))
		},
		[callTool],
	)

	const handleUpdateStatus = useCallback(
		(obj: ObjectResponse) => async (status: string) => {
			setLocalObject({ ...obj, status })
			const result = await callTool('update_object', { id: obj.id, status })
			const text = result.content?.find((c) => c.type === 'text')?.text ?? null
			if (text) setLocalObject(JSON.parse(text))
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

	const data = JSON.parse(text)

	switch (toolResult.toolName) {
		case 'list_objects':
			return <ObjectListView objects={data.data ?? data} />
		case 'get_object':
		case 'create_object':
		case 'update_object': {
			const obj = localObject ?? data
			return (
				<div className="p-4">
					<ObjectDocumentView
						object={obj}
						workspaceId={obj.workspaceId ?? ''}
						statuses={[]}
						onUpdateTitle={handleUpdateTitle(obj)}
						onUpdateContent={handleUpdateContent(obj)}
						onUpdateStatus={handleUpdateStatus(obj)}
						onDelete={handleDelete(obj)}
					/>
				</div>
			)
		}
		case 'delete_object':
			return <DeletedView />
		default: {
			const defaultObj = localObject ?? data
			return (
				<div className="p-4">
					<ObjectDocumentView
						object={defaultObj}
						workspaceId={defaultObj.workspaceId ?? ''}
						statuses={[]}
						onUpdateTitle={handleUpdateTitle(defaultObj)}
						onUpdateContent={handleUpdateContent(defaultObj)}
						onUpdateStatus={handleUpdateStatus(defaultObj)}
						onDelete={handleDelete(defaultObj)}
					/>
				</div>
			)
		}
	}
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
