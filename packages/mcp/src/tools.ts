import {
	CONVERSATION_TITLE_MAX_LENGTH,
	FOR_YOU_TOOL_DEFAULT_LIMIT,
	FOR_YOU_TOOL_MAX_LIMIT,
	HUMAN_MESSAGE_STYLE_SHORT,
	MAX_CONVERSATION_PARTICIPANTS,
	MESSAGE_MAX_LENGTH,
	SAFE_METADATA_FIELD_NAME_RE,
	createCommentSchema,
	firstStepSchema,
	loopTargetSchema,
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

// Only people need this: an agent always gets its own computer, and naming another
// agent's is refused (403).
const optionalDesktopAgentId = z
	.string()
	.uuid()
	.optional()
	.describe(
		'Whose computer. Leave out if you are an agent (you always get your own). A person must pass the agent ID.',
	)

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
const WORKSPACE_ID_DESCRIPTION =
	'Workspace ID to operate in. Call list_workspaces to discover available workspaces.'
const requiredWorkspaceId = z.string().uuid().describe(WORKSPACE_ID_DESCRIPTION)

// create_objects is the one tool whose missing-key errors name the key and
// show a correct call, so the agent's second attempt works. The text is static
// (it only fires when the key is absent), so it never echoes a received value.
// It changes what the error says, never what the schema accepts.
export const CREATE_OBJECTS_EXAMPLE_CALL =
	'{"workspace_id":"<workspace uuid>","nodes":[{"$id":"n1","type":"task","status":"todo","title":"Short title"}]}'
const createObjectsMissingKey = (key: string, where: 'call' | 'node') => ({
	required_error: `Missing required key "${key}" on the ${where}. Correct call: ${CREATE_OBJECTS_EXAMPLE_CALL}`,
})

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
		model: z.string().optional().describe('Model identifier to use, e.g. "claude-sonnet-5-5".'),
	})
	.passthrough()
	.optional()
	.describe(
		"Agents only — not used for humans. Configures which LLM this agent runs on: provider and model. Every agent runs on its workspace's connected LLM credentials (the Claude subscription or API key connected under Settings → Keys) — per-agent API key overrides are not supported here. Extra provider-specific keys are passed through as-is.",
	)

// Optional sentence on the close_condition field of create_loop / update_loop.
// Runs woken on a loop are shown this text as their finish line, so it says
// what a good one looks like. A suggestion only; nothing validates it.
const CLOSE_CONDITION_GUIDANCE =
	'Runs in this loop are shown this text, so say what done looks like. It can be a status reached, a summary written, a report posted, or a check that found nothing to do. Short is fine.'

// Optional suggestion shown on every field an agent writes a trigger prompt
// into (create_trigger, update_trigger, and the inline steps of create_loop /
// update_loop). A suggestion only: nothing validates or rejects a prompt that
// ignores it. One constant so the places can't drift apart.
const TRIGGER_PROMPT_GUIDANCE =
	'A good trigger prompt starts with what the run is for. You can say: the outcome (what is true when it is done), how anyone can see that it is true, what to leave alone, and when to stop and ask a person. Done can be a status that moves, but it can also be a summary written, a report posted, or a check that found nothing to do. Use whichever fits. Short is fine.'

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
			`Instruction the agent receives when the step fires. The triggering event (including the changed object) is appended automatically. ${TRIGGER_PROMPT_GUIDANCE}`,
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
const loopTagsSchema = z
	.array(z.string().trim().min(1).max(40))
	.max(10)
	.describe(
		'Short labels saying which team, business unit or part of the business this loop belongs to, e.g. ["Sales", "EMEA"]. Shown as filter pills and chips on Flows. Replaces the current tags; pass [] to clear.',
	)

const loopTargetsSchema = z
	.array(loopTargetSchema)
	.max(50)
	.describe(
		'Targets the loop is measured against: a list of rows { label, source, actual, target }, optionally with ownerActorId and pace_policy ("strict" | "window"). Replaces the current targets; pass [] to clear. Must be a list, not a string. A bad row is rejected with its position and field.',
	)

const closedStatusesSchema = z
	.record(z.array(z.string().min(1)))
	.optional()
	.describe(
		'Map of object type → statuses that count as "done"/closed for THIS loop, e.g. {"lead": ["won", "lost"]}. Required for correct closed counts when custom object types flow through the loop; built-in types (bet/task/insight) have sensible defaults. Types and statuses are validated against the workspace schema.',
	)

const isClosedWhenRule = (rule: string): boolean => {
	const sep = rule.indexOf('=')
	return sep > 0 && sep < rule.length - 1 && SAFE_METADATA_FIELD_NAME_RE.test(rule.slice(0, sep))
}

const closedWhenSchema = z
	.record(
		z.array(
			z.string().refine(isClosedWhenRule, {
				message:
					'Each rule must look like "field=value", with a plain field name (letters, digits, underscore).',
			}),
		),
	)
	.optional()
	.describe(
		'Map of object type → metadata rules that also count a member as "done"/closed for THIS loop, without a status change, e.g. {"insight": ["loop_stage=live"]}. A member is closed when its status is in closed_statuses OR any rule for its type matches (two rules on one field read as "either value"). Rules are "field=value" strings. Types are validated against the workspace schema. Pass {} to clear.',
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

const LIST_ACTORS_INCLUDE_VALUES = ['triggers', 'loops']
const LIST_ACTORS_INCLUDE_PATTERN = /^(triggers|loops)(\s*,\s*(triggers|loops))*$/

/** Split a list_actors `include` string ("triggers,loops") into its values. */
export function parseListActorsInclude(include: string | undefined): string[] {
	return (include ?? '')
		.split(',')
		.map((v) => v.trim())
		.filter(Boolean)
}

// Shared by create_session and create_sub_chat: the same call under two names.
const startAgentInputSchema = z.object({
	workspace_id: z.string().uuid().describe('The workspace you are working in. '),
	actor_id: z.string().uuid().describe('The agent that should do the work'),
	action_prompt: z.string().min(1).describe('What you want the agent to do'),
	source_session_id: z
		.string()
		.uuid()
		.optional()
		.describe(
			"An earlier session to pick up from. The new session starts with that session's files, so use it to finish work an earlier session started but could not complete (for example, code that was written but not pushed).",
		),
	initiated_from_object_id: z
		.string()
		.uuid()
		.optional()
		.describe(
			'The bet, task, insight or other object this work is for. Leave it out if the work is not about a specific object.',
		),
	spawned_by_message_id: z
		.number()
		.int()
		.positive()
		.optional()
		.describe(
			'Normally leave this out: when you start the session from a chat, it is attached to your reply automatically. Only set it to attach the work to a specific earlier message of yours in a chat you are in; an id from a chat you are not in is ignored.',
		),
	wait: z
		.boolean()
		.optional()
		.describe(
			'Wait for the agent to finish, however long that takes, and return the session together with the first 500 lines of its output, instead of returning straight away. The wait also ends early if the agent is waiting for input, is paused or was stopped; settled false means the agent is not finished.',
		),
})

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
			workspace_id: z
				.string(createObjectsMissingKey('workspace_id', 'call'))
				.uuid()
				.describe(WORKSPACE_ID_DESCRIPTION),
			nodes: z
				.array(
					z.object({
						$id: z
							.string(createObjectsMissingKey('$id', 'node'))
							.describe('Client-side temporary ID for cross-referencing in edges'),
						type: z
							.string(createObjectsMissingKey('type', 'node'))
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
							.string(createObjectsMissingKey('status', 'node'))
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
					createObjectsMissingKey('nodes', 'call'),
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
			"Get one or more objects by ID. Default response per object: `{id, type, title, status, contextLine, url, workspaceId}` plus an always-on `setup` block (`{checks, next_steps, prose}`) — a fresh readiness check surfacing gaps (thin content, no driver, entry-status objects) to walk the user through; same shape create_objects/update_objects return. Opt into further blocks with `include:` (each adds only its own block): `content` — the object's body/description; `metadata` — the object's custom field values; `relationships` — inbound and outbound edges, each with sourceTitle and targetTitle; `connected_objects` — the objects on the other end of those edges; `events` — recent lifecycle changes and comments; `files` — metadata for files attached to the object or its comments. For a loop's deeper setup check (steps, connectors, members), call get_loop — it always returns its own `setup` block, richer than the lightweight per-object slice here. In human-facing output, refer to objects by their `title`, not their UUID. Append a short id suffix (e.g. \"Sales v4 (ca957490)\") only when two titles collide. Before you tell anyone whether something was sent, done, approved or on hold, read the task and the contact it belongs to with this tool. A drafts page, target list or search snapshot is a copy that can lag behind, and an answer taken from one is stale. If the task and the page disagree, the task wins; say so and fix the page.",
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
			'Update one or more objects and/or create relationships between existing objects. Provide updates to change object fields (title, content, status, metadata) and/or edges to create new relationships. To attach or detach files on an object, pass `attach_file_ids` (upload first with create_file) and/or `detach_file_ids` on the update entry — attached files appear under the object in the UI and are returned by get_objects. Either updates or edges (or both) must be provided. Call get_workspace_schema first to discover valid metadata fields and relationship types. Updated objects are returned with their title; created relationships include sourceTitle and targetTitle. When referring to objects in human-facing output (comments, summaries, notifications, descriptions), use the object\'s title — not its UUID. UUIDs should only appear in human-facing text when two objects share a near-identical title and disambiguation is needed — in that case append a short id suffix (e.g. "Bets and Threads v4 (ca957490)"). Use UUIDs freely inside tool arguments. When you move a draft or task to done because something was sent, also update every page that lists it (a drafts page, a target list, a contact) in the same turn, so no copy still says "unsent" or "on hold". When a human tells you they sent something themselves (their own mail or LinkedIn), log it on the contact and the task.',
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
	create_relationship: {
		description:
			"Create a relationship (graph edge) between two endpoints. Each endpoint id may point at an object or a file in the workspace — the server derives `sourceType`/`targetType` internally from the id, so callers do NOT supply type labels. Idempotent on (source_id, target_id, type): a second call with identical params returns the existing row. Returns 404 when either id resolves to neither an object nor a file in the caller's workspace. Use this to link a file to a bet from the file-detail page, wire two objects together, or attach any first-class node to any other. To remove an edge, call delete_relationship with the relationship id. It works for edges between objects and for edges that have a file at either end.",
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			source_id: z
				.string()
				.uuid()
				.describe(
					"UUID of the source endpoint. Must be an existing object or file in the caller's workspace — 404 otherwise.",
				),
			target_id: z
				.string()
				.uuid()
				.describe(
					"UUID of the target endpoint. Must be an existing object or file in the caller's workspace — 404 otherwise.",
				),
			type: z
				.string()
				.min(1)
				.describe(
					"Relationship type. Call get_workspace_schema to see this workspace's configured relationship types — built-ins like informs/breaks_into/blocks/relates_to/duplicates are common defaults, plus `attached` for file-attach edges.",
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
		description:
			'Delete a relationship (graph edge) by ID. Destructive and permanent: the edge is removed and cannot be restored (call create_relationship to make a new one). The objects or files at either end are not touched.',
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
			'Create a new actor (human or agent). Returns the actor details and API key (only shown once). If workspace_id is provided, the actor is added as a member with the given role — this is how to add a brand-new actor to a workspace as part of creating them. For agents the membership is written in the same step as the agent, and the role argument is ignored: a new agent is always a member (never admin or owner), and any workspace member, human or agent, can create one. Setting tools or llm_config on a new agent needs a human admin or owner caller; a member or agent caller that sends them gets a 403 and nothing is created, so leave them out to create the agent with the Maskin MCP only and set them afterwards through update_actor. To add an already-existing actor to a workspace, use update_actor with workspace_id/role instead. If auto_create_workspace is true (default for humans), a new, empty workspace is created instead. Agents default to auto_create_workspace=false, so workspace_id is effectively required when type is "agent" — omitting both fails the call rather than silently creating a workspace-less agent. For agents, use attach_skill_ids so the agent has its skills from the start; add tools.mcpServers only when the caller is a human admin or owner. attach_skill_ids requires workspace_id — with auto_create_workspace the new workspace has no existing skills, so any attach_skill_ids passed alongside it are ignored. The person who asked you gets a "Meet {name}" chat from the new agent automatically, so do not send them a second hello. Pass first_steps with 2 to 3 steps specific to the job the agent was made for, written as things the person can say to the agent. Use action "send" only for a step that reads and reports (a tap sends it as written, so prompt must equal label) and "fill" for everything else: a step that needs words only the person can supply, or that writes, sends, spends or deletes. Pass needed_integrations for the tools the agent cannot do the job without.',
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
					'Role when adding a human to a workspace via workspace_id: owner (full control), admin (manage members), member (read/write). Ignored for agents, which are always added as member.',
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
			first_steps: z
				.array(firstStepSchema)
				.min(1)
				.max(4)
				.optional()
				.describe(
					'Agents only. 2 to 3 steps specific to this agent\'s job, shown to the person as buttons in the new agent\'s intro chat. Each is { label (max 60), prompt (max 200), action }. action "send" sends the prompt as written when tapped, so prompt must equal label and not end in a space; use it only for steps that read and report. action "fill" puts the prompt in the message box for the person to finish; it may end in a space. Plain text, no line breaks. Nothing is stored on the agent.',
				),
			needed_integrations: z
				.array(z.string().min(1).max(100))
				.min(1)
				.max(4)
				.optional()
				.describe(
					'Agents only. Provider names of the integrations this agent cannot do its job without, for example "linear", "gmail", "slack", "github". The intro names up to 3 of them and points the person to Settings, Integrations. Names with no tools an agent could use are ignored.',
				),
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
			'Update an actor by ID. Can change name, email, description (short one-liner, max 80 chars), system_prompt / instructions (agents only), tools configuration, llm_config (agents only), workspace skill attachments (attach_skill_ids / detach_skill_ids), and optionally add the actor to a workspace (workspace_id + role) in the same call. This is how to add an already-existing actor to a workspace — for adding a brand-new actor to a workspace as part of creating them, use create_actor instead. Changing the `tools` of another actor needs owner or admin. A `tools` config read back from get_actor can be sent as-is: env and header values shown as `********` keep their stored value, provided the server command, args and url are unchanged.',
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
			"List actors (humans and agents). If workspace_id is provided, returns members of that workspace with their role. If omitted, returns actors across all workspaces the caller belongs to, each annotated with their workspace memberships. Each row is short: id, type, `title` (the actor's name), status, role, the actor's one-line `description` and a link. Agent rows in a workspace listing also carry `skills`: the names of the agent's valid workspace skills, sorted (omitted for humans and when the agent has none; names only, call `get_actor` for the rest). Call `get_actor` for the full `system_prompt` (instructions) and for one agent's triggers and loops, which is also how to pick up context on a human teammate @mentioned in a comment. To get `connectedTriggers`/`connectedLoops` for many agents at once, pass `include=triggers,loops` together with a `workspace_id`: each is then a list of `{ name, url }` (omitted when there are none; never returned for the cross-workspace listing, since a trigger/loop belongs to exactly one workspace). To find one agent without paging, pass `name` (exact match, case-insensitive) or `name_prefix` (case-insensitive prefix), not both: they are workspace-scoped, use `workspace_id` (or the default workspace when it is omitted), return an empty list when nothing matches, and return every agent that shares an exact name. The workspace-scoped path pages via a snapshot-consistent cursor (default page: 25) — pass `next_cursor` from the previous response as `cursor` to fetch the next page. The cross-workspace listing (no `workspace_id`) does not support cursor pagination — use `offset` to page it instead.",
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
			include: z
				.string()
				.regex(LIST_ACTORS_INCLUDE_PATTERN, {
					message: `include must be a comma-separated list of: ${LIST_ACTORS_INCLUDE_VALUES.join(', ')}`,
				})
				.optional()
				.describe(
					'Comma-separated extra fields to add to each row: `triggers` (connectedTriggers), `loops` (connectedLoops) or `triggers,loops`. Omit for the short default row. Only used when `workspace_id` is set; ignored for the cross-workspace listing.',
				),
			name: z
				.string()
				.min(1)
				.max(128)
				.optional()
				.describe(
					'Return only actors whose name equals this, case-insensitive (1-128 characters). Not combinable with `name_prefix`. Scoped to `workspace_id`, or to the default workspace when `workspace_id` is omitted.',
				),
			name_prefix: z
				.string()
				.min(1)
				.max(64)
				.optional()
				.describe(
					'Return only actors whose name starts with this, case-insensitive (1-64 characters). Not combinable with `name`. Scoped to `workspace_id`, or to the default workspace when `workspace_id` is omitted.',
				),
		}),
	},
	get_actor: {
		description:
			"Get an actor by ID. Returns `actor` — the full record, including `description` (short one-liner), `system_prompt` / instructions (longer context on who the actor is and how to work with them), `skills` (id + name of workspace skills attached to the actor), and `connectedTriggers`/`connectedLoops` (the triggers/loops wired to this actor, same as `list_actors`) — alongside `heroCard`, a display-only summary of that same actor with a subset of the fields under camelCased names. The two are the same record, not a full and a truncated copy; read `actor`. For an agent, `access` lists what it can use: each integration with its level (`none`, `read`, `read_write`), whether the level is the agent's own (`grant`) or the integration's default, and whether its MCP server is attached, plus each saved Keychain credential and whether it has access. It is the same access shown on the Integrations, Keychain and agent pages; change it with `update_integration_access`. When `workspace_id` is given, `status` reflects the actor's membership role in that workspace (owner/admin/member), matching `list_actors`' workspace-scoped `status`. When a human is @mentioned on a comment, call this to pick up their instructions and tailor your reply. This tool is read-only — to change any of these fields, including `system_prompt`, `tools` and skill attachments, use `update_actor`. In `tools`, every env and header value is shown as `********` unless you are that actor or an owner/admin of a workspace it belongs to; keys, commands, args and urls stay visible.",
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
			"List workspaces accessible to the authenticated actor. Use this to discover workspace IDs, which can be passed to any workspace-scoped tool via the workspace_id parameter. Each row has id, name, role, createdAt, updatedAt, onboardingEnabled and isDefault; pass include_settings: true to also get each workspace's settings (secrets redacted). isDefault is true for the one workspace the user chose as their default in Settings (at most one row; none if they have not chosen). Prefer it when the user does not name a workspace. Paginated via a snapshot-consistent cursor (default page: 25) — pass `next_cursor` from the previous response as `cursor` to fetch the next page.",
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
			include_settings: z
				.boolean()
				.optional()
				.describe(
					'When true, rows are the full workspace records including settings (statuses, field definitions, display names), with secrets redacted. Defaults to false.',
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
			kind: z
				.enum(['briefing'])
				.optional()
				.describe(
					'What the file is for. Set `"briefing"` on an HTML page written to be read in the For you tab (the Chief of Staff\'s daily briefing, a loop\'s briefing). Only files with kind "briefing" appear there — every other file a loop produces stays out of it. Omit for ordinary files.',
				),
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
			'List files in the workspace, newest first. Pass `q` to filter by name substring, or `kind: "briefing"` to list only the briefings shown in For you. Paginated via a snapshot-consistent cursor (default page: 25) — pass `next_cursor` from the previous response as `cursor` to fetch the next page.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			q: z.string().optional().describe('Case-insensitive substring match on file name.'),
			kind: z.enum(['briefing']).optional().describe('Only files of this kind.'),
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
			'Get a single file with its content and a viewer URL. The response includes an `encoding` field: "utf8" for text MIME types (markdown, HTML, JSON, code) means `content` is the raw string; "base64" for binary types means `content` is base64-encoded bytes. The response also includes an `annotations` array — pinned review comments humans left on the rendered file, each with a CSS `selector` and normalized `bounds` identifying the element, plus the human\'s `comment`. Read these to see exactly what a reviewer flagged and where. Use this when you need to read, summarise, act on review feedback, or hand the URL to a user. The response also carries `contentHash` — pass it as `if_match` to update_file so your write is refused if someone saved the file in between.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			id: z.string().uuid().describe('File ID.'),
		}),
	},
	update_file: {
		description:
			'Update a file. Pass any subset of name, description, kind, mime_type, content. Updating content re-uploads the bytes; other fields update metadata only. For text content pass `content` as a raw string (encoding defaults to "utf8"); for binary content set `encoding` to "base64". At least one field must be provided. To avoid overwriting a save made since you read the file, pass the `contentHash` from get_file as `if_match`: a stale hash fails with a 409 conflict, writes nothing, and the error carries the current hash. Re-read the file with get_file, merge, and retry with the new hash. Without `if_match` the last write wins.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			id: z.string().uuid().describe('File ID.'),
			name: z.string().min(1).max(255).optional(),
			description: z.string().max(1000).nullable().optional(),
			kind: z
				.enum(['briefing'])
				.nullable()
				.optional()
				.describe(
					'What the file is for. Set `"briefing"` on an HTML page written to be read in the For you tab (the Chief of Staff\'s daily briefing, a loop\'s briefing). Only files with kind "briefing" appear there — every other file a loop produces stays out of it. Omit for ordinary files.' +
						' Pass null to clear.',
				),
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
			if_match: z
				.string()
				.regex(/^[0-9a-f]{64}$/, 'Expected a sha256 hex digest')
				.optional()
				.describe(
					'Version check. The `contentHash` from get_file. If the file changed since, the update is refused with a 409 conflict and nothing is written. Optional.',
				),
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
			'Get the workspace activity log. Every mutation (create, update, delete) is recorded as an event. Use this to see what changed, track agent activity, or audit changes. Pass `id` to fetch a single event by its numeric event_id (e.g. the one quoted in a trigger prompt). Filter by entity_type (object|relationship|integration|capability_source|workspace) and action (created|updated|deleted|status_changed|capability_changed|capability_snapshot|capability_scan_completed). The daily capability scan writes: capability_changed (entity_type capability_source) lists tools newly available to agents, capability_snapshot (capability_source) is the stored tool list per source, capability_scan_completed (entity_type workspace) is one count per workspace per day. Paginated via a snapshot-consistent cursor — pass `next_cursor` from the previous response as `cursor` to fetch the next page.',
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
		description: `One way to communicate with humans, alongside chat. A comment is attached to an object (bet, task, insight), so it stays with that object as a visible record. Post comments here for status updates, questions, findings, decisions, blockers, and anything else a human needs to see about that object. Do NOT bury that dialogue in \`bet.content\`, \`task.content\`, or object titles — those fields are the durable spec, not the conversation, and humans don\'t scan them for new information. If you\'re tempted to edit a description to "let someone know" something, that belongs in a comment.\n\n${HUMAN_MESSAGE_STYLE_SHORT} A chart or task checklist (see the \`content\` and \`metadata\` param docs) is available when it makes a comment clearer or shorter.\n\nWhen you need a human to make a call rather than just read something, put that human in \`mentions\` and fill in \`decision\` — that pair is the only way an ask reaches their For You feed as a decision they can answer in one tap. See the \`decision\` param docs for the required shape and house style; the API rejects a decision that breaks them, listing every violated rule at once.\n\nThread defaulting: when this session was dispatched from a comment (any triggering comment on this or another object), your reply is threaded inside that triggering thread automatically — you do not need to set \`parent_event_id\`. Pass \`parent_event_id\` explicitly only when you want to reply under a DIFFERENT comment than the one that spawned you. Set \`no_thread: true\` on the rare occasion you deliberately want a fresh top-level comment (e.g. opening a new topic on a bet) rather than a reply inside the current thread.\n\nWho gets woken: a comment wakes an agent only if you put that agent in \`mentions\`. A comment from an agent with no mentions wakes nobody, so when you hand work to another agent or need a reply, mention them; a reply with no mentions is read only by whoever opens the object. Humans you mention are notified.`,
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			...createCommentSchema.shape,
			no_thread: z
				.boolean()
				.optional()
				.describe(
					'Set to true to force a new top-level comment on `entity_id`, opting out of the automatic reply-in-thread default. Only use when you deliberately want to open a new topic rather than reply inside the thread that dispatched this session. Ignored if `parent_event_id` is also set — an explicit parent always wins.',
				),
		}),
	},

	// ─── Conversations ───────────────────────────────────────
	get_conversation: {
		description:
			"Get a conversation's title and current participant list (humans and agents). Call this before replying so you know who else is in the room. Each agent also carries a `status` (starting, running, waiting_for_input, paused or not_running) so you can see who has a live session before you @mention them. Everyone listed sees every message, so there is no need to ask permission before addressing a human participant; to make an agent participant respond, @mention it with its actorId via `metadata.mentions` of post_conversation_message. This tool is read-only.",
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			conversation_id: z.string().uuid(),
		}),
	},
	list_chats: {
		description:
			'List the chats you are a participant in, most recent activity first. Each row has the chat id and title, its participants (name and type), when the last message was posted, who wrote it and whether that was you (last_message.is_you), a short snippet of it, and unread_count for you. Read a chat you find here with list_conversation_messages. Use updated_after (ISO time) to see only chats with a message since then, and has_human to keep only chats that still include a person. Archived chats are left out. Paginated (default page: 25) — pass `next_cursor` from the previous response as `cursor` to fetch the next page. This tool is read-only.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			updated_after: z
				.string()
				.datetime({ offset: true })
				.optional()
				.describe('ISO 8601 time. Only chats with a message after it are returned.'),
			has_human: z
				.boolean()
				.optional()
				.describe('When true, only chats with at least one human participant are returned.'),
			subject_type: z
				.enum(['object', 'loop'])
				.optional()
				.describe('With subject_id: only the chat that belongs to this bet/task/insight or loop.'),
			subject_id: z.string().uuid().optional(),
			limit: z.number().int().min(1).max(100).optional(),
			cursor: z
				.string()
				.optional()
				.describe(
					'Opaque cursor returned as `next_cursor` on a prior response. When set, the walk continues where that page ended.',
				),
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
		description: `Post a message into a conversation you are a participant in, mid-turn. You do NOT need this tool for your actual reply: whatever you write at the end of your turn is posted into the chat automatically. Use it for an interim note — most usefully a short heads-up, before you start something that will take a while, saying what you are going into so the human isn't left waiting in silence. That is optional; skip it when the message just wants a direct answer. Read the recent messages with list_conversation_messages first if you need more context than what triggered this session. Posting "okay" or "got it" style acknowledgements with nothing else adds noise, not value. To make another agent participant respond, pass its name in \`mention_names\` (or its actorId from get_conversation in \`metadata.mentions\`); writing its name in \`content\` alone does not wake it. Humans in the conversation see every message without a mention. This tool cannot render cards (Connect, Keychain, computer or question cards): a card key in \`metadata\` is rejected with an error, so never write card text yourself or tell the human a card is shown. To show a Connect card call connect_integration. If a mentioned actor ID matches nobody in the workspace, the response lists it in \`unresolved_mentions\`; the message is still posted, so look the actor up and post a correction. Hard limit: ${MESSAGE_MAX_LENGTH} characters.`,
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			conversation_id: z.string().uuid(),
			content: z.string().min(1).max(MESSAGE_MAX_LENGTH),
			metadata: messageMetadataSchema.optional(),
			mention_names: z
				.array(z.string().min(1).max(200))
				.max(20)
				.optional()
				.describe(
					'Display names of conversation participants to @mention, as get_conversation lists them (for example "Strategist"). Resolved server-side to actor IDs and merged into `metadata.mentions`, so you do not have to copy a UUID. Names that match nobody, or more than one participant, are returned in `unresolved_mentions` and are not mentioned.',
				),
			sub_chat_session_id: z
				.string()
				.uuid()
				.optional()
				.describe(
					'Talk to a sub-chat you started with create_sub_chat: the message goes in its thread and to its agent, which takes it while it runs or starts a follow-up if it has ended. `conversation_id` is the chat the sub-chat lives in. The response says how it got there (`delivered_to_session`: live, continued or not_delivered). Fails if the sub-chat is not attached to a message yet; it is once the reply that started it has been posted.',
				),
			thread_root_id: z
				.number()
				.int()
				.positive()
				.optional()
				.describe(
					'Reply inside the thread under this message of the chat instead of posting at the top level. If a sub-chat hangs from that message, the reply also goes to its agent. Most callers want sub_chat_session_id instead.',
				),
			wait: z
				.boolean()
				.optional()
				.describe(
					'After posting, hold until every agent you @mentioned (or, with no mention, every other agent in the chat) has finished its reply, and return those replies. Ends early with settled false if an agent never starts or the wait runs out; read the chat later with list_conversation_messages. Only use this when you cannot go on without the answer.',
				),
		}),
	},
	create_chat: {
		description: `Start a brand-new top-level chat with other agents and/or people, with you in it. It shows up in the chat list on its own, separate from the chat you are in now. Use it for a new topic that deserves its own room. To hand a task to an agent from inside the chat you are already in, use create_sub_chat instead: that stays in a thread under your message rather than opening a new chat. Give \`participant_actor_ids\` (agents are woken by \`first_message\` automatically; people just see it) and a \`title\`. The first message is posted as you, so write it as a clear request. Set \`wait: true\` to hold until the agents have replied. After that, talk in it with post_conversation_message, add people with add_chat_participant, and read it with list_conversation_messages. Pass \`subject_type\` and \`subject_id\` to open (or rejoin) the chat that belongs to a bet, task, insight or loop. Hard limit on the first message: ${MESSAGE_MAX_LENGTH} characters.`,
		inputSchema: z.object({
			workspace_id: requiredWorkspaceId,
			title: z.string().min(1).max(CONVERSATION_TITLE_MAX_LENGTH),
			participant_actor_ids: z
				.array(z.string().uuid())
				.max(MAX_CONVERSATION_PARTICIPANTS)
				.describe(
					'The agents and people to put in the chat. You are added automatically. Get ids from list_actors.',
				),
			first_message: z
				.string()
				.min(1)
				.max(MESSAGE_MAX_LENGTH)
				.optional()
				.describe(
					'What you open the chat with. Every agent in `participant_actor_ids` is @mentioned on it so they start. Leave it out to open an empty chat.',
				),
			subject_type: z
				.enum(['object', 'loop'])
				.optional()
				.describe(
					'With subject_id: tie the chat to an object (bet, task, insight) or a loop. Asking again returns the chat that already exists for it.',
				),
			subject_id: z.string().uuid().optional(),
			wait: z
				.boolean()
				.optional()
				.describe(
					'Hold until the agents have answered the first message and return their replies. Ends early with settled false if one never starts or the wait runs out.',
				),
		}),
	},
	add_chat_participant: {
		description:
			'Bring an agent or a person into a chat you are in, so they see everything from now on and can be @mentioned. Use it when you need a teammate who is not in the room. Anyone in the workspace can be added. Adding someone who is already in does nothing, and someone who left comes back. Mentioning an agent with post_conversation_message also pulls it in, so you only need this to add someone without saying anything yet, or to add people. Read who is in the chat with get_conversation.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			conversation_id: z.string().uuid(),
			actor_ids: z.array(z.string().uuid()).min(1).max(MAX_CONVERSATION_PARTICIPANTS),
		}),
	},
	remove_chat_participant: {
		description:
			'Take an agent or a person out of a chat you are in. They stop seeing new messages and can no longer be woken by a mention, but what they already wrote stays. You can remove yourself, or anyone if you started the chat; otherwise it is refused. Use it to clear out an agent whose part is done. To stop an agent that is working right now, use stop_chat_agent. Read who is in the chat with get_conversation.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			conversation_id: z.string().uuid(),
			actor_id: z.string().uuid().describe('The participant to remove'),
		}),
	},
	get_chat_activity: {
		description:
			"See what the agents in a chat actually did: their tool calls, thinking, errors and results, turn by turn, not just the messages they posted. Give the chat's `conversation_id` and, to look at one agent, its `actor_id`; without it you get every agent that has run in the chat. Each agent entry says whether it has a live session (`status`: starting, running, waiting_for_input, paused or not_running) and carries the same trace get_session_activity returns for its latest run (use `limit_turns` to see more turns). For an agent you started with create_sub_chat, pass the sub-chat's `session_id` instead. This tool is read-only — to stop an agent that is working use stop_chat_agent, to talk to it use post_conversation_message.",
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			conversation_id: z.string().uuid().optional(),
			actor_id: z.string().uuid().optional().describe('Only this agent'),
			session_id: z
				.string()
				.uuid()
				.optional()
				.describe('A sub-chat from create_sub_chat, instead of conversation_id'),
			limit_turns: z
				.number()
				.int()
				.min(1)
				.max(20)
				.default(3)
				.describe('Newest N turns to return per agent'),
		}),
	},
	stop_chat_agent: {
		description:
			"Interrupt an agent that is running in a chat right now. The agent stops what it is doing; it stays in the chat and wakes again the next time someone @mentions it. Give the `conversation_id` and the agent's `actor_id` (see get_chat_activity or get_conversation for who is running). Use it when an agent is going the wrong way or has run too long. For a sub-chat from create_sub_chat, pass its `session_id` instead.",
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			conversation_id: z.string().uuid().optional(),
			actor_id: z.string().uuid().optional().describe('The agent to stop'),
			session_id: z
				.string()
				.uuid()
				.optional()
				.describe('A sub-chat from create_sub_chat, instead of conversation_id'),
		}),
	},

	create_trigger: {
		description:
			"Create an automation trigger that fires an agent on a schedule or event. Cron triggers run periodically (config: { expression: '*/5 * * * *' }). Event triggers fire on mutations (config: { entity_type: 'object', action: 'created', filter: { ... } }). The target_actor_id must be an agent actor. The model route (llm_route, llm_oauth_slot) is not set on triggers: it is resolved at dispatch from the target agent and workspace settings, and sending either in config is rejected.",
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			name: z.string(),
			type: z.enum(['cron', 'event']),
			config: z
				.record(z.unknown())
				.describe(
					'For cron triggers: { "expression": "*/5 * * * *" }. For event triggers: { "entity_type": "object", "action": "created"|"updated"|"deleted"|"status_changed", "filter": { ... } }',
				),
			action_prompt: z.string().describe(TRIGGER_PROMPT_GUIDANCE),
			target_actor_id: z.string().uuid(),
			enabled: z.boolean().default(true),
		}),
	},
	update_trigger: {
		description:
			'Update a trigger by ID. Can change name, schedule/event config, action_prompt, target agent, or enabled/disabled state. The model route (llm_route, llm_oauth_slot) is not set on triggers: it is resolved at dispatch from the target agent and workspace settings, and sending either in config is rejected.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			id: z.string().uuid(),
			name: z.string().min(1).optional(),
			config: z.record(z.unknown()).optional(),
			action_prompt: z.string().min(1).optional().describe(TRIGGER_PROMPT_GUIDANCE),
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
			"Create a Loop — an iterative process where agents (and humans) work toward a goal, driven by STEPS that fire an agent when an object of any type changes state (event) or on a schedule (cron). A step and a trigger are the same thing, created two different ways: `steps` authors brand-new triggers inline in this call (you supply name/agent_id/prompt/when); `trigger_ids` attaches triggers that already exist. Both land in the same place — the loop's step list — and the response nests each step's resolved agent directly under it (there is no separate flat agent list, since the trigger is what determines which agent runs a step). Before authoring a step or attaching a trigger_ids entry, call list_actors (and list_triggers, to see a candidate trigger's current target agent) and confirm the agent's role and system_prompt genuinely fit the work — never default to an unrelated or generic agent/trigger just because one is on hand. Where nothing fits, create a fresh, specialized agent (create_actor) and/or trigger (an inline step, or create_trigger) instead of repurposing a mismatched pair — loops are more reliable when each step is run by an expert, single-purpose agent. MEMBER OBJECTS are the objects currently flowing through the loop (any type — call get_workspace_schema to discover types and statuses), linked via `in_loop` relationships. `status` is a graduated-trust ladder (draft → pilot → supervised → live, in that order) that can be paused from any point on the ladder — pausing disables every trigger the loop references, so nothing fires until it's resumed. `archived` is a terminal retirement state for loops that are no longer in service. A loop is OPEN when it has no feedback mechanism, CLOSED when one of its steps is a feedback step — an event trigger on the close condition (e.g. when an object reaches a done status) whose agent captures learnings (create an insight/knowledge object linked with `informs`), improves the loop, and/or seeds the next object into it. Prefer closing every loop. To put a human ON the loop, add a step whose agent @mentions that human on the relevant object via create_comment — human participation is a step like any other. If custom object types flow through the loop, pass `closed_statuses` so the loop knows which statuses mean done; pass `closed_when` when an object counts as done by a metadata value (for example loop_stage=live) rather than a status. All ids, types, and statuses are validated against the workspace — unknown ones fail with a clear error instead of silently creating a loop with no working steps. The loop object and its `in_loop` membership edges are created atomically; attach more steps or objects later with update_loop; read loops back (with live stats) via list_loops. NOTE: this creates a custom loop from scratch — to install a pre-packaged marketplace loop template, use get_started instead.",
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
					`Plain-language condition for when an object is done and leaves the loop, e.g. "The task reaches status done or discarded". ${CLOSE_CONDITION_GUIDANCE}`,
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
			closed_when: closedWhenSchema,
			tags: loopTagsSchema.optional(),
			targets: loopTargetsSchema.optional(),
		}),
	},
	update_loop: {
		description:
			"Update a Loop: rename it, change its status or entry/close conditions, add inline steps, attach/detach triggers (the loop's steps), add/remove the objects flowing through it, and set closed_statuses for custom object types (or closed_when for metadata-based done rules). A step and a trigger are the same thing — see create_loop's description for how `steps`/`trigger_ids` relate and how to pick an agent that actually fits before authoring or attaching one; the same guidance applies to add_steps/add_trigger_ids here. Use add_steps with an event `when` on the close condition to CLOSE an open loop — i.e. add the feedback step that captures learnings and seeds the next object when a member object reaches its end state. Trigger membership is stored on the loop row as metadata.trigger_ids — add_steps/add_trigger_ids/remove_trigger_ids do a safe read-modify-write of that list (added ids are validated against the workspace's triggers). Setting `status` to `paused` disables every trigger currently on the loop (including ones just added in this same call); moving off `paused` re-enables them. Object membership is an `in_loop` relationship edge — add_object_ids creates edges (idempotent; already-member objects are fine), remove_object_ids deletes them. Find loop ids with list_loops. Fails with a clear error if the target object is not a loop — use update_objects for regular objects.",
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
				.describe(
					`New plain-language close condition. Pass an empty string to clear. ${CLOSE_CONDITION_GUIDANCE}`,
				),
			closed_statuses: closedStatusesSchema,
			closed_when: closedWhenSchema,
			tags: loopTagsSchema.optional(),
			targets: loopTargetsSchema.optional(),
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
			"Start another agent on a task (the older name of create_sub_chat, which does the same; prefer create_sub_chat). It works on its own, separately from you. By default this returns straight away with the new session's details; check on it later with get_session (add `include_logs: true` to see what it did). If you can't continue without its answer, set `wait: true` and this call will hold until the agent is finished, however long that takes, then give you the session and its output. The wait also ends early if the agent is waiting for input, is paused, or was stopped. If the response says `settled: false` the agent is not finished (waiting for input, or paused); check it later with get_session. Waiting holds you up, so only do it when you need the result. Otherwise let it run: when it finishes, its final message is sent back to you as a new turn in your own chat (or as a comment on the object you were started from), so you do not need to poll it. There is no way to switch this off. To talk to the agent while it works, use send_session_message; to carry on with it after it has ended, failed or been paused, use resume_session. Do not @mention it in a chat for this: a mention reaches a different session of that agent, not this one. You can also @mention the agent in a comment on the object. When you start this from a chat, the person you are talking to sees it under your reply as a handoff card with a live status and can open the agent's thread from it, so give `action_prompt` a clear first line: it becomes the card's title.",
		inputSchema: startAgentInputSchema,
	},
	create_sub_chat: {
		description:
			"Hand a task to another agent from inside the chat you are in. It works in a thread under your reply, not in a new chat: the person sees it as a handoff card with live status, can open it, carry on the conversation with that agent there, and break it out into its own chat. Use this when the work belongs to the conversation you are in; to open a separate top-level chat instead, use create_chat. Returns straight away with the sub-chat's details (its `id` is the `session_id` other chat tools take); set `wait: true` to hold until the agent has finished and get its output. When it finishes, its final message comes back to you as a new turn in your own chat, so you do not need to poll. Check on it with get_chat_activity, stop it with stop_chat_agent, talk to it with send_session_message. Give `action_prompt` a clear first line: it becomes the card's title. Same as create_session, which still works.",
		inputSchema: startAgentInputSchema,
	},
	list_sessions: {
		description:
			"List sessions with optional filters (status, actor, trigger, last-updated window). By default rows are lean — { id, title, status, updated_at } — so a screen of recent sessions fits in one response. Pass verbose: true to get today's full payload (config, result, cost, tokens, timestamps) during the compat window. A response over the size cap is trimmed from the tail: _meta.truncated is true and next_cursor holds the updated_at of the last row returned. To continue, call again with the same filters, before set to next_cursor and offset left at 0; repeat until next_cursor is absent.",
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
			trigger_id: z
				.string()
				.uuid()
				.optional()
				.describe(
					'Filter to sessions spawned by a specific trigger. Complements actor_id — a session has both an actor (the agent that ran) and, when spawned automatically, the trigger that scheduled it.',
				),
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
			before: z
				.string()
				.datetime({ offset: true })
				.optional()
				.describe(
					"Cursor: pass the last row's `updated_at` from the previous page to walk backward through history. Half-open, exclusive: returns rows with `updated_at < before`.",
				),
			verbose: z
				.boolean()
				.default(false)
				.describe(
					"When false (the default), returns lean rows { id, title, status, updated_at } — ~10x smaller than the fat shape. When true, returns today's full session payload for backwards compatibility.",
				),
			limit: z.number().int().min(1).max(200).default(50),
			offset: z.number().int().min(0).default(0),
		}),
	},
	get_session: {
		description:
			'Get session details by ID. Optionally include log output from the container (stdout/stderr/system) — logs are returned newest-first so the failure lands at the top of the array. For paginated walks through log history, use get_session_logs instead. Set `wait: true` to hold until the session has finished, however long that takes, and get back the session with the first 500 lines of its output; the wait ends early if the session is waiting for input or is paused (`settled: false`). To talk to a running session use send_session_message; to carry on with one that has ended or is paused use resume_session.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			id: z.string().uuid(),
			include_logs: z
				.boolean()
				.default(false)
				.describe(
					'Include log output from the session container. When true, the response gains a `logs` array ordered newest-first (id DESC), so the ending — where a failure lives — is at the top.',
				),
			log_limit: z
				.number()
				.int()
				.min(1)
				.max(500)
				.default(100)
				.describe('Max log lines to return (only used when include_logs is true)'),
			wait: z
				.boolean()
				.optional()
				.describe(
					'Hold until the session has finished, however long that takes, then return the session with the first 500 lines of its output (oldest first) and `settled`. Ends early, with settled false, if the session is waiting for input or is paused. Ignores include_logs.',
				),
		}),
	},
	get_session_logs: {
		description:
			'Read a session\'s log history with cursor pagination. Default direction is newest-first so the caller lands on the ending, where a failure lives. Walk backward through history with before_id (rows satisfy id < before_id), tail the live stream with after_id (rows satisfy id > after_id), or compose both for the bounded window after_id < id < before_id. Pass direction: "oldest_first" (no cursor) to jump to boot. Row shape: { id, sessionId, stream, content, createdAt }.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			id: z.string().uuid().describe('Session id'),
			direction: z
				.enum(['newest_first', 'oldest_first'])
				.default('newest_first')
				.describe(
					'Which end to page from. `newest_first` (the default) returns the latest rows first — id DESC — so a caller lands on the failure. `oldest_first` returns id ASC, for the rare "jump to boot" case.',
				),
			before_id: z
				.number()
				.int()
				.positive()
				.optional()
				.describe(
					'Half-open, exclusive: rows satisfy `id < before_id`. Pages backward through history. Compose with after_id to bound the window.',
				),
			after_id: z
				.number()
				.int()
				.positive()
				.optional()
				.describe(
					'Half-open, exclusive: rows satisfy `id > after_id`. Live-tail from a known cursor. Compose with before_id to bound the window.',
				),
			stream: z
				.enum(['stdout', 'stderr', 'system'])
				.optional()
				.describe('Filter to a single log stream.'),
			limit: z.number().int().min(1).max(500).default(100).describe('Max rows per page.'),
		}),
	},
	get_session_activity: {
		description:
			"Get the compact agent activity trace for a session: per conversation-message turns, each with its steps (tool calls, thinking, text, errors), status and final result. Same wording as the web chat activity dropdown. Page toward older turns by passing the previous response's `oldest_log_id` as `before_log_id` while `has_older` is true. content and structuredContent carry the same full payload. This tool is read-only — to see raw log lines use `get_session` with `include_logs: true`; to change a session use `stop_session`, `pause_session` or `resume_session`.",
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			id: z.string().uuid().describe('Session ID'),
			limit_turns: z
				.number()
				.int()
				.min(1)
				.max(20)
				.default(5)
				.describe('Newest N turns to return (a turn = one conversation message answered)'),
			message_id: z
				.number()
				.int()
				.positive()
				.optional()
				.describe('Return only the turn triggered by this conversation message id'),
			before_log_id: z
				.number()
				.int()
				.positive()
				.optional()
				.describe('Exclusive upper bound on log id; pass a previous `oldest_log_id` to page older'),
		}),
	},
	stop_session: {
		description: 'Stop a running session',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			id: z.string().uuid(),
		}),
	},
	ask_user_question: {
		description:
			'Ask the person you are working with anything they can answer by tapping a button, and wait for their answer. Prefer this over a free-text question in your message whenever the reply fits in a few options: confirmations and approvals, timing, choosing between alternatives, picking a direction or a default, resolving ambiguity, and permission before something risky, expensive or hard to undo. Also use it for any detail only they can give when a sensible default would be a guess. Do not ask in prose when buttons would do, and do not ask when you can reasonably decide yourself. The question appears in their chat with your options as buttons; their pick comes back as your next turn. After calling it, end your turn without a closing message and do not repeat the question in your own words. Inside a chat session the answer comes back as your next turn. In a session that runs on its own (a trigger, a schedule) the question goes to the chat between the person and the Chief of Staff, and the answer goes there too, so do not wait: decide for yourself, state the assumption you made, and continue. If there is nobody to ask, the tool says so; do the same. Give 2 to 4 short options each (a one- or two-word label is ideal, with a description only when the label alone is unclear). Write options that fit the question; there is no fixed set. Common ones such as "Yes" / "No", "Proceed" / "Cancel", "Approve" / "Request changes" or "Now" / "Wait" / "Later" are only examples. A person can always type something else. For a simple yes/no, put the one-line question in `question` and a short `header` such as "Confirm" or "Proceed?". Set `multi_select` to let them pick several, and ask up to 4 related questions in one call instead of several calls.',
		inputSchema: z.object({
			questions: z
				.array(
					z.object({
						question: z.string().min(1).max(1000).describe('The full question.'),
						header: z
							.string()
							.min(1)
							.max(24)
							.describe('A short label for the question, e.g. "Job board".'),
						multi_select: z
							.boolean()
							.optional()
							.describe('Let the person pick more than one option.'),
						options: z
							.array(
								z.object({
									label: z.string().min(1).max(200),
									description: z.string().max(1000).optional(),
								}),
							)
							.min(2)
							.max(4),
					}),
				)
				.min(1)
				.max(4),
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
		description:
			"Carry on with a sub-chat that is not running (for an ordinary chat, @mention the agent with post_conversation_message instead, which wakes it whatever state it was in): one that was paused, finished, failed, timed out, ran out of tokens, died while starting, or was stopped. You do not need to know which it is. A paused session continues exactly where it stopped. One that has ended gets a follow-up session for the same agent in the same thread, which starts from your `message` (it does not get the old session's files or full history, only a short reminder of what it was asked to do). Without a `message` an ended session is told to carry on where it left off, so for one that failed or ran out of tokens you can call this with just the id; say what you want if you want something different. If the session is still running, use send_session_message instead. Set `wait: true` to hold until the agent has finished, however long that takes, and get its output; the wait ends early if it is waiting for input or paused (`settled: false`). For a session that ended, the response is the new follow-up session (`continued_from_session_id` names the old one). Only the person or agent that started the session, or someone in the chat it belongs to, can do this.",
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			id: z.string().uuid().describe('The session to carry on with'),
			message: z
				.string()
				.min(1)
				.optional()
				.describe(
					'What you want the agent to do next. Optional: left out, an ended session is told to carry on where it left off and a paused one simply continues.',
				),
			wait: z
				.boolean()
				.optional()
				.describe(
					'Wait for the agent to finish, however long that takes, and return the session with the first 500 lines of its output. Ends early, with settled false, if it is waiting for input or paused.',
				),
		}),
	},
	send_session_message: {
		description:
			"Send a message to a sub-chat you started with create_sub_chat while it is running, as if you typed it into its thread. You can also reach it by posting with post_conversation_message and its `sub_chat_session_id`, which works whether or not it is still running. In an ordinary chat do not use this: post with post_conversation_message and @mention the agent instead. Use it to answer a question the agent asked, give it more direction, or change course while it works. It only works while the session is running: if it has ended, failed or been paused, use resume_session instead, which also takes a message. Do not @mention the agent in a chat for this; a mention reaches a different session of that agent. The call returns as soon as the message is delivered; read the agent's reply with get_session_activity, or set `wait: true` to hold until the session has finished and get its output. `wait` only works for sessions that end after replying, such as an agent you started with create_session from a chat; for a session that stays open the message is still delivered but nothing is waited for.",
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			id: z.string().uuid().describe('The running session to talk to'),
			content: z.string().min(1).describe('The message to send'),
			wait: z
				.boolean()
				.optional()
				.describe(
					'Hold until the session has finished, however long that takes, and return the session with the first 500 lines of its output. Ignored, with a note in the response, if the session stays open after replying.',
				),
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
					'Structured UI data. Known fields: actions, input_type, options, question, placeholder, multiline, suggestion, urgency_label, meta_text, tags, due_at. Other keys pass through. Set due_at (ISO 8601 time, e.g. 2026-10-26T08:00:00Z) when the human must decide before a time: their push then starts with "Before <time>". Leave it out when nothing expires.',
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
	list_for_you: {
		description:
			'The ranked list of what needs one person, exactly as the web For You page shows it for them: cards already filtered (ended session, closed or moved-on object, already read or answered) and sorted by rank, then decision cards agents addressed to them. Use this, not list_notifications, to say what needs a person. Pass their actor id. Returns { total, items }: total counts the whole list, and offset pages through it (offset 50 starts at the 51st card). Each item { rank, source (curated or decision), headline, rationale, notification_id, object_id, title, type, status, due_at, ask }; start with rank 1 and say first any card whose due_at is today. object_id, title, type and status are null for a card with no object. Read-only: to answer a card use create_comment, or update_objects to change the object.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			actor_id: z
				.string()
				.uuid()
				.describe(
					'The person whose list to read. Agents may read any member; a person only their own.',
				),
			limit: z
				.number()
				.int()
				.min(1)
				.max(FOR_YOU_TOOL_MAX_LIMIT)
				.default(FOR_YOU_TOOL_DEFAULT_LIMIT)
				.describe(
					`How many cards to return. Defaults to ${FOR_YOU_TOOL_DEFAULT_LIMIT}; total always counts the whole list.`,
				),
			offset: z
				.number()
				.int()
				.min(0)
				.default(0)
				.describe(
					'How many cards to skip from the top of the list. Pass 50 with limit 50 to read the next page when total is above 50.',
				),
		}),
	},
	list_notifications: {
		description:
			'List the raw notifications in the workspace, optionally filtered by status or type, in creation order and for every person, with nothing filtered out. This does NOT answer "what needs this person": use list_for_you for that.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			status: z
				.enum(['pending', 'seen', 'resolved', 'dismissed'])
				.optional()
				.describe('Filter by notification status'),
			type: z.enum(['needs_input', 'recommendation', 'good_news', 'alert']).optional(),
			kind: z
				.string()
				.min(1)
				.max(64)
				.optional()
				.describe('Only notifications whose metadata.kind equals this, e.g. "for_you".'),
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
			'List integrations connected to the workspace. Each row includes `defaultAgentAccess` (what agents without their own entry get) and `agentGrants` (the agents with their own access and its level), the same access shown on the Integrations, Keychain and agent pages; change it with `update_integration_access`. Paginated via a snapshot-consistent cursor (default page: 25) — pass `next_cursor` from the previous response as `cursor` to fetch the next page.',
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
			'List available integration providers, their supported events, and their MCP surface. Each provider that has one returns `{ envKey, autoInject, server }`. `server` is the paste-ready value for the `tools.mcpServers.<provider>` field of an agent — pass it to create_actor/update_actor verbatim, including any `${TOKEN}` placeholders, which are expanded inside the session container. When `autoInject` is true the integration is already wired into every agent session in the workspace and there is nothing to attach — such a provider may return no `server` at all (github is auto-injected as one `github-<owner>` entry per connected organisation, so no single spec describes it). When `autoInject` is false (the default) connecting the integration alone gives the agent NO tools, and attaching `server` to the agent is the required second step.',
		inputSchema: z.object({}),
	},
	connect_integration: {
		description:
			'Ask the user to connect an integration for a provider (e.g. "linear"). Also the way to re-authenticate a connection whose status is not active (revoked, expired, needs reconnect — see list_integrations): call it with that provider instead of telling the user to go to Settings. In a chat this shows a Connect card in the conversation — a sign-in button for OAuth providers, an input for API-key providers — and the user finishes the connection there; end your turn afterwards. Never ask the user for an API key or paste a connection link yourself. This is the only way to show a Connect card: post_conversation_message cannot render one, so never write card text or claim a card is shown without calling this tool. Outside a chat (an autonomous session, or an external MCP client) there is nobody to show a card to, so it falls back to the direct flow: OAuth providers return an install_url that must be opened in a browser (the callback is handled automatically by the server), and API-key providers (e.g. "posthog") use `api_key` and are activated immediately.',
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
					'Only for the non-chat fallback: the API key for providers whose auth type is "api_key" (e.g. "posthog"). Ignored in a chat — the user types the key into the card — so never ask the user for one.',
				),
		}),
	},
	gmail_send_email: {
		description:
			'Send an email from the workspace\'s connected Gmail account. Sending cannot be undone and is never retried. Sending needs "Read & write" access to Gmail AND a person\'s approval of each email: with "Read" or no access you cannot send, and even with "Read & write" nothing goes out until a person has approved that exact email. PREFERRED: keep the email as an object. create_objects with `metadata: { kind: "email", to: "Mette Holm <mette@northwind.dk>", subject: "...", cc: "..." }` and the email text as `content` (relate it to the contact or bet it concerns), then mention the person with create_comment (no `decision` needed). The object shows as a preview with an Approve button in For You and in chat. A person approves exactly the text they see, and any edit withdraws the approval. Call this tool with only `object_id`: it sends the object as it reads now, once, if a person approved it. If it is refused because no one approved it, end your turn; the person will approve it and you will be woken. The older way still works: send an email a person approved on a card: post a comment with `decision` (create_comment, the person in `mentions`) whose `draft` holds the email, with `to` set to the real address ("Mette Holm <mette@northwind.dk>") and the draft text starting with a line "Subject: ..." followed by the body, so the person approves the actual recipient and subject. Mark the option that sends as destructive (exactly one). End your turn. When the person has chosen that option, call this tool with only `approval_comment_id`, the id of your comment. It sends exactly the draft as the card shows it, once, and only if a person chose the send option and the draft was not changed afterwards. For several emails on one card, put them in `decision.drafts` instead of `draft` (each with its own `id`, `to` and a Subject line); the person approves each message with its own Send, and you call this tool once per message with `approval_comment_id` and that message\'s `draft_id`. Never pass `to`, `subject` or `body`: a new email cannot be sent directly, it always needs a person\'s approval first. If the answer says the outcome is unknown, do not send again: tell the person to check the Sent folder.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			to: z
				.string()
				.optional()
				.describe(
					'Recipient address, or several separated by commas. "Mette Holm <mette@northwind.dk>" or "mette@northwind.dk". Not used with approval_comment_id.',
				),
			cc: z
				.string()
				.optional()
				.describe('Cc addresses, comma separated. Not used with approval_comment_id.'),
			subject: z.string().optional().describe('Subject line. Not used with approval_comment_id.'),
			body: z
				.string()
				.optional()
				.describe('The email text, plain text. Not used with approval_comment_id.'),
			object_id: z
				.string()
				.uuid()
				.optional()
				.describe(
					'The email object to send (metadata.kind "email"). Sends it exactly as it reads now. Use alone; not with to, subject, body or approval_comment_id.',
				),
			approval_comment_id: z
				.number()
				.int()
				.positive()
				.optional()
				.describe(
					'The id of the decision comment you posted (create_comment returns it) after a person chose its send option. Sends the draft attached to that card.',
				),
			draft_id: z
				.string()
				.optional()
				.describe(
					'Only with approval_comment_id, for a card whose `decision.drafts` carries several messages: the `id` of the one message to send. Each message is approved and sent on its own. Leave out for a card with a single `draft`.',
				),
		}),
	},
	approve_object_draft: {
		description:
			'A person approves a drafted object (an email, a LinkedIn message) exactly as it reads. Called by the Approve button in the preview card, never by an agent: the server refuses any caller that is not a person, and this tool is hidden from the model.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			object_id: z.string().uuid().describe('The draft object.'),
			content_hash: z
				.string()
				.optional()
				.describe(
					"The preview's content_hash, so a draft that changed since it was shown is refused.",
				),
		}),
	},
	request_keychain_credential: {
		description:
			'Ask the user to add a credential to their Keychain by showing a card in the chat. Use it whenever you need a secret you do not have: an API key, a token, or a username and password for a website or app (for example an accounting system you must log in to). Use `connect_integration` instead for a provider Maskin integrates with directly (GitHub, Slack, Linear and the like). If the user offers or asks to give you a login, password or API key ("can I give you my LinkedIn login?", "here is my password"), call this tool right away with kind "login" or "api_key": do not refuse, do not warn about passwords in chat, and do not send them to Settings or an integration instead. This is the safe way to share it, and it applies even when the site also has an integration, if the user wants you to log in as them. The user types the value into the card and it goes straight to the encrypted vault, so you never see it and must never ask the user to paste a secret into the chat. It is saved for this workspace and shared only with the agents in this chat; the user can change who can use it in Settings → Keychain. After calling this, end your turn without a closing message. The user tells you when it is saved, and you are restarted with the credential in your environment: an API key is the env var `KEYCHAIN_BYO_APIKEY_<NAME>`, a login is `KEYCHAIN_BYO_LOGIN_<NAME>_USERNAME` and `KEYCHAIN_BYO_LOGIN_<NAME>_PASSWORD`, where <NAME> is the credential name in capitals with other characters as underscores (e-conomic → E_CONOMIC). Only works in a chat with a person; otherwise it fails and you should say what you need in your reply.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			kind: z
				.enum(['api_key', 'login'])
				.describe(
					'"api_key" for a single secret (API key, token). "login" for a username and password.',
				),
			suggested_name: z
				.string()
				.min(1)
				.max(80)
				.optional()
				.describe(
					'A short name the card pre-fills for the credential, naming the service, e.g. "e-conomic". The user can change it.',
				),
			hint: z
				.string()
				.min(1)
				.max(300)
				.optional()
				.describe(
					'One line shown on the card on what you need it for, e.g. "To log in and read the latest invoices."',
				),
		}),
	},
	list_keychain_credentials: {
		description:
			'List the credentials in the workspace Keychain by name, with their kind (api_key or login) and whether you already have access to each. Never returns a value. Use it before asking for a credential: if one with the right name exists, ask to use it with `request_keychain_access` instead of asking the user to add it again with `request_keychain_credential`. A credential you have access to is already in your environment as `KEYCHAIN_BYO_APIKEY_<NAME>`, or `KEYCHAIN_BYO_LOGIN_<NAME>_USERNAME` and `_PASSWORD`, where <NAME> is the name in capitals with other characters as underscores. Only works inside an agent session.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
		}),
	},
	request_keychain_access: {
		description:
			'Ask the user to let you use a credential that already exists in their Keychain, by showing an Allow / Not now card in the chat. Use it when `list_keychain_credentials` shows one you need and `has_access` is false. Use `request_keychain_credential` only when no such credential exists yet. You never see the value. The user chooses how long it lasts: for this chat only, or always. If they allow it you are restarted with it in your environment; if you are asked again in another chat, ask again with this tool. After calling this, end your turn without a closing message. Only works in a chat with a person; otherwise it fails and you should say what you need in your reply.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			credential_name: z
				.string()
				.min(1)
				.max(80)
				.describe('The credential name exactly as listed by list_keychain_credentials.'),
			hint: z
				.string()
				.min(1)
				.max(300)
				.optional()
				.describe(
					'One line shown on the card on what you need it for, e.g. "To read the latest invoices."',
				),
		}),
	},
	request_integration_access: {
		description:
			'Ask the user to let you use an integration that is already connected but that you are not allowed to use (or not at the level you need), by showing an Allow / Not now card in the chat. Use it when a call to a connected integration was refused for access, or `list_integrations` shows you have no access or only read when you need to write. Use `connect_integration` when it is not connected at all, and `request_keychain_access` for a saved key or login. You cannot change your own access: only the person can allow it, and `update_integration_access` refuses agents. If they allow it you are restarted with the new access. After calling this, end your turn without a closing message. Only works in a chat with a person; otherwise it fails and you should say what you need in your reply.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			integration_id: z
				.string()
				.uuid()
				.describe('The id of the connected integration, as listed by list_integrations.'),
			level: z
				.enum(['read', 'read_write'])
				.describe('What you need: "read" to look things up, "read_write" to also change things.'),
			reason: z
				.string()
				.min(1)
				.max(300)
				.optional()
				.describe(
					'One line shown on the card on what you need it for, e.g. "To post the weekly summary in Slack."',
				),
		}),
	},
	show_computer: {
		description:
			'Bring your own computer into the chat and ask the user to do something on it, by showing a card they can open to see and control the screen. Use it when a step needs a person: approving a two-factor prompt, solving a CAPTCHA, signing in with a login you are not able to use, confirming a payment, or any choice you must not make for them. Before calling it, get the computer to the right place with the desktop tools (open the site, go to the page) so the user lands on the screen where they need to act, and so the card does not open on an empty desktop. `task` is shown on the card as the instruction: say exactly what to do and when they are done, e.g. "Approve the 2FA prompt on e-conomic, then press Done." Use `request_keychain_credential` instead when what you need is a secret you can then use yourself. It is always your own computer: you cannot show another agent\'s. After calling this, end your turn without a closing message. The user presses Done on the card, which sends you a message saying they finished; then call `desktop_screenshot` to see what changed before carrying on. If they close the card without acting, they will tell you. Only works in a chat with a person; otherwise it fails and you should say what you need in your reply.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			task: z
				.string()
				.min(1)
				.max(500)
				.describe(
					'What the user should do on the computer, in one or two sentences, e.g. "Approve the 2FA prompt on e-conomic, then press Done."',
				),
		}),
	},
	update_integration_access: {
		description:
			'Change which agents may use an integration or a saved Keychain credential, and how. Only a person can do this (the person who connected it, or a workspace admin): an agent calling it is refused, and should tell the user what it needs instead. `default_agent_access` is what every agent without its own entry gets: "read", "read_write" (every agent may also write) or "none" (not for a saved key or login, which are always explicit). `agent_access` sets individual agents: "read", "read_write" (read & write; an action that cannot be undone, such as sending an email through Gmail, still waits for a person to approve it), or "none" (an explicit no that beats a read default), or "default" to remove the agent own entry. A saved key or login is on or off per agent: use "read_write" to give it, "default" to take it away. This is the same access shown under Settings → Integrations, Settings → Keychain and on the agent page, and it applies to sessions started afterwards. To see the current access, use `list_integrations` (each row has `defaultAgentAccess` and `agentGrants`) or `get_actor` (`access`).',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			integration_id: z
				.string()
				.uuid()
				.describe('The integration or saved credential, from list_integrations.'),
			default_agent_access: z
				.enum(['read', 'read_write', 'none'])
				.optional()
				.describe('What agents without their own entry get. Not allowed for a saved key or login.'),
			agent_access: z
				.array(
					z.object({
						agent_id: z.string().uuid(),
						access: z.enum(['none', 'read', 'read_write', 'default']),
					}),
				)
				.max(50)
				.optional()
				.describe('Per-agent access. "default" removes the agent own entry.'),
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
	// Agent computer: every agent has its own long-lived Linux desktop (1280x720,
	// Chromium + xterm) that it drives and humans can watch and take over from the
	// Desktop page. An agent always gets ITS OWN; only a person calling these
	// tools has to say whose (agent_id). Behind the `workspace-desktop` flag.
	desktop_screenshot: {
		description:
			'Take a screenshot of your computer (a 1280x720 Linux screen with Chromium and a terminal). Starts your computer if it is not running (a sleeping one wakes in a few seconds) — the first call can take up to a minute. Humans can watch this same screen live on the Desktop page and may take over, so call this again to see the current state before acting. Coordinates for desktop_click, desktop_move, desktop_drag and desktop_scroll are pixels in this image: (0,0) is the top-left.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			agent_id: optionalDesktopAgentId,
		}),
	},
	desktop_click: {
		description:
			'Click at a pixel position on your computer. Take a screenshot first to find the target, and another afterwards to confirm the result. Humans watching see the pointer move and click.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			agent_id: optionalDesktopAgentId,
			x: z.number().int().min(0).max(1279),
			y: z.number().int().min(0).max(719),
			button: z.enum(['left', 'middle', 'right']).optional().describe('Defaults to left.'),
			double: z.boolean().optional().describe('Double-click. Defaults to false.'),
		}),
	},
	desktop_move: {
		description: 'Move the pointer to a pixel position on your computer without clicking (hover).',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			agent_id: optionalDesktopAgentId,
			x: z.number().int().min(0).max(1279),
			y: z.number().int().min(0).max(719),
		}),
	},
	desktop_drag: {
		description:
			'Press at one pixel position on your computer, drag, and release at another (select text, move a window, drag a slider).',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			agent_id: optionalDesktopAgentId,
			from_x: z.number().int().min(0).max(1279),
			from_y: z.number().int().min(0).max(719),
			to_x: z.number().int().min(0).max(1279),
			to_y: z.number().int().min(0).max(719),
		}),
	},
	desktop_scroll: {
		description:
			'Scroll the mouse wheel on your computer. Optionally move the pointer to (x, y) first so the right window receives it.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			agent_id: optionalDesktopAgentId,
			direction: z.enum(['up', 'down']),
			amount: z.number().int().min(1).max(20).optional().describe('Wheel clicks. Defaults to 3.'),
			x: z.number().int().min(0).max(1279).optional(),
			y: z.number().int().min(0).max(719).optional(),
		}),
	},
	desktop_type: {
		description:
			'Type text into whatever has keyboard focus on your computer (click a field first). Up to 2000 characters. Use desktop_key for Enter, Tab, Escape and shortcuts. Typed text is visible to anyone watching the desktop — never type secrets you would not show them.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			agent_id: optionalDesktopAgentId,
			text: z.string().min(1).max(2000),
		}),
	},
	desktop_key: {
		description:
			'Press key combinations on your computer, in order. Each entry is an xdotool key name or "+"-joined combo, e.g. ["ctrl+l"], ["Tab", "Return"], ["alt+Tab"], ["ctrl+shift+t"].',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			agent_id: optionalDesktopAgentId,
			keys: z
				.array(z.string().regex(/^[A-Za-z0-9_]+(\+[A-Za-z0-9_]+)*$/))
				.min(1)
				.max(20),
		}),
	},
	desktop_run: {
		description:
			'Run a shell command inside your computer (the desktop VM) (not on the host and not in your own sandbox). DISPLAY is already set, so GUI programs launched here appear on your screen, e.g. `chromium --no-sandbox https://example.com &`. Returns exit code, stdout and stderr (each truncated to 20,000 characters). Default timeout 30s, max 120s. Anything meant to keep running after the command returns must be backgrounded with `&`.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			agent_id: optionalDesktopAgentId,
			command: z.string().min(1).max(10000),
			timeout_s: z.number().int().min(1).max(120).optional().describe('Defaults to 30.'),
		}),
	},
	desktop_expose_port: {
		description:
			'Make a dev server running in YOUR session sandbox (for example Vite on 5173) openable in your computer\'s browser. Start the server first, bound to 0.0.0.0 or 127.0.0.1, then call this with its port. Returns a URL like http://host.microsandbox.internal:20003 to open in Chromium on your computer (desktop_key ["ctrl+l"], desktop_type the URL, desktop_key ["Return"]). Your computer is a separate machine, so localhost there is NOT your sandbox: always use the returned URL. Idempotent: asking again for the same port returns the same URL. You have a small fixed number of ports at once; close one with desktop_close_port to free a slot. Set MASKIN_DEV_EXTERNAL=1 when starting the Maskin web dev server, or Vite rejects the host name. The tunnel closes when your session ends. Only works from inside a session.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			agent_id: optionalDesktopAgentId,
			guest_port: z
				.number()
				.int()
				.min(1)
				.max(65535)
				.describe('The port your server listens on inside your sandbox, e.g. 5173.'),
		}),
	},
	desktop_list_ports: {
		description:
			'List the dev-server ports currently open from your computer: your sandbox port, the URL to open on your computer, and the session it belongs to. Does not start your computer.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			agent_id: optionalDesktopAgentId,
		}),
	},
	desktop_close_port: {
		description:
			'Close one open dev-server port to free a slot. Pass the number after the colon in the URL desktop_expose_port or desktop_list_ports gave you (relay_port).',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			agent_id: optionalDesktopAgentId,
			relay_port: z.number().int().min(1).max(65535),
		}),
	},
} as const
