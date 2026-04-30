import { StatusBadge } from '@/components/shared/status-badge'
import { TypeBadge } from '@/components/shared/type-badge'
import { Button } from '@/components/ui/button'
import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react'
import { useCallback, useState } from 'react'
import { useCallTool, useToolResult } from '../shared/mcp-app-provider'
import { safeParseJson } from '../shared/parse'
import { renderMcpApp } from '../shared/render'
import { WebAppLink } from '../shared/web-app-link'
import {
	type GraphNode,
	type GraphRelationshipResponse,
	NODE_PAGE_SIZE,
	extractFirstObjectGraph,
	parseGraphResult,
} from './extractors'

interface ExpansionState {
	loading: boolean
	error: string | null
	relationships: GraphRelationshipResponse[]
	connected: Map<string, GraphNode>
}

function GraphApp() {
	const toolResult = useToolResult()
	const callTool = useCallTool()

	const [expanded, setExpanded] = useState<Map<string, ExpansionState>>(() => new Map())
	const [visibleNodeCount, setVisibleNodeCount] = useState(NODE_PAGE_SIZE)

	const expandNode = useCallback(
		async (nodeId: string) => {
			let shouldFetch = true
			setExpanded((prev) => {
				const next = new Map(prev)
				const entry = next.get(nodeId)
				if (entry && !entry.error) {
					// Already loaded; collapse instead of refetch.
					next.delete(nodeId)
					shouldFetch = false
					return next
				}
				next.set(nodeId, {
					loading: true,
					error: null,
					relationships: [],
					connected: new Map(),
				})
				return next
			})
			if (!shouldFetch) return
			try {
				const result = await callTool('get_objects', { ids: [nodeId] })
				const text = (result.content as Array<{ type: string; text?: string }> | undefined)?.find(
					(c) => c.type === 'text',
				)?.text
				const parsed = safeParseJson(text ?? '')
				const bundle = extractFirstObjectGraph(parsed)
				const connected = new Map<string, GraphNode>()
				if (bundle) {
					for (const obj of bundle.connected_objects) connected.set(obj.id, obj)
				}
				setExpanded((prev) => {
					const next = new Map(prev)
					next.set(nodeId, {
						loading: false,
						error: bundle ? null : 'Could not load neighbours',
						relationships: bundle?.relationships ?? [],
						connected,
					})
					return next
				})
			} catch (err) {
				setExpanded((prev) => {
					const next = new Map(prev)
					next.set(nodeId, {
						loading: false,
						error: err instanceof Error ? err.message : String(err),
						relationships: [],
						connected: new Map(),
					})
					return next
				})
			}
		},
		[callTool],
	)

	if (!toolResult) {
		return <div className="p-4 text-muted-foreground text-sm">Waiting for data...</div>
	}

	const text = toolResult.result.content?.find(
		(c: { type: string; text?: string }) => c.type === 'text',
	)?.text
	if (!text) return <div className="p-4 text-muted-foreground text-sm">No data received</div>

	const data = parseGraphResult(text)
	if (!data) {
		return <div className="p-4 text-sm text-foreground">{text}</div>
	}

	const visibleNodes = data.nodes.slice(0, visibleNodeCount)
	const hiddenNodes = Math.max(0, data.nodes.length - visibleNodeCount)

	return (
		<div className="p-4 max-w-2xl">
			<h2 className="text-sm font-medium text-foreground mb-3">
				Graph — {data.nodes.length} nodes, {data.edges.length} edges
			</h2>

			<div className="space-y-1 mb-4">
				<h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-2">
					Nodes
				</h3>
				{visibleNodes.map((node) => (
					<NodeRow
						key={node.id}
						node={node}
						state={expanded.get(node.id) ?? null}
						onToggle={() => expandNode(node.id)}
					/>
				))}
				{hiddenNodes > 0 ? (
					<div className="pt-2">
						<Button
							variant="ghost"
							size="sm"
							onClick={() => setVisibleNodeCount((c) => c + NODE_PAGE_SIZE)}
						>
							Show {Math.min(hiddenNodes, NODE_PAGE_SIZE)} more ({hiddenNodes} hidden)
						</Button>
					</div>
				) : null}
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
							<EdgeEndpoint id={edge.source} />
							<span className="text-accent-foreground font-medium text-xs">
								{edge.type.replace(/_/g, ' ')}
							</span>
							<span className="text-muted-foreground">→</span>
							<EdgeEndpoint id={edge.target} />
						</div>
					))}
				</div>
			)}
		</div>
	)
}

function NodeRow({
	node,
	state,
	onToggle,
}: {
	node: GraphNode
	state: ExpansionState | null
	onToggle: () => void
}) {
	const isOpen = !!state && !state.loading && !state.error
	return (
		<div className="rounded-lg border border-border bg-card">
			<div className="flex items-center gap-3 px-3 py-2">
				<Button
					variant="ghost"
					size="icon"
					aria-label={isOpen ? 'Collapse neighbours' : 'Expand neighbours'}
					onClick={onToggle}
					disabled={state?.loading}
				>
					{state?.loading ? (
						<Loader2 className="size-3 animate-spin" />
					) : isOpen ? (
						<ChevronDown className="size-3" />
					) : (
						<ChevronRight className="size-3" />
					)}
				</Button>
				<TypeBadge type={node.type} />
				<button
					type="button"
					onClick={onToggle}
					className="flex-1 truncate text-left text-sm text-foreground hover:text-accent-foreground"
				>
					{node.title || 'Untitled'}
				</button>
				<StatusBadge status={node.status} />
				<WebAppLink target={{ kind: 'object', id: node.id }} label="Open" />
			</div>
			{state?.error ? <p className="px-3 pb-2 text-xs text-destructive">{state.error}</p> : null}
			{isOpen ? (
				<NeighboursList
					nodeId={node.id}
					relationships={state.relationships}
					connected={state.connected}
				/>
			) : null}
		</div>
	)
}

function NeighboursList({
	nodeId,
	relationships,
	connected,
}: {
	nodeId: string
	relationships: GraphRelationshipResponse[]
	connected: Map<string, GraphNode>
}) {
	if (relationships.length === 0) {
		return <p className="px-3 pb-2 text-xs text-muted-foreground">No relationships.</p>
	}
	return (
		<ul className="space-y-1 px-3 pb-2">
			{relationships.map((rel) => {
				const otherId = rel.sourceId === nodeId ? rel.targetId : rel.sourceId
				const direction = rel.sourceId === nodeId ? '→' : '←'
				const obj = connected.get(otherId)
				return (
					<li key={rel.id} className="flex items-center gap-2 text-xs">
						<span className="font-mono uppercase tracking-wider text-[10px] text-muted-foreground">
							{direction} {rel.type.replace(/_/g, ' ')}
						</span>
						{obj ? (
							<>
								<TypeBadge type={obj.type} />
								<span className="flex-1 truncate text-foreground">{obj.title || 'Untitled'}</span>
								<StatusBadge status={obj.status} />
								<WebAppLink target={{ kind: 'object', id: obj.id }} label="Open" />
							</>
						) : (
							<EdgeEndpoint id={otherId} />
						)}
					</li>
				)
			})}
		</ul>
	)
}

function EdgeEndpoint({ id }: { id: string }) {
	const short = id.slice(0, 8)
	return (
		<span className="font-mono text-xs text-muted-foreground truncate max-w-24" title={id}>
			<WebAppLink target={{ kind: 'object', id }} label={short} />
		</span>
	)
}

renderMcpApp('Graph', <GraphApp />)
