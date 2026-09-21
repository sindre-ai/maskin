import {
	MESSAGE_MAX_LENGTH,
	createCommentSchema,
	messageMetadataSchema,
	notificationActionSchema,
	notificationOptionSchema,
	skillNameSchema,
} from '@maskin/shared'
import { z } from 'zod'

// Loop status enum exposed by the MCP `create_loop` / `update_loop` tools.
// This is intentionally scoped to the MCP surface — it matches what the
// server-side per-workspace status validator (see `apps/dev/src/routes/objects.ts`,
// PATCH `/objects/:id`) actually accepts today, which had drifted from the
// shared `LOOP_STATUSES` constant in `@maskin/shared`. Ladder is
// `draft` → `pilot` → `supervised` → `live`, with `paused` reachable from any
// live rung and `archived` a terminal retirement state.
const MCP_LOOP_STATUSES = ['draft', 'pilot', 'supervised', 'live', 'paused', 'archived'] as const

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

// Used by writes/reads that create or enumerate ambiguously-scoped
// resources (a brand-new loop with no existing id to inherit a workspace
// from, or an object listing/creation call) with side effects or result sets
// that are expensive to get wrong. Requiring an explicit workspace_id here —
// instead of silently falling back to DEFAULT_WORKSPACE_ID like tools that
// operate on an already-identified resource — means a call can never land in
// or leak from the wrong workspace by omission.
const requiredWorkspaceId = z
	.string()
	.uuid()
	.describe('Workspace ID to operate in. Call list_workspaces to discover available workspaces.')

// Single agent-facing param covering everything needed to run an agent on a
// specific LLM. The actor record still stores provider and config as two
// separate columns server-side — the MCP layer splits `provider` back out
// before calling the API, and merges the two columns back into this same
// shape on the way out, so create_actor/update_actor responses mirror what
// you send in.
const actorLlmConfigSchema = z
	.object({
		provider: z
			.string()
			.optional()
			.describe('LLM provider to run this agent on, e.g. "anthropic", "openai".'),
		model: z.string().optional().describe('Model identifier to use, e.g. "claude-opus-4-6".'),
	})
	.passthrough()
	.optional()
	.describe(
		"Agents only — not used for humans. Configures which LLM this agent runs on: provider and model. Every agent runs on its workspace's connected LLM credentials (the Claude subscription or API key connected under Settings → Keys) — per-agent API key overrides are not supported here. Extra provider-specific keys are passed through as-is.",
	)

/**
 * Inline loop-step definition accepted by create_loop / update_loop. Each step
 * becomes an ordinary trigger (POST /api/triggers) targeting an agent actor,
 * and its id is appended to the loop's `metadata.trigger_ids`. The `when`
 * union mirrors the two trigger types: `{ cron }` → a cron trigger,
 * `{ object_type, action, filter? }` → an event trigger that fires as objects
 * of that type change state. Both branches are `.strict()` so a step can't
 * mix cron and event fields — the backend's `entity_type` is required on
 * event triggers, so `object_type` is required here too rather than silently
 * accepting a shape the backend would reject.
 */
const loopStepSchema = z.object({
	name: z.string().min(1).describe('Step name, e.g. "Qualify new lead" or "Capture learnings".'),
	agent_id: z
		.string()
		.uuid()
		.describe(
			"Agent actor that performs this step. Must be an agent, not a human — a human is put on the loop by having a step's agent notify/@mention them. See the tool description for how to pick or create the right agent.",
		),
	prompt: z
		.string()
		.min(1)
		.describe(
			'Instruction the agent receives when the step fires. The triggering event (including the changed object) is appended automatically.',
		),
	when: z
		.union([
			z
				.object({
					cron: z
						.string()
						.min(1)
						.describe('Cron expression, e.g. "*/30 * * * *" — the step runs on this schedule.'),
				})
				.strict(),
			z
				.object({
					object_type: z
						.string()
						.min(1)
						.describe(
							'Object type whose events fire this step — any type, including custom ones (call get_workspace_schema to see them).',
						),
					action: z
						.enum(['created', 'updated', 'status_changed', 'deleted'])
						.describe('Which mutation fires the step. `status_changed` drives most loop steps.'),
					filter: z
						.record(z.unknown())
						.optional()
						.describe(
							'Equality filter evaluated against the current object row, e.g. { "status": "qualified" } or { "metadata.segment": "enterprise" }. Dot paths reach into metadata.',
						),
				})
				.strict(),
		])
		.describe(
			'When the step fires — exactly one of: { "cron": "<expression>" } for a schedule, or { "object_type", "action", "filter"? } to react to objects changing state. Do not mix fields from both forms; extra/mismatched keys are rejected.',
		),
})

/**
 * Per-loop map of which statuses mean "done" for objects flowing through the
 * loop, e.g. { "lead": ["won", "lost"] }. This is what makes loop stats work
 * for workspace-defined (custom) object types — without it only built-in types
 * have known terminal statuses.
 */
const closedStatusesSchema = z
	.record(z.array(z.string().min(1)))
	.optional()
	.describe(
		'Map of object type → statuses that count as "done"/closed for THIS loop, e.g. {"lead": ["won", "lost"]}. Required for correct closed counts when custom object types flow through the loop; built-in types (bet/task/insight) have sensible defaults. Types and statuses are validated against the workspace schema.',
	)

/**
 * Equality filter on custom metadata fields — object types define their own
 * fields at runtime (see `create_workspace_field`), so this is a generic
 * field→value map rather than a static enumeration. Forwarded to the API as
 * `metadata.<field>=<value>` query params (see `apps/dev/src/routes/objects.ts`).
 */
const metadataEqSchema = z
	.record(z.string(), z.string())
	.optional()
	.describe(
		'Equality filter on custom metadata fields, e.g. {"segment": "enterprise"}. Call get_workspace_schema first to see which fields exist per object type.',
	)

export const tools = {
	// ─── Get Started ─────────────────────────────────────────
	get_started: {
		description:
			'THE ONBOARDING TOOL FOR MASKIN. Call this whenever a user asks to set up, configure, initialize, or onboard a Maskin workspace. Lists available marketplace loops and installs one. Flow: (1) call with no args (or just workspace_id) to get a PREVIEW of available loops. (2) Ask the user which loop they want and what to name the workspace. (3) Call again with { loop_id, confirm: true, workspace_name? } to install.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			loop_id: z
				.string()
				.uuid()
				.optional()
				.describe(
					'The marketplace loop ID to install. Get this from the preview list returned when called without confirm.',
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
					'Set true to install the chosen loop. Without this, the tool returns the list of available loops.',
				),
		}),
	},

	// ─── Objects ─────────────────────────────────────────────
	create_objects: {
		description:
			'Create one or more objects with optional relationships in a single atomic operation. Use get_workspace_schema to see more details on objects and relationships. To create a Loop — a persistent closed-loop agent process — use the dedicated create_loop tool instead, which wires the trigger and membership metadata correctly. For a single object, provide one node with no edges. For multiple related objects, use $id references in edges to link them. Edges can also reference existing object UUIDs to connect new objects to existing ones. ALWAYS call get_workspace_schema first — it returns the authoritative, live list of valid statuses per object type, metadata fields, and relationship types for this workspace (these are workspace-configurable, so they vary between workspaces and cannot be assumed). To attach files to a created object, upload them first with create_file (or pick existing ones with list_files) and pass the returned ids in `file_ids` on the node. Attached files appear under the object in the UI and are returned alongside the object in get_objects. When referring to created or connected objects in human-facing output (comments, summaries, notifications, descriptions), use the object\'s title — not its UUID. Returned nodes include the title; edges include sourceTitle and targetTitle for the same reason. UUIDs should only appear in human-facing text when two objects share a near-identical title and disambiguation is needed — in that case append a short id suffix (e.g. "Bets and Threads v4 (ca957490)"). Use UUIDs freely inside tool arguments.',
		inputSchema: z.object({
			workspace_id: requiredWorkspaceId,
			nodes: z
				.array(
					z.object({
						$id: z.string().describe('Client-side temporary ID for cross-referencing in edges'),
						type: z
							.string()
							.describe(
								"Object type. Call get_workspace_schema first for this workspace's actual configured types; do not assume a fixed set.",
							),
						title: z.string().optional().describe('Short, human-readable title for the object.'),
						content: z
							.string()
							.optional()
							.describe(
								"The object's body — this is the meat of it. Keep it sharp: lead with the point, cut filler.",
							),
						status: z
							.string()
							.describe(
								"Object status. Choose the first status by default. Only choose a different status when it's relevant.",
							),
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
							.describe(
								"Relationship type. Call get_workspace_schema to see this workspace's configured relationship types — built-ins like informs/breaks_into/blocks/relates_to/duplicates are common defaults, but workspaces can add their own.",
							),
					}),
				)
				.default([])
				.describe('Relationships to create between new and/or existing objects'),
		}),
	},
	get_objects: {
		description:
			"Get one or more objects by ID. Default response per object: `{id, type, title, status, contextLine, url, workspaceId}` plus an always-on `setup` block (`{checks, next_steps, prose}`) — a fresh readiness check surfacing gaps (thin content, no driver, entry-status objects) to walk the user through; same shape create_objects/update_objects return. Opt into further blocks with `include:` (each adds only its own block): `content` — the object's body/description; `metadata` — the object's custom field values; `relationships` — inbound and outbound edges, each with sourceTitle and targetTitle; `connected_objects` — the objects on the other end of those edges; `events` — recent lifecycle changes and comments; `files` — metadata for files attached to the object or its comments. For a loop's deeper setup check (steps, connectors, members), call get_loop — it always returns its own `setup` block, richer than the lightweight per-object slice here. In human-facing output, refer to objects by their `title`, not their UUID. Append a short id suffix (e.g. \"Sales v4 (ca957490)\") only when two titles collide.",
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			ids: z.array(z.string().uuid()).min(1).max(50).describe('Object IDs to fetch'),
			include: z
				.array(
					z.enum([
						'content',
						'metadata',
						'relationships',
						'connected_objects',
						'events',
						'files',
						'setup',
					]),
				)
				.default([])
				.describe(
					'Opt-in blocks to add to each object response. Default `[]` returns only the core fields `{id, type, title, status, contextLine, url, workspaceId}` plus `setup` per object; each listed value adds one more block. `setup` is always attached regardless of whether it is listed here — the enum value is accepted only for backward compatibility and is a no-op.',
				),
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
							.describe(
								"Relationship type. Call get_workspace_schema to see this workspace's configured relationship types — built-ins like informs/breaks_into/blocks/relates_to/duplicates are common defaults, but workspaces can add their own.",
							),
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
			'List objects in the workspace. Filter by type, status, driver, last-updated window, or custom metadata fields. Returns paginated results ordered by creation date, newest first, unless `sort` is set. Rows with `status = "archived"` are hidden by default — pass `include_archived: true` to see them. Paginated via a snapshot-consistent cursor (default page: 25) — pass `next_cursor` from the previous response as `cursor` to fetch the next page. This applies uniformly to the default creation-date order and to `sort`-overridden updated-at order.',
		inputSchema: z.object({
			workspace_id: requiredWorkspaceId,
			type: z
				.string()
				.describe('Object type. Call get_workspace_schema to see the live list.')
				.optional(),
			status: z.string().optional(),
			driver: z
				.string()
				.uuid()
				.optional()
				.describe('Filter to objects with this driver actor UUID'),
			updated_before: z
				.string()
				.datetime({ offset: true })
				.optional()
				.describe(
					'ISO-8601 timestamp. Half-open: returns rows with `updated_at < updated_before` (the bound itself is excluded). Use to scan for stalled work, e.g. `updated_before = now - 6h`.',
				),
			updated_after: z
				.string()
				.datetime({ offset: true })
				.optional()
				.describe(
					'ISO-8601 timestamp. Half-open: returns rows with `updated_at > updated_after` (the bound itself is excluded). Composes with `updated_before` for a non-overlapping window.',
				),
			sort: z
				.enum(['updated_at_asc', 'updated_at_desc'])
				.optional()
				.describe(
					'Sort by `updated_at`. Use `updated_at_asc` to walk oldest-stalled-first; `updated_at_desc` for most-recently-touched first. Omit to keep the default `createdAt desc` order.',
				),
			limit: z
				.number()
				.int()
				.min(1)
				.max(100)
				.optional()
				.describe('Max rows to return. Defaults to 25.'),
			cursor: z
				.string()
				.optional()
				.describe(
					'Opaque cursor returned as `next_cursor` on a prior response. When set, the server continues the snapshot-consistent walk started by the first call — rows inserted (or, under `sort`-overridden order, updated) after that first call cannot leak into the stream.',
				),
			metadata_eq: metadataEqSchema,
			include_archived: z
				.boolean()
				.default(false)
				.describe(
					'When false (the default), rows with `status = "archived"` are excluded regardless of type. Set to `true` to include archived rows — used when a caller deliberately wants to see closed-out work.',
				),
		}),
	},
	search_objects: {
		description:
			'Search objects by text in title or content, combined with optional type/status filters. Use this instead of list_objects when you need to find objects by keyword. To narrow by a custom metadata field, pass `metadata_eq` — e.g. `metadata_eq: {"promotion_mode": "human_approved"}`. Call get_workspace_schema first to see which fields exist per object type. Rows with `status = "archived"` are hidden by default — pass `include_archived: true` to see them. Paginated via `offset` (default page: 25) — search results are ranked by match quality, which is incompatible with cursor pagination, so there is no `cursor` param here (unlike list_objects). Every page of a multi-page walk is still pinned to the same snapshot, so inserts between calls cannot shift results across pages.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			q: z
				.string()
				.min(1)
				.describe('Search query — matches against title and content (case-insensitive)'),
			type: z
				.string()
				.describe(
					'Object type — any type this workspace defines (built-ins like insight/bet/task, or a custom type). Call get_workspace_schema to see the live list.',
				)
				.optional(),
			status: z.string().optional(),
			driver_id: z
				.string()
				.uuid()
				.optional()
				.describe('Filter to objects with this driver actor UUID'),
			updated_after: z
				.string()
				.datetime({ offset: true })
				.optional()
				.describe(
					'ISO-8601 timestamp. Half-open: returns rows with `updated_at > updated_after` (the bound itself is excluded).',
				),
			limit: z
				.number()
				.int()
				.min(1)
				.max(100)
				.optional()
				.describe('Max rows to return. Defaults to 25.'),
			offset: z
				.number()
				.int()
				.min(0)
				.optional()
				.describe('Rows to skip before the page starts. Defaults to 0.'),
			metadata_eq: metadataEqSchema,
			include_archived: z
				.boolean()
				.default(false)
				.describe(
					'When false (the default), rows with `status = "archived"` are excluded regardless of type. Set to `true` to include archived rows — used when a caller deliberately wants to see closed-out work.',
				),
		}),
	},
	list_relationships: {
		description:
			'List relationships with optional filters. Use `object_id` to fetch every relationship connected to an object regardless of direction (matches either source or target). Use `source_id` / `target_id` only when direction matters. Paginated via a snapshot-consistent cursor (default page: 25) — pass `next_cursor` from the previous response as `cursor` to fetch the next page.',
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
			limit: z
				.number()
				.int()
				.min(1)
				.max(100)
				.optional()
				.describe('Max rows to return. Defaults to 25.'),
			cursor: z
				.string()
				.optional()
				.describe(
					'Opaque cursor returned as `next_cursor` on a prior response. When set, the server continues the snapshot-consistent walk started by the first call.',
				),
		}),
	},
	delete_relationship: {
		description: 'Delete a relationship by ID',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			id: z.string().uuid(),
		}),
	},
	traverse_graph: {
		description:
			"Bounded multi-hop breadth-first traversal from a single object across the workspace `relationships` table. Returns a flat `{ nodes: [{id, type, title}], edges: [{source, target, type}] }` subgraph plus a `truncated` flag. Use this to resolve supersedes/contradicts chains, walk breaks_into hierarchies, or gather an object's multi-hop context in a single call — instead of chaining `get_objects` + `list_relationships` yourself. Bounded by `max_depth` (default 3), `max_nodes` (default 200), and their product (server ceiling: 5000). Cycles terminate via a visited set keyed on object id. Only object endpoints inside the caller's workspace are followed; file endpoints and cross-workspace ids are skipped. Prefer `get_objects` when you already know the ids you need — this tool is for discovering the surrounding graph.",
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			object_id: z
				.string()
				.uuid()
				.describe("Object id to start the traversal from. Must exist in the caller's workspace."),
			max_depth: z
				.number()
				.int()
				.min(1)
				.max(10)
				.default(3)
				.describe(
					'Maximum BFS depth. 1 = direct neighbours only, 3 = neighbours of neighbours of neighbours. Server ceiling: max_depth * max_nodes ≤ 5000.',
				),
			max_nodes: z
				.number()
				.int()
				.min(1)
				.max(1000)
				.default(200)
				.describe(
					'Maximum number of objects in the response, including the start node. When the cap trips, `truncated` is `true` and `truncated_reason` is `"max_nodes"`.',
				),
			edge_type_allow_list: z
				.array(
					z.enum([
						'informs',
						'breaks_into',
						'blocks',
						'relates_to',
						'duplicates',
						'supersedes',
						'contradicts',
						'about',
						'competes_with',
						'derived_from',
					]),
				)
				.optional()
				.describe(
					'Only follow relationships whose `type` is in this list. Omit to follow every workspace edge type.',
				),
			direction: z
				.enum(['outbound', 'inbound', 'both'])
				.default('both')
				.describe(
					'`outbound` follows edges out of the current frontier (source → target). `inbound` follows edges into it (target → source). `both` is the default and matches how agents usually reason about contradiction/supersession chains.',
				),
		}),
	},
	create_actor: {
		description:
			'Create a new actor (human or agent). Returns the actor details and API key (only shown once). If workspace_id is provided, the actor is added as a member with the given role — this is how to add a brand-new actor to a workspace as part of creating them. To add an already-existing actor to a workspace, use update_actor with workspace_id/role instead. If auto_create_workspace is true (default for humans), a new, empty workspace is created instead. Agents default to auto_create_workspace=false, so workspace_id is effectively required when type is "agent" — omitting both fails the call rather than silently creating a workspace-less agent. For agents, set tools.mcpServers and/or attach_skill_ids so the agent has its MCP servers and skills from the start. attach_skill_ids requires workspace_id — with auto_create_workspace the new workspace has no existing skills, so any attach_skill_ids passed alongside it are ignored.',
		inputSchema: z.object({
			type: z.enum(['human', 'agent']),
			name: z.string().min(1).describe('Name of actor'),
			email: z.string().email().optional().describe('Required for humans'),
			auto_create_workspace: z
				.boolean()
				.optional()
				.describe(
					'When true (the default for humans), a brand-new empty workspace is created and the actor is automatically added to it as owner — no separate add-to-workspace call needed. When false or omitted for agents, no workspace is created; pass workspace_id instead to add the actor to an existing one.',
				),
			workspace_id: z
				.string()
				.uuid()
				.optional()
				.describe(
					'Add the new actor to this existing workspace. Required when type is "agent" unless auto_create_workspace is explicitly true — the call fails otherwise rather than creating an agent with no workspace.',
				),
			role: z
				.enum(['owner', 'admin', 'member'])
				.default('member')
				.describe(
					'Role when adding to a workspace via workspace_id: owner (full control), admin (manage members), member (read/write).',
				),
			description: z
				.string()
				.min(1)
				.max(80)
				.describe(
					'Required, non-empty short one-liner (max 80 chars) summarizing the actor. For agents this is shown on the Agents page list and sub-page so teammates can tell agents apart at a glance — do not pass an empty or placeholder string.',
				),
			system_prompt: z
				.string()
				.optional()
				.describe(
					"Agents only — not used for humans. This is the single most important param for agent quality: it's what makes the agent an expert rather than a generic assistant, so invest real effort here. Write it as an opinionated subject-matter-expert persona, not a bland instruction list — give the agent a clear domain and job-to-be-done, a decision framework it applies (plus a couple of named biases it leans on), explicit scope boundaries, guidance on how/when to use its tools, the output format it should produce, and ideally a few worked examples that each end in a concrete recommendation plus its assumptions. Bias the agent against hedging — it should state a recommendation, not equivocate. If omitted for an agent, sessions fall back to a generic default prompt, which produces a generic, non-expert agent.",
				),
			tools: z
				.record(z.unknown())
				.optional()
				.describe(
					'MCP server config for agents: { mcpServers: { <name>: { type, command, args, env } | { type: "http", url, headers } } }. Critical for any agent whose job requires taking action outside Maskin itself — without the relevant MCP server connected here, the agent can have a perfect system_prompt and still be unable to actually do its job. To give the agent the tools of a connected integration, call list_integration_providers and copy the `mcp.server` of that provider in under the provider name; connecting the integration by itself does NOT expose any tools unless its `mcp.autoInject` is true. `type` is required on each entry ("stdio" or "http") — omitting it fails validation with a bare "Invalid input".',
				),
			llm_config: actorLlmConfigSchema,
			attach_skill_ids: z
				.array(z.string().uuid())
				.optional()
				.describe(
					'Workspace skill IDs to attach to this actor on creation — skills are what push an agent from "just a well-written prompt" to expert-level at its actual job, so treat this as seriously as system_prompt. Agents only — not used for humans. Before creating, check the workspace\'s existing skills (list_workspace_skills) for ones that genuinely match this agent\'s job and attach those. If none of the existing skills fit, do not attach unrelated ones just to fill this field — instead, after creation, flag to the user that no matching skill was found and ask whether one should be authored (create_workspace_skill).',
				),
		}),
	},
	update_actor: {
		description:
			'Update an actor by ID. Can change name, email, description (short one-liner, max 80 chars), system_prompt / instructions (agents only), tools configuration, llm_config (agents only), workspace skill attachments (attach_skill_ids / detach_skill_ids), and optionally add the actor to a workspace (workspace_id + role) in the same call. This is how to add an already-existing actor to a workspace — for adding a brand-new actor to a workspace as part of creating them, use create_actor instead.',
		inputSchema: z.object({
			id: z.string().uuid(),
			name: z.string().min(1).optional().describe('New name for the actor.'),
			email: z
				.string()
				.email()
				.optional()
				.describe('New email address for the actor. Only meaningful for humans.'),
			description: z
				.string()
				.min(1)
				.max(80)
				.optional()
				.describe('Short, non-empty one-liner (max 80 chars) summarizing the actor.'),
			system_prompt: z
				.string()
				.optional()
				.describe(
					"Instructions defining the agent's behavior. Only meaningful for agents — not used for humans.",
				),
			tools: z
				.record(z.unknown())
				.optional()
				.describe(
					'MCP server config for agents: { mcpServers: { <name>: { type, command, args, env } | { type: "http", url, headers } } }. REPLACES the whole map — read the actor first and merge, or you will silently drop its existing servers. To add the tools of a connected integration, copy the `mcp.server` of that provider from list_integration_providers in under the provider name. `type` is required on each entry ("stdio" or "http").',
				),
			llm_config: actorLlmConfigSchema,
			attach_skill_ids: z
				.array(z.string().uuid())
				.optional()
				.describe(
					'Workspace skill IDs to attach to this actor. Agents only — skills configure agent behavior and are not used for humans.',
				),
			detach_skill_ids: z
				.array(z.string().uuid())
				.optional()
				.describe(
					'Workspace skill IDs to detach from this actor. Agents only — skills configure agent behavior and are not used for humans.',
				),
			workspace_id: z
				.string()
				.uuid()
				.optional()
				.describe(
					'Add this actor to the given workspace as part of the update. This is the tool for adding an existing actor to a workspace. Omit to leave workspace membership unchanged.',
				),
			role: z
				.enum(['owner', 'admin', 'member'])
				.default('member')
				.describe(
					'Role to assign when adding to a workspace via workspace_id: owner (full control), admin (manage members), member (read/write). Only applied when workspace_id is set.',
				),
		}),
	},
	list_actors: {
		description:
			"List actors (humans and agents). If workspace_id is provided, returns members of that workspace with their role. If omitted, returns actors across all workspaces the caller belongs to, each annotated with their workspace memberships. Each row includes the actor's short `description` (one-liner) — call `get_actor` for the full `system_prompt` (instructions), which is how to pick up context on a human teammate @mentioned in a comment. When `workspace_id` is set, each row also includes `connectedTriggers`/`connectedLoops` — the triggers and loops wired to that actor, each as `{ name, url }` (omitted when there are none, and always omitted for the cross-workspace listing, since a trigger/loop belongs to exactly one workspace). The workspace-scoped path pages via a snapshot-consistent cursor (default page: 25) — pass `next_cursor` from the previous response as `cursor` to fetch the next page. The cross-workspace listing (no `workspace_id`) does not support cursor pagination — use `offset` to page it instead.",
		inputSchema: z.object({
			workspace_id: z
				.string()
				.uuid()
				.optional()
				.describe(
					'Optional workspace ID to scope the listing to. If omitted, returns actors across all workspaces the caller belongs to (each with their workspace memberships).',
				),
			limit: z
				.number()
				.int()
				.min(1)
				.max(100)
				.optional()
				.describe('Max rows to return (1-100). Defaults to 25.'),
			offset: z
				.number()
				.int()
				.min(0)
				.optional()
				.describe(
					'Rows to skip. Only used for the cross-workspace listing (no `workspace_id`) — the workspace-scoped path pages via `cursor` instead. Defaults to 0.',
				),
			cursor: z
				.string()
				.optional()
				.describe(
					'Opaque cursor returned as `next_cursor` on a prior response. Only meaningful when `workspace_id` is set — the cross-workspace listing (no `workspace_id`) does not support cursor pagination and never returns a `next_cursor`; use `offset` to page it instead. When set, the server continues the snapshot-consistent walk started by the first call.',
				),
		}),
	},
	get_actor: {
		description:
			"Get an actor by ID. Returns `actor` — the full record, including `description` (short one-liner), `system_prompt` / instructions (longer context on who the actor is and how to work with them), `skills` (id + name of workspace skills attached to the actor), and `connectedTriggers`/`connectedLoops` (the triggers/loops wired to this actor, same as `list_actors`) — alongside `heroCard`, a display-only summary of that same actor with a subset of the fields under camelCased names. The two are the same record, not a full and a truncated copy; read `actor`. When `workspace_id` is given, `status` reflects the actor's membership role in that workspace (owner/admin/member), matching `list_actors`' workspace-scoped `status`. When a human is @mentioned on a comment, call this to pick up their instructions and tailor your reply. This tool is read-only — to change any of these fields, including `system_prompt`, `tools` and skill attachments, use `update_actor`.",
		inputSchema: z.object({
			id: z.string().uuid(),
			workspace_id: z
				.string()
				.uuid()
				.optional()
				.describe(
					'Workspace to resolve against: the returned `url`, `status` (membership role in this workspace), and `connectedTriggers`/`connectedLoops` are all scoped to this workspace. Defaults to the connection default workspace if omitted.',
				),
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
		description:
			'Update a workspace by ID (name and/or settings). Settings are shallow-merged into existing workspace settings (deep-merged for llm_keys). Supported settings keys include: north_star_metric (onboarding prompt answer), llm_keys, tags, and other workspace-level configuration.',
		inputSchema: z.object({
			id: z.string().uuid(),
			name: z.string().min(1).optional(),
			settings: z
				.record(z.unknown())
				.optional()
				.describe(
					'Partial settings to merge. Supported keys: north_star_metric (string, onboarding answer), llm_keys, tags, and others. Values are shallow-merged into existing settings; llm_keys receives a deep merge.',
				),
		}),
	},
	list_workspaces: {
		description:
			'List workspaces accessible to the authenticated actor. Use this to discover workspace IDs, which can be passed to any workspace-scoped tool via the workspace_id parameter. Paginated via a snapshot-consistent cursor (default page: 25) — pass `next_cursor` from the previous response as `cursor` to fetch the next page.',
		inputSchema: z.object({
			limit: z
				.number()
				.int()
				.min(1)
				.max(100)
				.optional()
				.describe('Max rows to return. Defaults to 25.'),
			cursor: z
				.string()
				.optional()
				.describe(
					'Opaque cursor returned as `next_cursor` on a prior response. When set, the server continues the snapshot-consistent walk started by the first call.',
				),
		}),
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
					'Filter schema to a specific object type — any type this workspace defines (built-ins like insight/bet/task, or a custom type). If omitted, returns schema for all types.',
				),
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
			'Add a new metadata field to a workspace object type — any type this workspace defines (built-ins like insight/bet/task, or a custom type). Mirrors the web schema editor — once added, the field is available via get_workspace_schema and accepted by create_objects / update_objects metadata. Field names must be unique within a type.',
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
			"Update an existing metadata field on a workspace object type. Use this to rename, change the field type, toggle required, or edit an enum field's allowed values. Pass only the fields you want to change. For enum values, prefer add_values/remove_values to add or remove individual values without disturbing the rest (idempotent — adding an existing value or removing a missing one is a no-op); use values only when replacing the full list wholesale. Existing objects keep any value they previously stored even after it is removed from the allowed list — only new writes are constrained.",
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
					'Optional full replacement list of enum values, applied before add_values/remove_values. Pass an empty array to clear (only valid if add_values then supplies at least one value, since enum fields require at least one). Omit to leave the current values as the starting point for add_values/remove_values.',
				),
			add_values: z
				.array(z.string().min(1))
				.optional()
				.describe(
					'Enum values to add, keeping all existing values. Only valid when the field is (or is being changed to, via field_type) an enum.',
				),
			remove_values: z
				.array(z.string().min(1))
				.optional()
				.describe(
					'Enum values to remove, keeping the rest. Only valid when the field is (or is being changed to, via field_type) an enum. Applied after add_values.',
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
	// ─── Workspace Skills ─────────────────────────────────────
	// Shared, workspace-scoped skills that any agent in the workspace can be given.
	// NOT the same as per-agent skills (those live under an agent's own file store).
	list_workspace_skills: {
		description:
			'List shared workspace skills — SKILL.md files stored once per workspace and attachable to any agent in the workspace. These are workspace-scoped and reusable across agents, NOT per-agent skills. Returns lightweight rows without the SKILL.md body; call get_workspace_skill to fetch full content. Paginated via a snapshot-consistent cursor (default page: 25) — pass `next_cursor` from the previous response as `cursor` to fetch the next page.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			limit: z
				.number()
				.int()
				.min(1)
				.max(100)
				.optional()
				.describe('Max rows to return. Defaults to 25.'),
			cursor: z
				.string()
				.optional()
				.describe(
					'Opaque cursor returned as `next_cursor` on a prior response. When set, the server continues the snapshot-consistent walk started by the first call.',
				),
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
		description:
			'List files in the workspace, newest first. Pass `q` to filter by name substring. Paginated via a snapshot-consistent cursor (default page: 25) — pass `next_cursor` from the previous response as `cursor` to fetch the next page.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			q: z.string().optional().describe('Case-insensitive substring match on file name.'),
			limit: z
				.number()
				.int()
				.min(1)
				.max(200)
				.optional()
				.describe('Max rows to return. Defaults to 25.'),
			cursor: z
				.string()
				.optional()
				.describe(
					'Opaque cursor returned as `next_cursor` on a prior response. When set, the server continues the snapshot-consistent walk started by the first call.',
				),
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
			'Get the workspace activity log. Every mutation (create, update, delete) is recorded as an event. Use this to see what changed, track agent activity, or audit changes. Pass `id` to fetch a single event by its numeric event_id (e.g. the one quoted in a trigger prompt). Filter by entity_type (object|relationship|integration) and action (created|updated|deleted|status_changed). Paginated via a snapshot-consistent cursor — pass `next_cursor` from the previous response as `cursor` to fetch the next page.',
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
			cursor: z
				.string()
				.optional()
				.describe(
					'Opaque cursor returned as `next_cursor` on a prior response. When set, the server continues the snapshot-consistent walk started by the first call.',
				),
		}),
	},
	get_comments: {
		description:
			'Get comments posted on a specific object, newest first. Threading is expressed via data.parentEventId on each row — replies reference the event id of the comment they reply to. Paginated via a snapshot-consistent cursor — pass `next_cursor` from the previous response as `cursor` to fetch the next page.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			entity_id: z.string().uuid().describe('Object ID to fetch comments for.'),
			limit: z.number().int().min(1).max(100).default(50).describe('Defaults to 50.'),
			cursor: z
				.string()
				.optional()
				.describe(
					'Opaque cursor returned as `next_cursor` on a prior response. When set, the server continues the snapshot-consistent walk started by the first call.',
				),
		}),
	},
	create_comment: {
		description:
			'Primary channel for agent-to-human communication. Post comments here for status updates, questions, findings, decisions, blockers, and anything else a human needs to see. Do NOT bury that dialogue in `bet.content`, `task.content`, or object titles — those fields are the durable spec, not the conversation, and humans don\'t scan them for new information. If you\'re tempted to edit a description to "let someone know" something, that belongs in a comment.\n\nUse both a chart and a task checklist (see the `content` and `metadata` param docs) to keep replies short: one paragraph + a chart of the data you pulled via MCP + the checklist of work this comment represents.\n\nWhen you need a human to make a call rather than just read something, put that human in `mentions` and fill in `decision` — that pair is the only way an ask reaches their For You feed as a decision they can answer in one tap. See the `decision` param docs for the required shape and house style; the API rejects a decision that breaks them, listing every violated rule at once.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			...createCommentSchema.shape,
		}),
	},

	// ─── Conversations ───────────────────────────────────────
	get_conversation: {
		description:
			"Get a conversation's title and current participant list (humans and agents). Call this before replying so you know who else is in the room.",
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			conversation_id: z.string().uuid(),
		}),
	},
	list_conversation_messages: {
		description:
			'List messages in a conversation, most-recent first. Use before_id (fetch older) or after_id (fetch newer) with the id of a message you already have to page through history.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			conversation_id: z.string().uuid(),
			before_id: z.number().int().positive().optional(),
			after_id: z.number().int().positive().optional(),
			limit: z.number().int().min(1).max(200).default(50),
		}),
	},
	post_conversation_message: {
		description: `Post a message into a conversation you are a participant in, mid-turn. You do NOT need this tool for your actual reply: whatever you write at the end of your turn is posted into the chat automatically. Use it for an interim note — most usefully a short heads-up, before you start something that will take a while, saying what you are going into so the human isn't left waiting in silence. That is optional; skip it when the message just wants a direct answer. Read the recent messages with list_conversation_messages first if you need more context than what triggered this session. Posting "okay" or "got it" style acknowledgements with nothing else adds noise, not value. Hard limit: ${MESSAGE_MAX_LENGTH} characters.`,
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			conversation_id: z.string().uuid(),
			content: z.string().min(1).max(MESSAGE_MAX_LENGTH),
			metadata: messageMetadataSchema.optional(),
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
		description:
			'List all triggers in the workspace. Paginated via a snapshot-consistent cursor (default page: 25) — pass `next_cursor` from the previous response as `cursor` to fetch the next page.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			limit: z
				.number()
				.int()
				.min(1)
				.max(100)
				.optional()
				.describe('Max rows to return. Defaults to 25.'),
			cursor: z
				.string()
				.optional()
				.describe(
					'Opaque cursor returned as `next_cursor` on a prior response. When set, the server continues the snapshot-consistent walk started by the first call.',
				),
		}),
	},
	// ─── Loops ───────────────────────────────────────────────
	// A Loop is a persistent multi-agent process: a goal wrapped around
	// triggers + agents + objects changing state. Stored as an `objects` row
	// with `type = 'loop'`; its steps are ordinary triggers referenced via
	// `metadata.trigger_ids`, and the objects flowing through it are linked
	// with `in_loop` relationship edges (source = loop, target = member
	// object). "Open vs closed" is structural — a loop is closed when one of
	// its steps is a feedback step that fires on end states. These tools are
	// the supported way to author loops from MCP — they wire that metadata and
	// those edges correctly, which raw create_objects calls historically got
	// wrong.
	create_loop: {
		description:
			"Create a Loop — an iterative process where agents (and humans) work toward a goal, driven by STEPS that fire an agent when an object of any type changes state (event) or on a schedule (cron). A step and a trigger are the same thing, created two different ways: `steps` authors brand-new triggers inline in this call (you supply name/agent_id/prompt/when); `trigger_ids` attaches triggers that already exist. Both land in the same place — the loop's step list — and the response nests each step's resolved agent directly under it (there is no separate flat agent list, since the trigger is what determines which agent runs a step). Before authoring a step or attaching a trigger_ids entry, call list_actors (and list_triggers, to see a candidate trigger's current target agent) and confirm the agent's role and system_prompt genuinely fit the work — never default to an unrelated or generic agent/trigger just because one is on hand. Where nothing fits, create a fresh, specialized agent (create_actor) and/or trigger (an inline step, or create_trigger) instead of repurposing a mismatched pair — loops are more reliable when each step is run by an expert, single-purpose agent. MEMBER OBJECTS are the objects currently flowing through the loop (any type — call get_workspace_schema to discover types and statuses), linked via `in_loop` relationships. `status` is a graduated-trust ladder (draft → pilot → supervised → live, in that order) that can be paused from any point on the ladder — pausing disables every trigger the loop references, so nothing fires until it's resumed. `archived` is a terminal retirement state for loops that are no longer in service. A loop is OPEN when it has no feedback mechanism, CLOSED when one of its steps is a feedback step — an event trigger on the close condition (e.g. when an object reaches a done status) whose agent captures learnings (create an insight/knowledge object linked with `informs`), improves the loop, and/or seeds the next object into it. Prefer closing every loop. To put a human ON the loop, add a step whose agent @mentions that human on the relevant object via create_comment — human participation is a step like any other. If custom object types flow through the loop, pass `closed_statuses` so the loop knows which statuses mean done. All ids, types, and statuses are validated against the workspace — unknown ones fail with a clear error instead of silently creating a loop with no working steps. The loop object and its `in_loop` membership edges are created atomically; attach more steps or objects later with update_loop; read loops back (with live stats) via list_loops. NOTE: this creates a custom loop from scratch — to install a pre-packaged marketplace loop template, use get_started instead.",
		inputSchema: z.object({
			workspace_id: requiredWorkspaceId,
			name: z.string().min(1).describe('Loop name, e.g. "Inbound lead qualification".'),
			content: z
				.string()
				.optional()
				.describe('What the loop is for — a plain-language description of the process it runs.'),
			status: z
				.enum(MCP_LOOP_STATUSES)
				.default('draft')
				.describe(
					'Autonomy stage. `draft` (default) — set up but not live yet. `pilot` → `supervised` → `live` is the trust ladder as the loop proves itself and earns more autonomy. `paused` can be set from any live stage and disables every trigger the loop references until it leaves paused. `archived` is a terminal retirement state — use it once the loop is no longer in service.',
				),
			entry_condition: z
				.string()
				.optional()
				.describe(
					'Plain-language condition for when an object enters the loop, e.g. "A new insight is created with source=intercom".',
				),
			close_condition: z
				.string()
				.optional()
				.describe(
					'Plain-language condition for when an object is done and leaves the loop, e.g. "The task reaches status done or discarded".',
				),
			steps: z
				.array(loopStepSchema)
				.max(20)
				.default([])
				.describe(
					'Inline step definitions — each becomes a trigger created in this same call and attached to the loop. Include a feedback step (event `when` on the close condition) to make the loop CLOSED.',
				),
			trigger_ids: z
				.array(z.string().uuid())
				.max(50)
				.default([])
				.describe(
					'Pre-existing triggers to attach as loop steps — see the tool description for how to pick one whose agent actually fits. Find candidates with list_triggers, or create one with create_trigger. Combined with any inline `steps` and stored on the loop as metadata.trigger_ids.',
				),
			object_ids: z
				.array(z.string().uuid())
				.max(50)
				.default([])
				.describe(
					'Existing objects — of any workspace-defined type — to start running through the loop. Each becomes an `in_loop` relationship (source = loop, target = object). Objects can also be added later with update_loop.',
				),
			closed_statuses: closedStatusesSchema,
		}),
	},
	update_loop: {
		description:
			"Update a Loop: rename it, change its status or entry/close conditions, add inline steps, attach/detach triggers (the loop's steps), add/remove the objects flowing through it, and set closed_statuses for custom object types. A step and a trigger are the same thing — see create_loop's description for how `steps`/`trigger_ids` relate and how to pick an agent that actually fits before authoring or attaching one; the same guidance applies to add_steps/add_trigger_ids here. Use add_steps with an event `when` on the close condition to CLOSE an open loop — i.e. add the feedback step that captures learnings and seeds the next object when a member object reaches its end state. Trigger membership is stored on the loop row as metadata.trigger_ids — add_steps/add_trigger_ids/remove_trigger_ids do a safe read-modify-write of that list (added ids are validated against the workspace's triggers). Setting `status` to `paused` disables every trigger currently on the loop (including ones just added in this same call); moving off `paused` re-enables them. Object membership is an `in_loop` relationship edge — add_object_ids creates edges (idempotent; already-member objects are fine), remove_object_ids deletes them. Find loop ids with list_loops. Fails with a clear error if the target object is not a loop — use update_objects for regular objects.",
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			id: z.string().uuid().describe('Loop object id (from list_loops or create_loop).'),
			name: z.string().min(1).optional().describe('New loop name.'),
			content: z
				.string()
				.optional()
				.describe('New loop description (replaces the current content).'),
			status: z
				.enum(MCP_LOOP_STATUSES)
				.optional()
				.describe(
					"New autonomy stage: draft | pilot | supervised | live | paused | archived — see create_loop for what each means. Setting `paused` disables the loop's triggers; moving off it re-enables them. `archived` is terminal.",
				),
			entry_condition: z
				.string()
				.optional()
				.describe('New plain-language entry condition. Pass an empty string to clear.'),
			close_condition: z
				.string()
				.optional()
				.describe('New plain-language close condition. Pass an empty string to clear.'),
			closed_statuses: closedStatusesSchema,
			add_steps: z
				.array(loopStepSchema)
				.max(20)
				.optional()
				.describe(
					'Inline step definitions to add — each becomes a trigger created in this call and attached to the loop. Add a feedback step (event `when` on the close condition) to close an open loop.',
				),
			add_trigger_ids: z
				.array(z.string().uuid())
				.max(50)
				.optional()
				.describe(
					'Trigger ids to attach as loop steps. Validated against the workspace — unknown ids fail the call. Already-attached ids are a no-op.',
				),
			remove_trigger_ids: z
				.array(z.string().uuid())
				.max(50)
				.optional()
				.describe(
					'Trigger ids to detach from the loop. The triggers themselves are NOT deleted (use delete_trigger for that) — they just stop being steps of this loop.',
				),
			add_object_ids: z
				.array(z.string().uuid())
				.max(50)
				.optional()
				.describe(
					'Object ids to start running through the loop (creates `in_loop` edges). Idempotent for objects already in the loop.',
				),
			remove_object_ids: z
				.array(z.string().uuid())
				.max(50)
				.optional()
				.describe(
					'Object ids to take out of the loop (deletes their `in_loop` edges). The objects themselves are untouched.',
				),
		}),
	},
	list_loops: {
		description:
			'List every Loop in the workspace as a lean id/name index — each row is just `{id, workspaceId, name, url}`. Use this to find loop ids, then call get_loop with a specific id for live stats (status pill, entry/close conditions, member-object counts, median time-to-close) and the `steps` view (each trigger nested with its resolved agent). To list the objects currently inside a loop, call list_relationships with source_id=<loop id> and type="in_loop". Paginated via a snapshot-consistent cursor (default page: 25) — pass `next_cursor` from the previous response as `cursor` to fetch the next page.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			limit: z
				.number()
				.int()
				.min(1)
				.max(100)
				.optional()
				.describe('Max rows to return. Defaults to 25.'),
			cursor: z
				.string()
				.optional()
				.describe(
					'Opaque cursor returned as `next_cursor` on a prior response. When set, the server continues the snapshot-consistent walk started by the first call.',
				),
		}),
	},
	get_loop: {
		description:
			"Get a single Loop by id: composite status pill, entry/close conditions, in-progress and closed member-object counts, median time-to-close, plus `steps` — each step's trigger nested with its resolved agent (id/name/description). Use list_loops (a lean id/name index) to discover loop ids first. Fails with a clear error if the id is not a loop in this workspace.",
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			id: z.string().uuid().describe('Loop object id (from list_loops or create_loop).'),
		}),
	},
	delete_loop: {
		description:
			"Delete a Loop: removes the loop object itself and its `in_loop` membership edges. Member objects (bets/tasks/insights/custom types that were flowing through the loop) and the loop's step triggers are NOT deleted — they're just no longer associated with this loop (triggers can be removed separately with delete_trigger if they're not reused elsewhere). Fails with a clear error if the id is not a loop in this workspace. This cannot be undone.",
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			id: z.string().uuid().describe('Loop object id (from list_loops or create_loop).'),
		}),
	},

	// ─── Sessions ────────────────────────────────────────────
	create_session: {
		description:
			'Spawn a containerized agent execution session. Creates an ephemeral Docker container running the specified agent (Claude Code, Codex, or custom). The agent executes the action_prompt autonomously. Use get_session to check status; pass `include_logs: true` on the same call to read the container output. For a blocking alternative that waits for completion, use run_agent instead.',
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
					browserRequired: z
						.boolean()
						.optional()
						.describe(
							'Provision a Chromium CDP browser sidecar and inject BROWSER_CDP_URL so a playwright MCP server can attach. Auto-enabled when the actor already has an MCP server referencing ${BROWSER_CDP_URL}.',
						),
					previewGuestPorts: z
						.array(z.number().int().positive().max(65535))
						.max(8)
						.optional()
						.describe(
							"Usually unnecessary: once a browser sidecar is attached (see browserRequired), any dev-server port the agent starts on its own inside 3000-12000 (e.g. Vite's default 5173) is detected and relayed automatically — the agent's Playwright tool can reach it directly, and the agent is told the URL automatically. Only set this to pre-declare a port so its relay URL (PREVIEW_URL env var) is available from the very first turn, before the dev server itself has started listening. Implies browserRequired.",
						),
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
		description: 'List sessions with optional filters (status, actor, last-updated window).',
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
			updated_before: z
				.string()
				.datetime({ offset: true })
				.optional()
				.describe(
					'ISO-8601 timestamp. Half-open: returns rows with `updated_at < updated_before` (the bound itself is excluded). Use to scan for stalled sessions, e.g. `updated_before = now - 6h`.',
				),
			updated_after: z
				.string()
				.datetime({ offset: true })
				.optional()
				.describe(
					'ISO-8601 timestamp. Half-open: returns rows with `updated_at > updated_after` (the bound itself is excluded). Composes with `updated_before` for a non-overlapping window.',
				),
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
			'High-level tool: create a container agent session, wait for completion, and return the result with logs. This is a blocking call that polls until the session reaches a terminal state (completed/failed/timeout). Use create_session + get_session (with `include_logs: true` when you want the output) separately if you need non-blocking execution.',
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
			'List entities the current actor is subscribed to with unread activity (comments newer than the actor\'s last_read_event_id). Returns object summaries inline when entity_type="object". Paginated via a snapshot-consistent cursor (default page: 25) — pass `next_cursor` from the previous response as `cursor` to fetch the next page.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			entity_type: z.enum(['object']).optional(),
			limit: z
				.number()
				.int()
				.min(1)
				.max(100)
				.optional()
				.describe('Max rows to return. Defaults to 25.'),
			cursor: z
				.string()
				.optional()
				.describe(
					'Opaque cursor returned as `next_cursor` on a prior response. When set, the server continues the snapshot-consistent walk started by the first call.',
				),
		}),
	},
	// ─── Integrations ─────────────────────────────────────────
	list_integrations: {
		description:
			'List integrations connected to the workspace. Paginated via a snapshot-consistent cursor (default page: 25) — pass `next_cursor` from the previous response as `cursor` to fetch the next page.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			limit: z
				.number()
				.int()
				.min(1)
				.max(100)
				.optional()
				.describe('Max rows to return. Defaults to 25.'),
			cursor: z
				.string()
				.optional()
				.describe(
					'Opaque cursor returned as `next_cursor` on a prior response. When set, the server continues the snapshot-consistent walk started by the first call.',
				),
		}),
	},
	list_integration_providers: {
		description:
			'List available integration providers, their supported events, and their MCP surface. Each provider that has one returns `mcp: { envKey, autoInject, server }`. `server` is the paste-ready value for the `tools.mcpServers.<provider>` field of an agent — pass it to create_actor/update_actor verbatim, including any `${TOKEN}` placeholders, which are expanded inside the session container. When `autoInject` is true the integration is already wired into every agent session in the workspace and there is nothing to attach — such a provider may return no `server` at all (github is auto-injected as one `github-<owner>` entry per connected organisation, so no single spec describes it). When `autoInject` is false (the default) connecting the integration alone gives the agent NO tools, and attaching `server` to the agent is the required second step.',
		inputSchema: z.object({}),
	},
	connect_integration: {
		description:
			'Start an integration connection flow for a provider (e.g. "github"). OAuth providers return an install_url that must be opened in a browser to complete the flow; the callback is handled automatically by the server. API-key providers (e.g. "posthog") require `api_key` and are activated immediately, with no install_url.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			provider: z
				.string()
				.describe(
					'Provider name (e.g. "github"). Call list_integration_providers to see available providers.',
				),
			api_key: z
				.string()
				.optional()
				.describe(
					'API key for providers whose auth type is "api_key" (e.g. "posthog"). Required for those providers and ignored for OAuth providers.',
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
	// ─── Extensions ──────────────────────────────────────────
	list_extensions: {
		description:
			'List all available extensions and their status in the workspace. Returns registered extensions (e.g. "work") and any custom extensions defined in the workspace. Each extension bundles one or more object types with statuses, fields, and relationship types. Call this to discover what you can enable or create. Paginated via a stable cursor (default page: 25) — pass `next_cursor` from the previous response as `cursor` to fetch the next page.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			limit: z
				.number()
				.int()
				.min(1)
				.max(100)
				.optional()
				.describe('Max rows to return. Defaults to 25.'),
			cursor: z
				.string()
				.optional()
				.describe(
					'Opaque cursor returned as `next_cursor` on a prior response. When set, the server continues the stable-ordered walk started by the first call.',
				),
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
} as const
