import type {
	GraphEdge,
	GraphNode,
	ObjectResponse,
	WidgetCatalogEntry,
	WidgetKind,
	WidgetMatchContext,
} from './types'

/**
 * Widget catalog — the single dispatch table that maps an MCP tool response
 * to the widget that should render it. Subsequent waves (F7/F8) extend this
 * by adding entries; the matchers must remain pure so they can be unit-tested
 * without a live server.
 *
 * Match order matters: the first entry whose `matches()` returns true wins.
 * Specific matchers (graph response shapes) must precede generic ones
 * (object-list fallback).
 */
export const WIDGET_CATALOG: WidgetCatalogEntry[] = [
	{
		kind: 'relationship_graph',
		displayName: 'Relationship graph',
		description:
			'Nodes-and-edges layout. Used by `create_objects` graph responses and `list_relationships`.',
		matches: ({ data }) => isGraphPayload(data),
	},
	{
		kind: 'activity_feed',
		displayName: 'Activity feed',
		description: 'Stream of events. Used by `get_events` and entity activity tools.',
		matches: ({ toolName, data }) =>
			toolName === 'get_events' || isActivityPayload(data),
	},
	{
		kind: 'object_card',
		displayName: 'Object card',
		description:
			'Single-object detail card. Used when `get_objects` returns one record or after `update_objects` on a single id.',
		matches: ({ data }) => {
			const objs = extractObjects(data)
			return objs.length === 1
		},
	},
	{
		kind: 'object_kanban',
		displayName: 'Object kanban',
		description:
			'Status-grouped board for a single object type. Promoted over the table when the result set is single-type and any status appears more than once.',
		matches: ({ data }) => {
			const objs = extractObjects(data)
			if (objs.length < 3) return false
			const types = new Set(objs.map((o) => o.type))
			if (types.size > 1) return false
			const statusCounts = new Map<string, number>()
			for (const o of objs) statusCounts.set(o.status, (statusCounts.get(o.status) ?? 0) + 1)
			return [...statusCounts.values()].some((n) => n > 1)
		},
	},
	{
		kind: 'object_list_table',
		displayName: 'Object list table',
		description:
			'Default fallback for any list of objects (search, list, multi-update results).',
		matches: ({ data }) => extractObjects(data).length > 0,
	},
]

/** Resolve the first matching widget for a tool response. */
export function resolveWidget(ctx: WidgetMatchContext): WidgetKind | null {
	for (const entry of WIDGET_CATALOG) {
		if (entry.matches(ctx)) return entry.kind
	}
	return null
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isGraphPayload(data: unknown): data is { nodes: GraphNode[]; edges: GraphEdge[] } {
	return (
		isObject(data) &&
		Array.isArray((data as { nodes?: unknown }).nodes) &&
		Array.isArray((data as { edges?: unknown }).edges)
	)
}

function isActivityPayload(data: unknown): boolean {
	const items = unwrap(data)
	if (!Array.isArray(items) || items.length === 0) return false
	const first = items[0]
	return isObject(first) && 'action' in first && 'entityType' in first
}

function unwrap(data: unknown): unknown {
	if (isObject(data) && 'data' in data) return (data as { data: unknown }).data
	return data
}

function extractObjects(data: unknown): ObjectResponse[] {
	const items = unwrap(data)
	if (Array.isArray(items)) {
		return items.filter(isObjectResponseLike) as ObjectResponse[]
	}
	if (isObjectResponseLike(items)) return [items as ObjectResponse]
	return []
}

function isObjectResponseLike(value: unknown): boolean {
	return (
		isObject(value) &&
		typeof value.id === 'string' &&
		typeof value.type === 'string' &&
		typeof value.status === 'string'
	)
}
