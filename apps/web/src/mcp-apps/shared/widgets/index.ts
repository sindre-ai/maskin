/**
 * MCP widget catalog — barrel.
 *
 * Subsequent task waves (F7/F8) import primitives from this module. Adding a
 * new widget = drop a file in this directory, re-export below, and register
 * the entry in `catalog.ts` so the dispatcher can resolve it.
 *
 * See `packages/mcp/RENDERING.md` for the human-readable catalog and the
 * response-shape → widget mapping.
 */

export { ObjectCard } from './object-card'
export { ObjectListTable } from './object-list-table'
export { ObjectKanban } from './object-kanban'
export { RelationshipGraph } from './relationship-graph'
export { ActivityFeed } from './activity-feed'
export { WIDGET_CATALOG, resolveWidget } from './catalog'
export type {
	ActivityFeedProps,
	GraphEdge,
	GraphNode,
	ObjectActionHandlers,
	ObjectCardProps,
	ObjectKanbanProps,
	ObjectListTableProps,
	RelationshipGraphProps,
	WidgetBaseProps,
	WidgetCatalogEntry,
	WidgetKind,
	WidgetMatchContext,
	WorkspaceSchema,
	WorkspaceSchemaField,
	WorkspaceSchemaType,
} from './types'
