import { EmptyState } from '@/components/shared/empty-state'
import { useToolResult } from '../shared/mcp-app-provider'
import { renderMcpApp } from '../shared/render'
import type { RelationshipResponse } from '../shared/types'

function RelationshipsApp() {
	const toolResult = useToolResult()

	if (!toolResult) {
		return <div className="p-4 text-muted-foreground text-sm">Waiting for data...</div>
	}

	const text = toolResult.result.content?.find(
		(c: { type: string; text?: string }) => c.type === 'text',
	)?.text
	if (!text) return <div className="p-4 text-muted-foreground text-sm">No data received</div>

	const data = JSON.parse(text)

	switch (toolResult.toolName) {
		case 'list_relationships':
			return <RelationshipListView relationships={data.data ?? data} />
		case 'create_relationship':
			return <RelationshipCreatedView relationship={data} />
		case 'delete_relationship':
			return <DeletedView />
		default:
			return <RelationshipListView relationships={Array.isArray(data) ? data : [data]} />
	}
}

function RelationshipListView({ relationships }: { relationships: RelationshipResponse[] }) {
	if (!relationships.length) {
		return <EmptyState title="No relationships" description="No relationships found" />
	}

	return (
		<div className="p-4 space-y-1">
			{relationships.map((rel) => (
				<div
					key={rel.id}
					className="flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-accent hover:text-accent-foreground transition-colors text-sm"
				>
					<span className="text-muted-foreground font-mono text-xs truncate max-w-24">
						{rel.sourceId.slice(0, 8)}
					</span>
					<span className="text-primary text-xs">{rel.type.replace(/_/g, ' ')}</span>
					<span className="text-muted-foreground">→</span>
					<span className="text-muted-foreground font-mono text-xs truncate max-w-24">
						{rel.targetId.slice(0, 8)}
					</span>
				</div>
			))}
		</div>
	)
}

function RelationshipCreatedView({ relationship }: { relationship: RelationshipResponse }) {
	return (
		<div className="p-4">
			<h2 className="text-sm font-medium text-foreground mb-3">Relationship Created</h2>
			<div className="flex items-center gap-2 text-sm">
				<span className="text-muted-foreground font-mono text-xs">
					{relationship.sourceId.slice(0, 8)}
				</span>
				<span className="text-primary text-xs">{relationship.type.replace(/_/g, ' ')}</span>
				<span className="text-muted-foreground">→</span>
				<span className="text-muted-foreground font-mono text-xs">
					{relationship.targetId.slice(0, 8)}
				</span>
			</div>
		</div>
	)
}

function DeletedView() {
	return (
		<div className="p-4 text-center">
			<p className="text-sm text-muted-foreground">Relationship deleted successfully.</p>
		</div>
	)
}

renderMcpApp('Relationships', <RelationshipsApp />)
