import { ObjectDocumentView } from '@/components/objects/object-document'
import { PropertiesPanel } from '@/components/objects/properties-panel'
import { EmptyState } from '@/components/shared/empty-state'
import { StatusBadge } from '@/components/shared/status-badge'
import { TypeBadge } from '@/components/shared/type-badge'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { useIsMobile } from '@/hooks/use-mobile'
import { useObjectGraph } from '@/hooks/use-objects'
import { cn } from '@/lib/cn'
import { queryClient } from '@/lib/query'
import { QueryClientProvider } from '@tanstack/react-query'
import { PanelRight } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import { useCallTool, useToolResult } from '../shared/mcp-app-provider'
import { isArray, safeParseJson, unwrapEnvelope } from '../shared/parse'
import { renderMcpApp } from '../shared/render'
import type { ObjectResponse, RelationshipResponse } from '../shared/types'
import { WebAppLink, useWebAppHref } from '../shared/web-app-link'
import {
	extractCreateObjectsList,
	extractFirstUpdatedObject,
	extractGetObjectsList,
	extractUpdateObjectsList,
	summarizeUpdateResults,
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

	const handleUpdateDriver = useCallback(
		(obj: ObjectResponse) => async (driver: string | null) => {
			setLocalObject({ ...obj, driver })
			const result = await callTool('update_objects', { updates: [{ id: obj.id, driver }] })
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
	if (!data) return <div className="p-4 text-sm text-foreground">{text}</div>

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
		onUpdateDriver: handleUpdateDriver(obj),
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

export function ObjectDocument({
	obj,
	handlers,
}: {
	obj: ObjectResponse
	handlers: {
		onUpdateTitle: (title: string) => Promise<void>
		onUpdateContent: (content: string) => Promise<void>
		onUpdateStatus: (status: string) => Promise<void>
		onUpdateDriver: (driver: string | null) => Promise<void>
		onDelete: () => Promise<void>
	}
}) {
	const [drawerOpen, setDrawerOpen] = useState(false)
	const workspaceId = obj.workspaceId ?? ''
	const { data: graph } = useObjectGraph(workspaceId, obj.id)
	const relationships = useMemo(() => {
		if (!graph) return undefined
		const asSource: RelationshipResponse[] = []
		const asTarget: RelationshipResponse[] = []
		for (const rel of graph.relationships) {
			if (rel.sourceId === obj.id) asSource.push(rel)
			if (rel.targetId === obj.id) asTarget.push(rel)
		}
		return { asSource, asTarget }
	}, [graph, obj.id])

	return (
		<div className="p-4">
			<div className="flex justify-end items-center gap-1 mb-3">
				<Button
					variant="ghost"
					size="icon"
					className="h-7 w-7"
					onClick={() => setDrawerOpen((v) => !v)}
					aria-label="Properties"
					aria-expanded={drawerOpen}
				>
					<PanelRight size={15} />
				</Button>
				<WebAppLink target={{ kind: 'object', id: obj.id }} />
			</div>
			<ObjectDocumentView
				object={obj}
				workspaceId={workspaceId}
				statuses={[]}
				onUpdateTitle={handlers.onUpdateTitle}
				onUpdateContent={handlers.onUpdateContent}
				onUpdateStatus={handlers.onUpdateStatus}
				onUpdateDriver={handlers.onUpdateDriver}
				onDelete={handlers.onDelete}
				contentLoaded={'content' in obj}
			/>
			<PropertiesSheet
				open={drawerOpen}
				onOpenChange={setDrawerOpen}
				object={obj}
				workspaceId={workspaceId}
				relationships={relationships}
			/>
		</div>
	)
}

/**
 * Embedded MCP-Apps surface keeps the current Sheet-based properties panel:
 * the panel is a compact widget inside the Claude UI, not a full page, so
 * the persistent right sidebar used on the main web app doesn't fit here.
 */
function PropertiesSheet({
	open,
	onOpenChange,
	object,
	workspaceId,
	relationships,
}: {
	open: boolean
	onOpenChange: (open: boolean) => void
	object: ObjectResponse
	workspaceId: string
	relationships?: {
		asSource: RelationshipResponse[]
		asTarget: RelationshipResponse[]
	}
}) {
	const isMobile = useIsMobile()
	const side = isMobile ? 'bottom' : 'right'
	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent
				side={side}
				className={cn(
					'overflow-y-auto',
					isMobile ? 'max-h-[85dvh] rounded-t-lg rounded-b-none p-0' : 'w-full sm:max-w-sm p-0',
				)}
			>
				<SheetTitle className="px-6 pt-6 text-xs font-medium uppercase tracking-wider text-muted-foreground">
					Properties
				</SheetTitle>
				<SheetDescription className="sr-only">
					Object properties and attached files
				</SheetDescription>
				<div className="px-6 pt-4 pb-6">
					<PropertiesPanel
						object={object}
						workspaceId={workspaceId}
						relationships={relationships}
					/>
				</div>
			</SheetContent>
		</Sheet>
	)
}

function ObjectListView({ objects }: { objects: ObjectResponse[] }) {
	if (!objects.length) {
		return <EmptyState title="No objects" description="No objects found matching the criteria" />
	}

	return (
		<div className="p-4 space-y-1">
			{objects.map((obj) => (
				<ObjectListRow key={obj.id} obj={obj} />
			))}
		</div>
	)
}

function ObjectListRow({ obj }: { obj: ObjectResponse }) {
	const href = useWebAppHref({ kind: 'object', id: obj.id })
	const content = (
		<>
			<TypeBadge type={obj.type} />
			<span className="flex-1 text-sm text-foreground truncate">{obj.title || 'Untitled'}</span>
			<StatusBadge status={obj.status} />
		</>
	)
	if (!href) {
		return (
			<div className="flex items-center gap-3 px-3 py-2 rounded-lg transition-colors">
				{content}
			</div>
		)
	}
	return (
		<a
			href={href}
			target="_blank"
			rel="noreferrer"
			className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-accent hover:text-accent-foreground transition-colors no-underline"
		>
			{content}
		</a>
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

renderMcpApp(
	'Objects',
	<QueryClientProvider client={queryClient}>
		<ObjectsApp />
	</QueryClientProvider>,
)
