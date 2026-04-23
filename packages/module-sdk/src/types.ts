import type { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import type { PgNotifyBridge } from '@maskin/realtime'
import type { StorageProvider } from '@maskin/storage'
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
	/**
	 * Optional session-boot hook. Called from the session manager once per
	 * enabled module after agent files are pulled into the session temp dir,
	 * before the container launches. Lets the module write additional context
	 * files (picked up by agent-run.sh and merged into CLAUDE.md) or otherwise
	 * prepare the container's /agent/ tree. Must not throw — failures are
	 * logged and ignored so a broken module cannot block the session.
	 */
	sessionBootHook?: (params: SessionBootHookParams) => Promise<void>
}

/** A seed agent definition a module or template contributes. */
export interface SeedAgent {
	/** Template-local id used by seedTriggers to reference this actor. */
	$id: string
	name: string
	systemPrompt: string
	tools?: Record<string, unknown>
}

/** A seed trigger definition a module or template contributes. */
export interface SeedTrigger {
	name: string
	type: 'event' | 'cron'
	config: Record<string, unknown>
	actionPrompt: string
	/** $id of a SeedAgent (or a real UUID if the user already has one). */
	targetActor$id: string
	enabled: boolean
}

/** Params passed to a module's sessionBootHook. */
export interface SessionBootHookParams {
	/** Drizzle database instance, for querying workspace-scoped data. */
	db: Database
	/** Workspace the session is starting in. */
	workspaceId: string
	/** Local path mounted as /agent in the container. Write additional files here. */
	tempDir: string
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
	/** Default workspace settings to merge when enabling this module */
	defaultSettings?: ModuleDefaultSettings
}
