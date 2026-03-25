import type { z } from 'zod'

/** Field definition for custom metadata fields on objects */
export interface FieldDefinition {
	name: string
	type: 'text' | 'number' | 'date' | 'enum' | 'boolean'
	required?: boolean
	values?: string[]
}

/** Definition of an object type provided by a module */
export interface ObjectTypeDefinition {
	/** Object type string used in the objects table, e.g. 'meeting' */
	type: string
	/** Human-readable label, e.g. 'Meeting' */
	label: string
	/** Lucide icon name for the sidebar, e.g. 'video' */
	icon: string
	/** Default statuses for this type in workspace settings */
	defaultStatuses: string[]
	/** Default custom field definitions */
	defaultFields?: FieldDefinition[]
	/** Default relationship types this type commonly uses */
	defaultRelationshipTypes?: string[]
}

/** MCP tool definition provided by a module */
export interface McpToolDefinition {
	/** Tool name (will be prefixed with moduleId_) */
	name: string
	/** Tool description for MCP */
	description: string
	/** Zod input schema */
	inputSchema: z.ZodType<unknown>
	/** Handler function — receives parsed args, returns MCP tool result */
	handler: (args: unknown) => Promise<McpToolResult>
}

export interface McpToolResult {
	content: Array<{ type: 'text'; text: string }>
}

/** Server-side module definition */
export interface ModuleDefinition {
	/** Unique module identifier, e.g. 'work', 'notetaker' */
	id: string
	/** Human-readable name, e.g. 'Notetaker' */
	name: string
	/** Semver version */
	version: string
	/** Object types this module provides */
	objectTypes: ObjectTypeDefinition[]
	/** Optional extra backend routes — will be mounted at /api/m/{moduleId}. Returns a Hono app. */
	routes?: (env: ModuleEnv) => unknown
	/** Optional extra MCP tools (namespaced with moduleId prefix) */
	mcpTools?: McpToolDefinition[]
	/** Default workspace settings this module contributes when first enabled */
	defaultSettings?: ModuleDefaultSettings
}

/** Default settings a module contributes to workspace settings when enabled */
export interface ModuleDefaultSettings {
	display_names?: Record<string, string>
	statuses?: Record<string, string[]>
	field_definitions?: Record<string, FieldDefinition[]>
	relationship_types?: string[]
}

/** Environment passed to module route factories */
export interface ModuleEnv {
	db: unknown
	notifyBridge: unknown
	sessionManager: unknown
	agentStorage: unknown
}
