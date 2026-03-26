import type { Database } from '@ai-native/db'
import type { PgNotifyBridge } from '@ai-native/realtime'
import type { StorageProvider } from '@ai-native/storage'
import type { OpenAPIHono } from '@hono/zod-openapi'
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

/** Function for making API calls from MCP tool handlers */
export type McpApiCall = (
	method: string,
	path: string,
	body?: unknown,
	options?: { workspaceId?: string },
) => Promise<unknown>

/** MCP tool definition provided by a module */
export interface McpToolDefinition {
	/** Tool name (will be prefixed with moduleId_) */
	name: string
	/** Tool description for MCP */
	description: string
	/** Zod input schema — must be a ZodObject so .shape is accessible for MCP registration */
	inputSchema: z.ZodObject<z.ZodRawShape>
	/** Handler function — receives parsed args and an apiCall helper for making API requests */
	handler: (args: unknown, apiCall: McpApiCall) => Promise<McpToolResult>
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
	/** Optional extra backend routes — will be mounted at /api/m/{moduleId}. Returns an OpenAPIHono app. */
	routes?: (env: ModuleEnv) => OpenAPIHono
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

/** Narrow interface for session management exposed to modules */
export interface ISessionManager {
	createSession(
		workspaceId: string,
		params: {
			actorId: string
			actionPrompt: string
			config?: Record<string, unknown>
			triggerId?: string
			createdBy: string
			autoStart?: boolean
		},
	): Promise<{ id: string; status: string }>
	stopSession(sessionId: string): Promise<void>
	pauseSession(sessionId: string): Promise<void>
	resumeSession(sessionId: string): Promise<void>
}

/** Narrow interface for agent file storage exposed to modules */
export interface IAgentStorage {
	pullAgentFiles(actorId: string, workspaceId: string, localDir: string): Promise<void>
	pushAgentFiles(
		actorId: string,
		workspaceId: string,
		sessionId: string,
		localDir: string,
	): Promise<void>
	getFile(actorId: string, workspaceId: string, fileType: string, path: string): Promise<Buffer>
	uploadFile(
		actorId: string,
		workspaceId: string,
		fileType: string,
		path: string,
		content: Buffer,
	): Promise<string>
	listFiles(actorId: string, workspaceId: string, fileType?: string): Promise<string[]>
}

/** Environment passed to module route factories */
export interface ModuleEnv {
	/** Drizzle database instance */
	db: Database
	/** PG NOTIFY → SSE bridge for real-time events */
	notifyBridge: PgNotifyBridge
	/** Session manager for container-based agent execution */
	sessionManager: ISessionManager
	/** Agent storage manager for file operations */
	agentStorage: IAgentStorage
	/** S3-compatible storage provider for files (recordings, transcripts, etc.) */
	storageProvider: StorageProvider
}

// ── Frontend module definition ─────────────────────────────────────

/** Navigation item for the sidebar */
export interface NavItemDefinition {
	/** Display label */
	label: string
	/** Route path relative to workspace, e.g. 'objects' becomes /$workspaceId/objects */
	path: string
	/** Lucide icon name */
	icon: string
	/** If true, only match this route exactly (not fuzzy) */
	exact?: boolean
}

/** Object type tab for the objects list page */
export interface ObjectTypeTab {
	/** Display label, e.g. 'Insights' */
	label: string
	/** Object type value used as filter, e.g. 'insight' */
	value: string
}

/** Frontend module definition — registered in the web app */
export interface ModuleWebDefinition {
	/** Must match the server module's id */
	id: string
	/** Human-readable name */
	name: string
	/** Sidebar navigation items this module adds */
	navItems: NavItemDefinition[]
	/** Object type tabs this module adds to the objects list */
	objectTypeTabs: ObjectTypeTab[]
}
