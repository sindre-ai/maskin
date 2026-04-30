import { safeParseJson } from '../shared/parse'

export interface GraphNode {
	$id?: string
	id: string
	type: string
	title: string | null
	status: string
}

export interface GraphEdge {
	id: string
	source: string
	target: string
	type: string
}

export interface GraphResult {
	nodes: GraphNode[]
	edges: GraphEdge[]
}

export interface GraphRelationshipResponse {
	id: string
	sourceId: string
	targetId: string
	type: string
}

export interface ObjectGraphPayload {
	object: GraphNode
	relationships: GraphRelationshipResponse[]
	connected_objects: GraphNode[]
}

/** Default page size for the nodes list. Generous enough that most card sizes
 * render the full graph, small enough that a workspace dump doesn't melt the
 * card runtime. Users can hit "Show more" to lift the cap by another page. */
export const NODE_PAGE_SIZE = 25

/** Parse a `create_objects` / `_meta.ui = graph` text payload, with light shape
 * validation so a stray tool response doesn't blow up rendering. */
export function parseGraphResult(text: string): GraphResult | null {
	const parsed = safeParseJson(text)
	if (!parsed || typeof parsed !== 'object') return null
	const candidate = parsed as Partial<GraphResult>
	if (!Array.isArray(candidate.nodes) || !Array.isArray(candidate.edges)) return null
	return {
		nodes: candidate.nodes.filter(isGraphNode),
		edges: candidate.edges.filter(isGraphEdge),
	}
}

export function isGraphNode(value: unknown): value is GraphNode {
	if (!value || typeof value !== 'object') return false
	const v = value as Record<string, unknown>
	return typeof v.id === 'string' && typeof v.type === 'string' && typeof v.status === 'string'
}

export function isGraphEdge(value: unknown): value is GraphEdge {
	if (!value || typeof value !== 'object') return false
	const v = value as Record<string, unknown>
	return (
		typeof v.id === 'string' &&
		typeof v.source === 'string' &&
		typeof v.target === 'string' &&
		typeof v.type === 'string'
	)
}

/** Pull the first successful `{ object, relationships, connected_objects }`
 * bundle out of a `get_objects` tool response array. */
export function extractFirstObjectGraph(parsed: unknown): ObjectGraphPayload | null {
	if (!Array.isArray(parsed)) return null
	for (const r of parsed as Array<{ success?: boolean; result?: ObjectGraphPayload }>) {
		if (!r?.success || !r.result?.object) continue
		const result = r.result
		return {
			object: result.object,
			relationships: Array.isArray(result.relationships) ? result.relationships : [],
			connected_objects: Array.isArray(result.connected_objects) ? result.connected_objects : [],
		}
	}
	return null
}
