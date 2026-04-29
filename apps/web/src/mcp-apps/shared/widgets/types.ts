/**
 * Shared types for the MCP widget catalog.
 *
 * The catalog is the contract between the MCP server's tool responses and the
 * web cards that render them. Subsequent task waves (F7/F8) consume these
 * types and primitives; the MCP server's `_meta` envelope is the runtime
 * surface that drives which widget to mount.
 */

import type { EventResponse, ObjectResponse, RelationshipResponse } from '../types'

/**
 * Shape of `get_workspace_schema` tool responses (server-side this is built
 * in `packages/mcp/src/server.ts`). The catalog accepts a partial schema so
 * widgets keep working when the server cannot return one (e.g. older MCP
 * server, network failure during schema fetch).
 */
export interface WorkspaceSchema {
	workspace_id: string
	workspace_name: string
	relationship_types: string[]
	types: Record<string, WorkspaceSchemaType>
}

export interface WorkspaceSchemaType {
	display_name: string
	statuses: string[]
	fields: WorkspaceSchemaField[]
}

export interface WorkspaceSchemaField {
	name: string
	type: string
	required: boolean
	values?: string[]
}

/**
 * Action callbacks that any object-oriented widget may surface. Every handler
 * is optional — widgets render the affordance only when the corresponding
 * handler is provided. The contract mirrors the `update_objects` /
 * `delete_object` tool surface, so a card wiring up callTool can pass the
 * MCP tool calls through unchanged.
 */
export interface ObjectActionHandlers {
	onUpdateTitle?: (id: string, title: string) => Promise<void> | void
	onUpdateContent?: (id: string, content: string) => Promise<void> | void
	onUpdateStatus?: (id: string, status: string) => Promise<void> | void
	onUpdateOwner?: (id: string, owner: string | null) => Promise<void> | void
	onDelete?: (id: string) => Promise<void> | void
}

/** Node in a relationship graph response. */
export interface GraphNode {
	id: string
	type: string
	title: string | null
	status: string
}

/** Edge in a relationship graph response. */
export interface GraphEdge {
	id: string
	source: string
	target: string
	type: string
}

/**
 * Catalog identifier — one per primitive. Used by `RENDERING.md` and by the
 * MCP server when stamping `_meta.widget` on tool responses (planned in F7).
 */
export type WidgetKind =
	| 'object_card'
	| 'object_list_table'
	| 'object_kanban'
	| 'relationship_graph'
	| 'activity_feed'

/** Shared base props every widget accepts. */
export interface WidgetBaseProps {
	/** Workspace schema for status options, field definitions, display names. */
	schema?: WorkspaceSchema | null
	/** Optional className passthrough for layout tweaks in the host card. */
	className?: string
}

export interface ObjectCardProps extends WidgetBaseProps {
	object: ObjectResponse
	handlers?: ObjectActionHandlers
}

export interface ObjectListTableProps extends WidgetBaseProps {
	objects: ObjectResponse[]
	handlers?: ObjectActionHandlers
	/** Empty-state copy override. */
	emptyTitle?: string
	emptyDescription?: string
}

export interface ObjectKanbanProps extends WidgetBaseProps {
	objects: ObjectResponse[]
	handlers?: ObjectActionHandlers
	/**
	 * Group key. Defaults to `status`; widgets fall back to `type` when grouping
	 * across heterogeneous result sets.
	 */
	groupBy?: 'status' | 'type'
}

export interface RelationshipGraphProps extends WidgetBaseProps {
	nodes: GraphNode[]
	edges: GraphEdge[]
}

export interface ActivityFeedProps extends WidgetBaseProps {
	events: EventResponse[]
}

/**
 * Discriminated descriptor — the catalog entry for each widget. `RENDERING.md`
 * documents which response shapes resolve to which `WidgetKind`; F7/F8 will
 * use this descriptor for the dispatch table.
 */
export interface WidgetCatalogEntry {
	kind: WidgetKind
	displayName: string
	description: string
	/** Heuristic match for an MCP tool response. Pure, no side-effects. */
	matches: (ctx: WidgetMatchContext) => boolean
}

export interface WidgetMatchContext {
	toolName: string
	/** Parsed JSON payload, post-envelope-unwrap. */
	data: unknown
}

export type { EventResponse, ObjectResponse, RelationshipResponse }
