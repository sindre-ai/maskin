import { StatusBadge } from '@/components/shared/status-badge'
import { TypeBadge } from '@/components/shared/type-badge'
import { useToolResult } from '../shared/mcp-app-provider'
import { renderMcpApp } from '../shared/render'

interface GraphNode {
	$id: string
	id: string
	type: string
	title: string | null
	status: string
}

interface GraphEdge {
	id: string
	source: string
	target: string
	type: string
}

interface GraphResult {
	nodes: GraphNode[]
	edges: GraphEdge[]
}

function GraphApp() {
	const toolResult = useToolResult()

	if (!toolResult) {
		return <div className="p-4 text-muted-foreground text-sm">Waiting for data...</div>
	}

	const text = toolResult.result.content?.find(
		(c: { type: string; text?: string }) => c.type === 'text',
	)?.text
	if (!text) return <div className="p-4 text-muted-foreground text-sm">No data received</div>

	const data: GraphResult = JSON.parse(text)

	return (
		<div className="p-4 max-w-2xl">
			<h2 className="text-sm font-medium text-foreground mb-3">
				Graph Created — {data.nodes.length} nodes, {data.edges.length} edges
			</h2>

			<div className="space-y-1 mb-4">
				<h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-2">
					Nodes
				</h3>
				{data.nodes.map((node) => (
					<div key={node.id} className="flex items-center gap-3 px-3 py-2 rounded-lg bg-card">
						<TypeBadge type={node.type} />
						<span className="flex-1 text-sm text-foreground truncate">
							{node.title || 'Untitled'}
						</span>
						<StatusBadge status={node.status} />
					</div>
				))}
			</div>

			{data.edges.length > 0 && (
				<div className="space-y-1">
					<h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-2">
						Edges
					</h3>
					{data.edges.map((edge) => (
						<div
							key={edge.id}
							className="flex items-center gap-2 px-3 py-2 rounded-lg bg-card text-sm"
						>
							<span className="text-muted-foreground font-mono text-xs truncate max-w-24">
								{edge.source.slice(0, 8)}
							</span>
							<span className="text-accent-foreground font-medium text-xs">
								{edge.type.replace(/_/g, ' ')}
							</span>
							<span className="text-muted-foreground">→</span>
							<span className="text-muted-foreground font-mono text-xs truncate max-w-24">
								{edge.target.slice(0, 8)}
							</span>
						</div>
					))}
				</div>
			)}
		</div>
	)
}

renderMcpApp('Graph', <GraphApp />)
