import {
	COMMENT_MAX_ATTACHMENTS,
	COMMENT_MAX_LENGTH,
	createCommentSchema,
	notificationActionSchema,
	notificationOptionSchema,
	skillNameSchema,
} from '@maskin/shared'
import { z } from 'zod'

// Keep field list in sync with `notificationMetadataSchema` in
// packages/shared/src/schemas/notifications.ts — that schema is the canonical
// server-side source of truth. This MCP-facing schema is intentionally stricter
// (native arrays only, no JSON-string coercion) so agents are pushed toward the
// correct shape; legacy stringified payloads are only tolerated at the HTTP layer.
const notificationMetadataInput = z
	.object({
		actions: z
			.array(notificationActionSchema)
			.optional()
			.describe(
				'Clickable buttons rendered on the notification card. MUST be a native JSON array of objects — do NOT stringify. Example: [{ "label": "Merged, continue", "response": "merged_continue" }, { "label": "Not ready yet", "response": "not_ready" }].',
			),
		input_type: z
			.enum(['confirmation', 'single_choice', 'multiple_choice', 'text'])
			.optional()
			.describe(
				'Renders a structured picker instead of action buttons. Pair with options (for single/multiple_choice) or placeholder/multiline (for text). NOTE: setting input_type disables the free-text "Reply to agent" input — only set it when you want a structured picker.',
			),
		options: z
			.array(notificationOptionSchema)
			.optional()
			.describe(
				'Options for single_choice / multiple_choice input_type. MUST be a native JSON array of objects — do NOT stringify. Example: [{ "label": "Yes", "value": "yes" }, { "label": "No", "value": "no" }].',
			),
		question: z.string().optional(),
		placeholder: z.string().optional(),
		multiline: z.boolean().optional(),
		suggestion: z.string().optional(),
		urgency_label: z.string().optional(),
		meta_text: z.string().optional(),
		tags: z.array(z.string()).optional(),
	})
	.passthrough()

const optionalWorkspaceId = z
	.string()
	.uuid()
	.optional()
	.describe(
		'Workspace ID to operate in. If omitted, uses the default workspace (DEFAULT_WORKSPACE_ID). Call list_workspaces to discover available workspaces.',
	)

export const tools = {
	// ─── Get Started ─────────────────────────────────────────
	get_started: {
		description:
			'THE ONBOARDING TOOL FOR MASKIN. Call this whenever a user asks to set up, configure, initialize, or onboard a Maskin workspace. Lists available marketplace packages and installs one. Flow: (1) call with no args (or just workspace_id) to get a PREVIEW of available packages. (2) Ask the user which package they want and what to name the workspace. (3) Call again with { package_id, confirm: true, workspace_name? } to install.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			package_id: z
				.string()
				.uuid()
				.optional()
				.describe(
					'The catalog package ID to install. Get this from the preview list returned when called without confirm.',
				),
			workspace_name: z
				.string()
				.optional()
				.describe(
					'Rename the workspace on confirm. Use whatever the user told you — a product name, a team name, anything. Only applied when confirm is true.',
				),
			confirm: z
				.boolean()
				.optional()
				.describe(
					'Set true to install the chosen package. Without this, the tool returns the list of available packages.',
				),
		}),
	},

	// ─── Objects ─────────────────────────────────────────────
	create_objects: {
		description:
			'Create one or more objects (insights, bets, tasks) with optional relationships in a single atomic operation. For a single object, provide one node with no edges. For multiple related objects, use $id references in edges to link them. Edges can also reference existing object UUIDs to connect new objects to existing ones. Call get_workspace_schema first to discover valid statuses, metadata fields, and relationship types. Status defaults — insight: new|processing|clustered|scored|parked|discarded, bet: signal|qualified|define|active|live|succeeded|failed|paused, task: todo|in_progress|in_review|validated|done|discarded. To attach files to a created object, upload them first with create_file (or pick existing ones with list_files) and pass the returned ids in `file_ids` on the node. Attached files appear under the object in the UI and are returned alongside the object in get_objects. When referring to created or connected objects in human-facing output (comments, summaries, notifications, descriptions), use the object\'s title — not its UUID. Returned nodes include the title; edges include sourceTitle and targetTitle for the same reason. UUIDs should only appear in human-facing text when two objects share a near-identical title and disambiguation is needed — in that case append a short id suffix (e.g. "Bets and Threads v4 (ca957490)"). Use UUIDs freely inside tool arguments.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			nodes: z
				.array(
					z.object({
						$id: z.string().describe('Client-side temporary ID for cross-referencing in edges'),
						type: z.string().describe('Object type (e.g. insight, bet, task, meeting)'),
						title: z.string().optional(),
						content: z.string().optional(),
						status: z.string(),
						metadata: z
							.record(z.unknown())
							.optional()
							.describe(
								'Key-value metadata. Call get_workspace_schema to discover available fields and types.',
							),
						driver: z
							.string()
							.uuid()
							.optional()
							.describe('UUID of the driver actor responsible for this object'),
						file_ids: z
							.array(z.string().uuid())
							.optional()
							.describe(
								'IDs of existing files to attach to this object (upload first with create_file). Each becomes an `attached` relationship between the object and the file.',
							),
					}),
				)
				.min(1)
				.max(50)
				.describe('Objects to create'),
			edges: z
				.array(
					z.object({
						source: z
							.string()
							.describe('A $id from a node in this request, or a UUID of an existing object'),
						target: z
							.string()
							.describe('A $id from a node in this request, or a UUID of an existing object'),
						type: z
							.string()
							.describe('Relationship type: informs, breaks_into, blocks, relates_to, duplicates'),
					}),
				)
				.default([])
				.describe('Relationships to create between new and/or existing objects'),
		}),
	},
	get_objects: {
		description:
			'Get one or more objects by ID, each with all its relationships, connected objects, recent activity, and attached files. Returns the full context around each object: inbound/outbound relationships (each carrying sourceTitle and targetTitle), details of connected objects, the most recent events on the object (lifecycle changes plus comments — comments are events with action="commented" and content in event.data.content, replies link via event.data.parentEventId; comment events carry data.attachmentFileIds for any files the commenter attached), and a top-level `files` array with full metadata (id, name, mimeType, sizeBytes, url) for every file referenced by this object — both files attached directly to the object and files attached in comments. Cross-reference comment attachmentFileIds with the `files` array to get viewer URLs without an extra round-trip. When referring to these objects in human-facing output (comments, summaries, notifications, descriptions), use the object\'s title — not its UUID. UUIDs should only appear in human-facing text when two objects share a near-identical title and disambiguation is needed — in that case append a short id suffix (e.g. "Bets and Threads v4 (ca957490)"). Use UUIDs freely inside tool arguments.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			ids: z.array(z.string().uuid()).min(1).max(50).describe('Object IDs to fetch'),
		}),
	},
	update_objects: {
		description:
			'Update one or more objects and/or create relationships between existing objects. Provide updates to change object fields (title, content, status, metadata) and/or edges to create new relationships. To attach or detach files on an object, pass `attach_file_ids` (upload first with create_file) and/or `detach_file_ids` on the update entry — attached files appear under the object in the UI and are returned by get_objects. Either updates or edges (or both) must be provided. Call get_workspace_schema first to discover valid metadata fields and relationship types. Updated objects are returned with their title; created relationships include sourceTitle and targetTitle. When referring to objects in human-facing output (comments, summaries, notifications, descriptions), use the object\'s title — not its UUID. UUIDs should only appear in human-facing text when two objects share a near-identical title and disambiguation is needed — in that case append a short id suffix (e.g. "Bets and Threads v4 (ca957490)"). Use UUIDs freely inside tool arguments.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			updates: z
				.array(
					z.object({
						id: z.string().uuid(),
						title: z.string().optional(),
						content: z.string().optional(),
						status: z.string().optional(),
						metadata: z
							.record(z.unknown())
							.optional()
							.describe(
								'Key-value metadata. Call get_workspace_schema to discover available fields and types.',
							),
						attach_file_ids: z
							.array(z.string().uuid())
							.optional()
							.describe(
								'IDs of existing files to attach to this object (upload first with create_file). Each becomes an `attached` relationship; already-attached files are skipped.',
							),
						driver: z.string().uuid().nullable().optional().describe('Set or clear the driver'),
						detach_file_ids: z
							.array(z.string().uuid())
							.optional()
							.describe(
								'IDs of files currently attached to this object to detach. Removes the `attached` relationship row but leaves the file itself untouched (delete with delete_file if you also want to remove the file).',
							),
					}),
				)
				.default([])
				.describe('Objects to update, each with id and fields to change'),
			edges: z
				.array(
					z.object({
						source_id: z.string().uuid().describe('Source object UUID'),
						target_id: z.string().uuid().describe('Target object UUID'),
						type: z
							.string()
							.describe('Relationship type: informs, breaks_into, blocks, relates_to, duplicates'),
					}),
				)
				.default([])
				.describe('Relationships to create between existing objects'),
		}),
	},
	delete_object: {
		description: 'Delete an object by ID',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			id: z.string().uuid(),
		}),
	},
	list_objects: {
		description:
			'List insights, bets, and/or tasks in the workspace. Filter by type, status, or driver. Returns paginated results ordered by creation date.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			type: z.string().describe('Object type (e.g. insight, bet, task, meeting)').optional(),
			status: z.string().optional(),
			driver: z
				.string()
				.uuid()
				.optional()
				.describe('Filter to objects with this driver actor UUID'),
			limit: z.number().int().min(1).max(100).default(50),
			offset: z.number().int().min(0).default(0),
		}),
	},
	search_objects: {
		description:
			'Search objects by text in title or content, combined with optional type/status filters. Use this instead of list_objects when you need to find objects by keyword.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			q: z
				.string()
				.min(1)
				.describe('Search query — matches against title and content (case-insensitive)'),
			type: z.string().describe('Object type (e.g. insight, bet, task, meeting)').optional(),
			status: z.string().optional(),
			limit: z.number().int().min(1).max(100).default(20),
			offset: z.number().int().min(0).default(0),
		}),
	},
	list_relationships: {
		description:
			'List relationships with optional filters. Use `object_id` to fetch every relationship connected to an object regardless of direction (matches either source or target). Use `source_id` / `target_id` only when direction matters.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			object_id: z
				.string()
				.uuid()
				.optional()
				.describe(
					'Match relationships where this object is either the source or the target (direction-agnostic). Prefer this over source_id/target_id when you want every edge connected to an object.',
				),
			source_id: z.string().uuid().optional(),
			target_id: z.string().uuid().optional(),
			type: z.string().optional(),
		}),
	},
	delete_relationship: {
		description: 'Delete a relationship by ID',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			id: z.string().uuid(),
		}),
	},
	create_actor: {
		description:
			'Create a new actor (human or agent) and optionally add them to a workspace. Returns the actor details and API key (only shown once). If workspace_id is provided, the actor is added as a member with the given role. If auto_create_workspace is true (default for humans), a new workspace is created instead.',
		inputSchema: z.object({
			type: z.enum(['human', 'agent']),
			name: z.string().min(1),
			email: z.string().email().optional(),
			auto_create_workspace: z.boolean().optional(),
			workspace_id: z
				.string()
				.uuid()
				.optional()
				.describe('Add the new actor to this existing workspace'),
			role: z
				.enum(['owner', 'member', 'viewer'])
				.default('member')
				.describe(
					'Role when adding to a workspace: owner (full control), member (read/write), viewer (read-only)',
				),
			description: z
				.string()
				.max(80)
				.optional()
				.describe(
					'Short one-liner (max 80 chars) summarizing the actor. For agents this is shown on the Agents page list and sub-page so teammates can tell agents apart at a glance.',
				),
			system_prompt: z.string().optional(),
			tools: z.record(z.unknown()).optional(),
			llm_provider: z.string().optional(),
			llm_config: z.record(z.unknown()).optional(),
		}),
	},
	update_actor: {
		description:
			'Update an actor by ID. Can change name, email, description (short one-liner, max 80 chars), system_prompt / instructions (for agents and humans), tools configuration, memory (persistent key-value store), LLM provider, LLM config, and workspace skill attachments (attach_skill_ids / detach_skill_ids).',
		inputSchema: z.object({
			id: z.string().uuid(),
			name: z.string().min(1).optional(),
			email: z.string().email().optional(),
			description: z
				.string()
				.max(80)
				.optional()
				.describe('Short one-liner (max 80 chars) summarizing the actor.'),
			system_prompt: z.string().optional(),
			tools: z.record(z.unknown()).optional(),
			memory: z.record(z.unknown()).optional(),
			llm_provider: z.string().optional(),
			llm_config: z.record(z.unknown()).optional(),
			attach_skill_ids: z
				.array(z.string().uuid())
				.optional()
				.describe('Workspace skill IDs to attach to this actor.'),
			detach_skill_ids: z
				.array(z.string().uuid())
				.optional()
				.describe('Workspace skill IDs to detach from this actor.'),
		}),
	},
	regenerate_api_key: {
		description: 'Regenerate the API key for an actor. Returns the new key (only shown once).',
		inputSchema: z.object({
			id: z.string().uuid(),
		}),
	},
	list_actors: {
		description:
			"List actors (humans and agents). If workspace_id is provided, returns members of that workspace with their role. If omitted, returns actors across all workspaces the caller belongs to, each annotated with their workspace memberships. Each row includes the actor's short `description` (one-liner) — call `get_actor` for the full `system_prompt` (instructions), which is how to pick up context on a human teammate @mentioned in a comment. Results are paginated (default 50, max 100).",
		inputSchema: z.object({
			workspace_id: z
				.string()
				.uuid()
				.optional()
				.describe(
					'Optional workspace ID to scope the listing to. If omitted, returns actors across all workspaces the caller belongs to (each with their workspace memberships).',
				),
			limit: z.number().int().min(1).max(100).default(50),
			offset: z.number().int().min(0).default(0),
		}),
	},
	get_actor: {
		description:
			'Get an actor by ID — returns the full record including `description` (short one-liner) and `system_prompt` / instructions (longer context on who the actor is and how to work with them). When a human is @mentioned on a comment, call this to pick up their instructions and tailor your reply.',
		inputSchema: z.object({
			id: z.string().uuid(),
		}),
	},
	create_workspace: {
		description: 'Create a new workspace. The authenticated actor becomes the owner.',
		inputSchema: z.object({
			name: z.string().min(1),
			settings: z.record(z.unknown()).optional(),
		}),
	},
	update_workspace: {
		description: 'Update a workspace by ID (name and/or settings)',
		inputSchema: z.object({
			id: z.string().uuid(),
			name: z.string().min(1).optional(),
			settings: z.record(z.unknown()).optional(),
		}),
	},
	list_workspaces: {
		description:
			'List workspaces accessible to the authenticated actor. Use this to discover workspace IDs, which can be passed to any workspace-scoped tool via the workspace_id parameter.',
		inputSchema: z.object({}),
	},
	get_workspace_schema: {
		description:
			'Get the workspace schema: available statuses per object type, custom metadata field definitions (name, type, required, enum values), display names, and relationship types. Call this before creating or updating objects to know which metadata fields exist, what types they expect, and which values are valid. Optionally filter by object type. Types with Hero Card defaults or workspace overrides also include a `hero_card` annotation block on the response (`hero_card_context`, `hero_card_metas`, `primary_action`) describing how matching objects render in the Hero Card MCP widget.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			type: z
				.string()
				.optional()
				.describe(
					'Filter schema to a specific object type (e.g. insight, bet, task, meeting). If omitted, returns schema for all types.',
				),
		}),
	},
	add_workspace_member: {
		description:
			'Add an existing actor to a workspace. Use this to grant an agent or human access to a workspace. Requires the actor ID and workspace ID.',
		inputSchema: z.object({
			workspace_id: z.string().uuid().describe('The workspace to add the member to'),
			actor_id: z.string().uuid().describe('The actor to add as a member'),
			role: z
				.enum(['owner', 'admin', 'member'])
				.default('member')
				.describe('Role: owner (full control), admin (manage members), member (read/write)'),
		}),
	},
	// ─── Workspace Schema Editing (W1) ──────────────────────
	// Mutate `settings.field_definitions[type]` so agents can author/extend
	// the workspace schema from chat. Mirrors the web schema editor at
	// apps/web/src/routes/_authed/$workspaceId/settings/objects/$propertyName.tsx —
	// each tool does a read-modify-write on the workspace because the PATCH
	// endpoint shallow-merges `settings`.
	create_workspace_field: {
		description:
			'Add a new metadata field to a workspace object type (e.g. insight, bet, task). Mirrors the web schema editor — once added, the field is available via get_workspace_schema and accepted by create_objects / update_objects metadata. Field names must be unique within a type.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			type: z
				.string()
				.min(1)
				.describe('Object type to attach the field to (e.g. "insight", "bet", "task").'),
			name: z.string().min(1).describe('Field name. Must be unique within the type.'),
			field_type: z
				.enum(['text', 'number', 'date', 'enum', 'boolean'])
				.describe(
					'Field value type. Use "enum" for a fixed set of values (provide values[]); "text" for free text; "number"/"date"/"boolean" for typed scalars.',
				),
			required: z
				.boolean()
				.optional()
				.describe('When true, the field is required on objects of this type.'),
			values: z
				.array(z.string().min(1))
				.optional()
				.describe('Allowed values for an enum field. Required when field_type is "enum".'),
		}),
	},
	update_workspace_field: {
		description:
			'Update an existing metadata field on a workspace object type. Use this to rename, change the field type, toggle required, or replace the full enum value list. Pass only the fields you want to change.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			type: z.string().min(1).describe('Object type the field belongs to.'),
			name: z.string().min(1).describe('Existing field name to update.'),
			new_name: z
				.string()
				.min(1)
				.optional()
				.describe('Optional rename. Must remain unique within the type.'),
			field_type: z
				.enum(['text', 'number', 'date', 'enum', 'boolean'])
				.optional()
				.describe('Optional new field type.'),
			required: z.boolean().optional().describe('Optional new required flag.'),
			values: z
				.array(z.string().min(1))
				.optional()
				.describe(
					'Optional full replacement list of enum values. Pass an empty array to clear. Use add/remove_workspace_enum_value to mutate one value without losing others.',
				),
		}),
	},
	delete_workspace_field: {
		description:
			'Remove a metadata field from a workspace object type. Existing objects keep any data they previously stored under this field; new objects can no longer set it. Idempotent — deleting a field that does not exist returns success.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			type: z.string().min(1).describe('Object type the field belongs to.'),
			name: z.string().min(1).describe('Field name to delete.'),
		}),
	},
	add_workspace_enum_value: {
		description:
			'Append an allowed value to an enum field on a workspace object type. Fails if the field is not of type "enum". Idempotent — adding an existing value is a no-op.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			type: z.string().min(1).describe('Object type the field belongs to.'),
			name: z.string().min(1).describe('Enum field name.'),
			value: z.string().min(1).describe('Value to add.'),
		}),
	},
	remove_workspace_enum_value: {
		description:
			'Remove an allowed value from an enum field on a workspace object type. Fails if the field is not of type "enum". Idempotent — removing a missing value is a no-op. Existing objects that previously stored this value keep their stored value; only new writes are constrained.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			type: z.string().min(1).describe('Object type the field belongs to.'),
			name: z.string().min(1).describe('Enum field name.'),
			value: z.string().min(1).describe('Value to remove.'),
		}),
	},
	// ─── Workspace Skills ─────────────────────────────────────
	// Shared, workspace-scoped skills that any agent in the workspace can be given.
	// NOT the same as per-agent skills (those live under an agent's own file store).
	list_workspace_skills: {
		description:
			'List shared workspace skills — SKILL.md files stored once per workspace and attachable to any agent in the workspace. These are workspace-scoped and reusable across agents, NOT per-agent skills. Returns lightweight rows without the SKILL.md body; call get_workspace_skill to fetch full content.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
		}),
	},
	get_workspace_skill: {
		description:
			'Get a shared workspace skill by name, including its full SKILL.md content. Workspace-scoped and attachable to any agent in the workspace — NOT a per-agent skill.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			name: skillNameSchema.describe(
				'Skill name. Lowercase letters, numbers, and hyphens only; max 64 chars.',
			),
		}),
	},
	create_workspace_skill: {
		description:
			'Create a shared workspace skill. The skill is stored once in the workspace and can be attached to any number of agents afterwards — NOT a per-agent skill. Content must be valid SKILL.md (markdown with optional YAML frontmatter); the server parses the frontmatter to extract the description.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			name: skillNameSchema.describe(
				'Skill name. Lowercase letters, numbers, and hyphens only; max 64 chars. Must be unique within the workspace.',
			),
			content: z
				.string()
				.min(1)
				.describe(
					'Full SKILL.md content. Optional YAML frontmatter (--- name, description, ... ---) is parsed for the description.',
				),
		}),
	},
	update_workspace_skill: {
		description:
			'Replace the content of an existing shared workspace skill. Affects every agent the skill is attached to. These are workspace-scoped, reusable skills — NOT per-agent skills. The server re-parses frontmatter for an updated description.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			name: skillNameSchema.describe('Name of the workspace skill to update.'),
			content: z
				.string()
				.min(1)
				.describe('New SKILL.md content. Replaces the existing body entirely.'),
		}),
	},
	delete_workspace_skill: {
		description:
			'Delete a shared workspace skill. Any agent_skills attachments are removed in cascade. These are workspace-scoped skills — NOT per-agent skills.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			name: skillNameSchema.describe('Name of the workspace skill to delete.'),
		}),
	},
	// ─── Files ───────────────────────────────────────────────
	create_file: {
		description:
			'Author a file in the workspace and store it in object storage. Use this to publish design docs, strategy notes, generated reports, or any document you want a workspace member to be able to open. The response includes a `url` field — share this URL anywhere (Slack, email, a comment) and any workspace member can open it in a browser to view the file. For text content (markdown, HTML, JSON, code), pass `content` as a raw string — the `encoding` field defaults to "utf8". For binary content (images, PDFs, archives), set `encoding` to "base64" and pass `content` as base64-encoded bytes. Max 10 MB after decoding. Use the real `mime_type` (e.g. text/markdown, text/html, application/pdf, image/png); the viewer renders markdown inline and offers download for everything else.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			name: z
				.string()
				.min(1)
				.max(255)
				.describe('Display name including extension, e.g. "launch-plan.md".'),
			description: z
				.string()
				.max(1000)
				.optional()
				.describe('Optional one-line summary surfaced in the file list.'),
			mime_type: z
				.string()
				.describe(
					'IANA MIME type of the content, e.g. "text/markdown", "text/html", "application/pdf", "image/png".',
				),
			content: z
				.string()
				.describe(
					'File content. For text/markdown/HTML/JSON, pass the raw string and leave `encoding` at the default. For binary files, set `encoding` to "base64" and pass base64-encoded bytes. Max 10 MB.',
				),
			encoding: z
				.enum(['base64', 'utf8'])
				.optional()
				.describe(
					'Encoding of `content`. Defaults to "utf8" — pass markdown/HTML/JSON as a normal string. Use "base64" for binary files (images, PDFs, archives).',
				),
		}),
	},
	list_files: {
		description: 'List files in the workspace, newest first. Pass `q` to filter by name substring.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			q: z.string().optional().describe('Case-insensitive substring match on file name.'),
			limit: z.number().int().min(1).max(200).optional(),
			offset: z.number().int().min(0).optional(),
		}),
	},
	get_file: {
		description:
			'Get a single file with its content and a viewer URL. The response includes an `encoding` field: "utf8" for text MIME types (markdown, HTML, JSON, code) means `content` is the raw string; "base64" for binary types means `content` is base64-encoded bytes. The response also includes an `annotations` array — pinned review comments humans left on the rendered file, each with a CSS `selector` and normalized `bounds` identifying the element, plus the human\'s `comment`. Read these to see exactly what a reviewer flagged and where. Use this when you need to read, summarise, act on review feedback, or hand the URL to a user.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			id: z.string().uuid().describe('File ID.'),
		}),
	},
	update_file: {
		description:
			'Update a file. Pass any subset of name, description, mime_type, content. Updating content re-uploads the bytes; other fields update metadata only. For text content pass `content` as a raw string (encoding defaults to "utf8"); for binary content set `encoding` to "base64". At least one field must be provided.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			id: z.string().uuid().describe('File ID.'),
			name: z.string().min(1).max(255).optional(),
			description: z.string().max(1000).nullable().optional(),
			mime_type: z.string().optional(),
			content: z
				.string()
				.optional()
				.describe(
					'New file content. For text, pass the raw string and leave `encoding` at the default. For binary files, set `encoding` to "base64" and pass base64-encoded bytes. Max 10 MB.',
				),
			encoding: z
				.enum(['base64', 'utf8'])
				.optional()
				.describe('Encoding of `content`. Defaults to "utf8". Use "base64" for binary files.'),
		}),
	},
	delete_file: {
		description: 'Delete a file from the workspace. Bytes are removed from storage.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			id: z.string().uuid().describe('File ID.'),
		}),
	},
	get_events: {
		description:
			'Get the workspace activity log. Every mutation (create, update, delete) is recorded as an event. Use this to see what changed, track agent activity, or audit changes. Pass `id` to fetch a single event by its numeric event_id (e.g. the one quoted in a trigger prompt). Filter by entity_type (object|relationship|integration) and action (created|updated|deleted|status_changed).',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			id: z
				.number()
				.int()
				.positive()
				.optional()
				.describe('Numeric event_id. Returns at most one event when set.'),
			entity_type: z.string().optional(),
			action: z.string().optional(),
			limit: z.number().int().min(1).max(100).default(50),
		}),
	},
	get_comments: {
		description:
			'Get comments posted on a specific object, newest first. Comments are events with action="commented" on entity_type="object". Threading is expressed via data.parentEventId on each row — replies reference the event id of the comment they reply to.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			entity_id: z.string().uuid().describe('Object ID to fetch comments for.'),
			limit: z.number().int().min(1).max(100).default(50),
			offset: z.number().int().min(0).default(0),
		}),
	},
	create_comment: {
		description: `Primary channel for agent-to-human communication. Post comments here for status updates, questions, findings, decisions, blockers, and anything else a human needs to see. Do NOT bury that dialogue in \`bet.content\`, \`task.content\`, or object titles — those fields are the durable spec, not the conversation, and humans don't scan them for new information. If you're tempted to edit a description to "let someone know" something, that belongs in a comment.\n\nWrite it like a Slack message, not a report: one thought per comment, plain conversational language, direct. No headers, no bold labels, no bulleted sections, no walls of text. If a thought is long, split it into multiple short comments or use parent_event_id to thread a reply. When referencing another object in human-facing text, use a markdown link \`[title](link)\` — never paste partial UUIDs.\n\nHard limit: ${COMMENT_MAX_LENGTH} characters — the API rejects anything over the limit with a validation error. Set parent_event_id to thread a reply under an existing comment (use the id returned by get_comments). Include mentions as an array of actor UUIDs — for each @mentioned agent actor, the server creates a needs_input notification AND spawns a session that lets the agent read the comment and reply on the same object. @mention human actors whenever you need their input, decision, or attention: they get a notification about the comment, so this is the right way to pull a human into the loop. Don't mention humans gratuitously, but don't hesitate to mention them when their input would actually unblock you. To attach files, first upload them with create_file (or pick existing ones with list_files) and pass the returned file ids in attachment_file_ids (max ${COMMENT_MAX_ATTACHMENTS}). Attached files appear as clickable cards under the posted comment. To prompt the human for a structured decision, pass metadata: { chips: ["Option A", "Option B", "Skip"] } — up to 5 string options, each up to 20 characters. The UI renders them as quick-reply buttons the human can tap, with a free-text fallback. Their reply is threaded under this comment.`,
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			...createCommentSchema.shape,
		}),
	},
	create_trigger: {
		description:
			"Create an automation trigger that fires an agent on a schedule or event. Cron triggers run periodically (config: { expression: '*/5 * * * *' }). Event triggers fire on mutations (config: { entity_type: 'object', action: 'created', filter: { ... } }). The target_actor_id must be an agent actor.",
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			name: z.string(),
			type: z.enum(['cron', 'event']),
			config: z
				.record(z.unknown())
				.describe(
					'For cron triggers: { "expression": "*/5 * * * *" }. For event triggers: { "entity_type": "object", "action": "created"|"updated"|"deleted"|"status_changed", "filter": { ... } }',
				),
			action_prompt: z.string(),
			target_actor_id: z.string().uuid(),
			enabled: z.boolean().default(true),
		}),
	},
	update_trigger: {
		description:
			'Update a trigger by ID. Can change name, schedule/event config, action_prompt, target agent, or enabled/disabled state.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			id: z.string().uuid(),
			name: z.string().min(1).optional(),
			config: z.record(z.unknown()).optional(),
			action_prompt: z.string().min(1).optional(),
			target_actor_id: z.string().uuid().optional(),
			enabled: z.boolean().optional(),
		}),
	},
	delete_trigger: {
		description: 'Delete a trigger by ID',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			id: z.string().uuid(),
		}),
	},
	list_triggers: {
		description: 'List all triggers in the workspace. Results are paginated (default 50, max 100).',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			limit: z.number().int().min(1).max(100).default(50),
			offset: z.number().int().min(0).default(0),
		}),
	},
	// ─── Sessions ────────────────────────────────────────────
	create_session: {
		description:
			'Spawn a containerized agent execution session. Creates an ephemeral Docker container running the specified agent (Claude Code, Codex, or custom). The agent executes the action_prompt autonomously. Use get_session to check status, get_session_logs to read output. For a blocking alternative that waits for completion, use run_agent instead.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			actor_id: z.string().uuid().describe('The actor that will run inside the session'),
			action_prompt: z.string().min(1).describe('The prompt/task for the agent to execute'),
			config: z
				.object({
					base_image: z.string().optional(),
					runtime: z.enum(['claude-code', 'codex', 'custom']).optional(),
					runtime_config: z.record(z.unknown()).optional(),
					timeout_seconds: z.number().int().min(30).max(3600).optional(),
					memory_mb: z.number().int().min(256).max(8192).optional(),
					cpu_shares: z.number().int().min(256).max(4096).optional(),
					env_vars: z.record(z.string()).optional(),
				})
				.optional()
				.describe('Container configuration overrides'),
			trigger_id: z.string().uuid().optional().describe('Trigger that initiated this session'),
			auto_start: z.boolean().default(true).describe('Start the session immediately'),
			source_session_id: z
				.string()
				.uuid()
				.optional()
				.describe(
					'ID of a prior session whose workspace should be restored at startup. Use this when continuing a task that a previous session started but could not finish (e.g. code was written but could not be pushed).',
				),
		}),
	},
	list_sessions: {
		description: 'List sessions with optional filters',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			status: z
				.enum([
					'pending',
					'starting',
					'running',
					'snapshotting',
					'paused',
					'completed',
					'failed',
					'timeout',
				])
				.optional(),
			actor_id: z.string().uuid().optional(),
			limit: z.number().int().min(1).max(100).default(20),
			offset: z.number().int().min(0).default(0),
		}),
	},
	get_session: {
		description:
			'Get session details by ID. Optionally include log output from the container (stdout/stderr/system).',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			id: z.string().uuid(),
			include_logs: z
				.boolean()
				.default(false)
				.describe('Include log output from the session container'),
			log_limit: z
				.number()
				.int()
				.min(1)
				.max(500)
				.default(100)
				.describe('Max log lines to return (only used when include_logs is true)'),
		}),
	},
	stop_session: {
		description: 'Stop a running session',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			id: z.string().uuid(),
		}),
	},
	pause_session: {
		description: 'Pause a running session and save a snapshot for later resumption',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			id: z.string().uuid(),
		}),
	},
	resume_session: {
		description: 'Resume a previously paused session from its snapshot',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			id: z.string().uuid(),
		}),
	},
	run_agent: {
		description:
			'High-level tool: create a container agent session, wait for completion, and return the result with logs. This is a blocking call that polls until the session reaches a terminal state (completed/failed/timeout). Use create_session + get_session + get_session_logs separately if you need non-blocking execution.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			actor_id: z.string().uuid().describe('The agent actor that will execute the task'),
			action_prompt: z.string().min(1).describe('The instruction for the agent'),
			config: z
				.object({
					runtime: z.enum(['claude-code', 'codex', 'custom']).optional(),
					timeout_seconds: z.number().int().min(30).max(3600).optional(),
				})
				.optional()
				.describe('Container configuration overrides'),
			poll_interval_seconds: z
				.number()
				.int()
				.min(2)
				.max(30)
				.default(5)
				.describe('How often to check session status'),
			timeout_seconds: z
				.number()
				.int()
				.min(30)
				.max(3700)
				.default(660)
				.describe('Maximum time to wait before giving up (should exceed session timeout)'),
		}),
	},

	// ─── Notifications ───────────────────────────────────────
	create_notification: {
		description:
			'Create a notification for a human in the workspace. Use when you need human input to make a decision that you cannot make yourself. Use this tool sparingly — before creating a new notification, always call list_notifications to check whether a similar pending notification already exists that can be updated via update_notification instead. Pass session_id when the agent expects to be resumed with the human\'s reply — this enables the free-text "Reply to agent" input in the UI. To render clickable buttons, pass metadata.actions as a NATIVE JSON array (not a stringified one). For a structured picker (radio/checkbox/text), set metadata.input_type and metadata.options as a NATIVE JSON array.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			type: z
				.enum(['needs_input', 'recommendation', 'good_news', 'alert'])
				.describe(
					'needs_input: agent is blocked and needs a decision. recommendation: agent found something worth attention. good_news: positive outcome to share. alert: something needs attention.',
				),
			title: z.string().min(1),
			content: z.string().optional(),
			metadata: notificationMetadataInput
				.optional()
				.describe(
					'Structured UI data. Known fields: actions, input_type, options, question, placeholder, multiline, suggestion, urgency_label, meta_text, tags. Other keys pass through.',
				),
			source_actor_id: z.string().uuid().describe('The agent actor creating this notification'),
			target_actor_id: z
				.string()
				.uuid()
				.optional()
				.describe('Specific human to notify. Omit to broadcast to all workspace members.'),
			object_id: z
				.string()
				.uuid()
				.optional()
				.describe('Related object (insight, bet, or task) this notification is about'),
			session_id: z
				.string()
				.uuid()
				.optional()
				.describe(
					'Session that created this notification. When set (and metadata.input_type is NOT set), the UI renders a free-text "Reply to agent" input that routes the reply back to this session.',
				),
		}),
	},
	list_notifications: {
		description: 'List notifications in the workspace, optionally filtered by status or type.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			status: z
				.enum(['pending', 'seen', 'resolved', 'dismissed'])
				.optional()
				.describe('Filter by notification status'),
			type: z.enum(['needs_input', 'recommendation', 'good_news', 'alert']).optional(),
			limit: z.number().int().min(1).max(100).default(50),
			offset: z.number().int().min(0).default(0),
		}),
	},
	get_notification: {
		description: 'Get a single notification by ID',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			id: z.string().uuid(),
		}),
	},
	update_notification: {
		description:
			'Update a notification by ID. Can change status (pending, seen, resolved, dismissed) and/or metadata.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			id: z.string().uuid(),
			status: z
				.enum(['pending', 'seen', 'resolved', 'dismissed'])
				.optional()
				.describe('New status for the notification'),
			metadata: notificationMetadataInput
				.optional()
				.describe(
					'Metadata to update on the notification. Same shape as create_notification.metadata — native arrays for actions/options, do NOT stringify.',
				),
		}),
	},
	delete_notification: {
		description: 'Delete a notification by ID',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			id: z.string().uuid(),
		}),
	},
	// ─── Subscriptions ────────────────────────────────────────
	subscribe: {
		description:
			'Subscribe the current actor to an entity (e.g. an object) so they receive unread counts when others comment. Use entity_type="object" and entity_id=<object_id>. Subscription is idempotent — a no-op if the actor is already subscribed.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			entity_type: z.enum(['object']),
			entity_id: z.string().uuid(),
		}),
	},
	unsubscribe: {
		description:
			"Unsubscribe the current actor from an entity. Idempotent — a no-op if the actor wasn't subscribed.",
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			entity_type: z.enum(['object']),
			entity_id: z.string().uuid(),
		}),
	},
	list_subscribers: {
		description:
			'List the actors subscribed to an entity (object). Useful for showing watchers on an object.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			entity_type: z.enum(['object']),
			entity_id: z.string().uuid(),
		}),
	},
	mark_read: {
		description:
			'Mark an entity as read up to a given event id. last_event_id should be the highest event id the actor has seen for this entity — the server will never move the high-water-mark backward.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			entity_type: z.enum(['object']),
			entity_id: z.string().uuid(),
			last_event_id: z.number().int().positive(),
		}),
	},
	list_unread: {
		description:
			'List entities the current actor is subscribed to with unread activity (comments newer than the actor\'s last_read_event_id). Returns object summaries inline when entity_type="object".',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			entity_type: z.enum(['object']).optional(),
		}),
	},
	// ─── Integrations ─────────────────────────────────────────
	list_integrations: {
		description: 'List integrations connected to the workspace',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
		}),
	},
	list_integration_providers: {
		description: 'List available integration providers and their supported events',
		inputSchema: z.object({}),
	},
	connect_integration: {
		description:
			'Start an integration connection flow for a provider (e.g. "github"). Returns an install_url that must be opened in a browser to complete the OAuth/installation flow. The callback is handled automatically by the server.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			provider: z
				.string()
				.describe(
					'Provider name (e.g. "github"). Call list_integration_providers to see available providers.',
				),
		}),
	},
	disconnect_integration: {
		description: 'Disconnect (revoke) an integration by ID',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			id: z.string().uuid(),
		}),
	},
	// ─── LLM API Keys ─────────────────────────────────────────
	set_llm_api_key: {
		description:
			"Save (or replace) a workspace LLM API key. Stored in workspace settings alongside any other providers. Returns { success, provider, last4 } — the full key is never echoed back. The key is stored as-is with no server-side validation against the provider; use the UI at /settings/keys if you need a live validation check. Mirrors the 'LLM API Keys' inputs in Settings → Keys.",
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			provider: z.enum(['anthropic', 'openai']),
			api_key: z.string().min(1).describe('The API key (e.g. "sk-ant-..." or "sk-...").'),
		}),
	},
	get_llm_api_keys: {
		description:
			"Report which LLM API keys are configured for the workspace. Returns { anthropic: { set, last4? }, openai: { set, last4? } } — never the full key. Mirrors the 'LLM API Keys' status in Settings → Keys.",
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
		}),
	},
	delete_llm_api_key: {
		description:
			'Remove a workspace LLM API key for a single provider. Other providers are left untouched.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			provider: z.enum(['anthropic', 'openai']),
		}),
	},
	// ─── Claude Subscription ──────────────────────────────────
	import_claude_subscription: {
		description:
			"Import Claude Pro/Max/Teams subscription tokens for the workspace (from ~/.claude/.credentials.json). Stored encrypted; used as the preferred auth for sandboxed Claude Code runs. Mirrors the 'Claude Subscription → Import credentials' action in Settings → Keys.",
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			access_token: z.string().min(1),
			refresh_token: z.string().min(1),
			expires_at: z.number().describe('Unix ms timestamp when the access token expires.'),
			subscription_type: z.string().optional().describe('e.g. "pro", "max", "teams".'),
			scopes: z.array(z.string()).optional(),
		}),
	},
	get_claude_subscription_status: {
		description:
			'Check Claude subscription connection status for the workspace. Returns { connected, valid, subscription_type?, expires_at? } — never the tokens themselves.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
		}),
	},
	disconnect_claude_subscription: {
		description: 'Disconnect the Claude subscription for the workspace (removes stored tokens).',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
		}),
	},
	// ─── Extensions ──────────────────────────────────────────
	list_extensions: {
		description:
			'List all available extensions and their status in the workspace. Returns registered extensions (e.g. "work") and any custom extensions defined in the workspace. Each extension bundles one or more object types with statuses, fields, and relationship types. Call this to discover what you can enable or create.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
		}),
	},
	create_extension: {
		description:
			'Add an extension to the workspace. Two modes: (1) Enable a registered extension by ID (e.g. "work"). (2) Create a custom extension — pass id, name, and object_types to define new types from scratch. Call list_extensions first to see available extensions.',
		inputSchema: z.object({
			workspace_id: z.string().uuid().describe('Workspace to add the extension to'),
			id: z
				.string()
				.regex(/^[a-z][a-z0-9_]*$/)
				.describe(
					'Extension ID. For registered extensions: "work". For custom: any lowercase identifier.',
				),
			name: z
				.string()
				.optional()
				.describe(
					'Human-readable name for a custom extension (e.g. "My CRM"). Not needed when installing a known extension.',
				),
			object_types: z
				.array(
					z.object({
						type: z
							.string()
							.regex(/^[a-z][a-z0-9_]*$/)
							.describe('Type identifier (e.g. "lead", "meeting_note")'),
						display_name: z.string().describe('Human-readable name (e.g. "Lead")'),
						statuses: z.array(z.string()).min(1).describe('Valid statuses for this type'),
						fields: z
							.array(
								z.object({
									name: z.string(),
									type: z.enum(['text', 'number', 'date', 'enum', 'boolean']),
									required: z.boolean().default(false),
									values: z
										.array(z.string())
										.optional()
										.describe('Allowed values (only for enum type)'),
								}),
							)
							.default([])
							.describe('Custom metadata fields for this type'),
						relationship_types: z
							.array(z.string())
							.optional()
							.describe('Relationship types to add for this type'),
					}),
				)
				.optional()
				.describe(
					'Object type definitions for a custom extension. Not needed when installing a known extension by ID.',
				),
		}),
	},
	update_extension: {
		description:
			'Update an extension in the workspace. Use this to enable/disable an extension (set enabled: true/false) or to update the object type definitions of a custom extension (modify statuses, fields, display names).',
		inputSchema: z.object({
			workspace_id: z.string().uuid(),
			id: z.string().describe('Extension ID to update'),
			enabled: z
				.boolean()
				.optional()
				.describe('Set to false to disable the extension, true to re-enable it'),
			object_types: z
				.array(
					z.object({
						type: z.string().describe('The type identifier to update'),
						display_name: z.string().optional().describe('New display name'),
						statuses: z
							.array(z.string())
							.min(1)
							.optional()
							.describe('New status list (replaces existing)'),
						fields: z
							.array(
								z.object({
									name: z.string(),
									type: z.enum(['text', 'number', 'date', 'enum', 'boolean']),
									required: z.boolean().default(false),
									values: z.array(z.string()).optional(),
								}),
							)
							.optional()
							.describe('New field definitions (replaces existing)'),
						relationship_types: z
							.array(z.string())
							.optional()
							.describe('Additional relationship types to add'),
					}),
				)
				.optional()
				.describe(
					'Updated object type definitions (PATCH semantics — only provided fields are changed)',
				),
		}),
	},
	delete_extension: {
		description:
			'Remove an extension from the workspace. Deletes its object type definitions from workspace settings. Existing objects of those types are preserved but no new objects can be created with those types. Cannot delete types provided by registered extensions like "work" — disable them instead with update_extension.',
		inputSchema: z.object({
			workspace_id: z.string().uuid(),
			id: z
				.string()
				.describe('Extension ID to remove. Pass the extension ID, not individual type names.'),
		}),
	},

	get_bet_widget_metrics: {
		description:
			"Pull the MCP widget UX bet's live success and kill metrics for the workspace: rolling click-through rate over the first 200 bet renders, the first-50 kill window, and the 48h rolling render-error rate. Renders sent by agents are excluded so this number matches the success/kill criteria on the bet. Read-only; does not produce any telemetry rows. Use this when you need evidence on whether the widget UX bet is meeting its CTR target or has tripped a kill criterion, without writing a bespoke SQL query.",
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
		}),
	},

	record_widget_event: {
		description:
			'INTERNAL — called by rendered MCP widgets (Hero Card) to report click-through, render success, and render failure events. Powers the bet success metric (click-through rate on Open in Maskin) and the 48h rolling render-error kill criterion. Do not call from an agent directly.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			widget_name: z.string().describe('Widget bundle name, e.g. "hero-card".'),
			event: z
				.enum(['click_through', 'render_success', 'render_error'])
				.describe('What happened on the widget.'),
			tool_name: z.string().describe('The MCP tool whose response produced this widget render.'),
			card_kind: z
				.enum(['single', 'list', 'empty'])
				.describe('Result shape — single object, multi-row list, or empty state.'),
			object_type: z.string().optional().describe('Object type when card_kind=single.'),
			object_id: z.string().optional().describe('Object id when card_kind=single.'),
		}),
	},
} as const
