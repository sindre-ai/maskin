import {
	CONVERSATION_TITLE_MAX_LENGTH,
	DATA_QUERY_MAX_PAGE_SIZE,
	DATA_QUERY_PAGE_SIZE,
	FOR_YOU_TOOL_DEFAULT_LIMIT,
	FOR_YOU_TOOL_MAX_LIMIT,
	LOOP_STATUSES,
	MAX_CONVERSATION_PARTICIPANTS,
	MESSAGE_MAX_LENGTH,
	SAFE_METADATA_FIELD_NAME_RE,
	createCommentSchema,
	dataQuerySpecSchema,
	firstStepSchema,
	loopTargetSchema,
	loopViewRowSchema,
	messageMetadataSchema,
	notificationActionSchema,
	notificationOptionSchema,
	recordGoAheadShape,
	scheduleNextStepSchema,
	setNextStepSchema,
	skillNameSchema,
	skipDoneWhenSchema,
	starterPromptListSchema,
	updateNextStepSchema,
} from '@maskin/shared'
import { z } from 'zod'

// Loop status enum exposed by the MCP `create_loop` / `update_loop` tools: the
// shared ladder `draft` → `pilot` → `supervised` → `live`, with `paused`
// reachable from any rung and `archived` a terminal retirement state.
const MCP_LOOP_STATUSES = LOOP_STATUSES

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
				'Buttons on the card: a native JSON array (not stringified) of { label, response }.',
			),
		input_type: z
			.enum(['confirmation', 'single_choice', 'multiple_choice', 'text'])
			.optional()
			.describe(
				'Renders a structured picker instead of buttons; pair with options (single/multiple_choice) or placeholder/multiline (text). It disables the free-text "Reply to agent" input.',
			),
		options: z
			.array(notificationOptionSchema)
			.optional()
			.describe(
				'Options for single_choice / multiple_choice: a native JSON array (not stringified) of { label, value }.',
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
	.describe('Agent whose computer; agents omit it (own computer), a person must pass it.')

// Only the keys an agent writes are spelled out. Card and other server-owned keys still pass
// through (passthrough) so the handler can reject card keys by name, and the API validates the
// whole object against the full messageMetadataSchema, so nothing is accepted that was not before.
const agentMessageMetadataSchema = messageMetadataSchema
	.pick({
		attachments: true,
		mentions: true,
		context_objects: true,
		context_notifications: true,
		plan: true,
		proposed_edit: true,
	})
	.passthrough()

const optionalWorkspaceId = z
	.string()
	.uuid()
	.optional()
	.describe('Defaults to the current workspace.')

// Used by writes/reads that create or enumerate ambiguously-scoped
// resources (a brand-new loop with no existing id to inherit a workspace
// from, or an object creation call) with side effects that are expensive to
// get wrong. list_objects no longer needs it (wave 2, T4); only its
// MASKIN_MCP_LIST_CONTRACT=off definition still requires it. Requiring an explicit workspace_id here —
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
		provider: z.string().optional(),
		model: z.string().optional(),
	})
	.passthrough()
	.optional()
	.describe(
		"Agents only. The LLM provider and model this agent runs on. It always uses the workspace's connected LLM credentials (Settings → Keys); per-agent API key overrides are not supported. Extra keys pass through.",
	)

// Optional sentence on the close_condition field of create_loop / update_loop.
// Runs woken on a loop are shown this text as their finish line, so it says
// what a good one looks like. A suggestion only; nothing validates it.
const CLOSE_CONDITION_GUIDANCE =
	'Runs in this loop are shown this text, so say what done looks like. A status reached, a summary written or a check that found nothing to do all count. Short is fine.'

// Optional suggestion shown on every field an agent writes a trigger prompt
// into (create_trigger, update_trigger, and the inline steps of create_loop /
// update_loop). A suggestion only: nothing validates or rejects a prompt that
// ignores it. One constant so the places can't drift apart.
const TRIGGER_PROMPT_GUIDANCE =
	'A good trigger prompt starts with what the run is for. Say the outcome, how anyone can see it is true, what to leave alone, and when to stop and ask a person. Done can be a status that moves, a summary written, a report posted, or a check that found nothing to do.'

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
			'Agent that performs this step (an agent, not a human: put a human on the loop with a step whose agent @mentions them).',
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
					cron: z.string().min(1),
				})
				.strict(),
			z
				.object({
					object_type: z
						.string()
						.min(1)
						.describe(
							'Object type whose events fire the step, including custom types (see get_workspace_schema).',
						),
					action: z
						.enum(['created', 'updated', 'status_changed', 'deleted'])
						.describe('Which mutation fires the step; `status_changed` drives most steps.'),
					filter: z
						.record(z.unknown())
						.optional()
						.describe(
							'Equality filter on the current object row, e.g. { "status": "qualified" } or { "metadata.segment": "enterprise" }.',
						),
				})
				.strict(),
		])
		.describe(
			'When the step fires, exactly one of: { "cron": "<expression>" } for a schedule, or { "object_type", "action", "filter"? } to react to object changes. Do not mix the two forms.',
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
		'Short labels for the team or part of the business this loop belongs to, e.g. ["Sales", "EMEA"], shown as filters on Flows. Replaces the current tags; [] clears.',
	)

const loopTargetsSchema = z
	.array(loopTargetSchema)
	.max(50)
	.describe(
		'Targets the loop is measured against: a list of { label, source, actual, target } rows, optionally with ownerActorId and pace_policy ("strict" | "window"). Replaces the current targets; [] clears. A bad row is rejected with its position and field.',
	)

const loopDriverIdSchema = z
	.string({
		required_error:
			"driver_id is required: every loop needs one agent who drives it. Pick an agent whose job covers the loop's outcome (find one with list_actors), or ask the Chief of Staff to create one.",
	})
	.uuid('driver_id must be the UUID of an agent actor (find one with list_actors).')
	.describe(
		'The agent accountable for the loop: one whose job covers its outcome, preferably the owner of its main target. Must be an active agent in this workspace.',
	)

const closedStatusesSchema = z
	.record(z.array(z.string().min(1)))
	.optional()
	.describe(
		'Map of object type → statuses that count as closed for THIS loop, e.g. {"lead": ["won", "lost"]}. Needed for custom object types; bet, task and insight have defaults.',
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
		'Map of object type → "field=value" metadata rules that also count a member as closed without a status change, e.g. {"insight": ["loop_stage=live"]}. A member is closed when its status is in closed_statuses OR a rule matches. Pass {} to clear.',
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
		'Equality filter on custom metadata fields, e.g. {"segment": "enterprise"} (see get_workspace_schema).',
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

// Input of create_sub_chat. There is no `wait` or `notify_on_complete`: the call returns at once and the result always comes back.
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
	file_ids: z
		.array(z.string().uuid())
		.max(20)
		.optional()
		.describe(
			'Ids of workspace files the agent needs (an upload, a render, a working package). They are listed by name and id in its starting prompt, so it does not have to hunt for them or ask for them again.',
		),
})

/** The `sort` values of list_objects. `relevance` needs `q`. */
export const LIST_OBJECTS_SORTS = [
	'created_at_desc',
	'created_at_asc',
	'updated_at_desc',
	'updated_at_asc',
	'relevance',
] as const

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
			'Create objects with optional relationships in one atomic call. Call get_workspace_schema first (statuses, metadata fields and relationship types vary per workspace). To create a Loop use create_loop. Edges may use $id references to nodes in this call, or existing UUIDs. Attach files by uploading with create_file (or choosing from list_files) and passing `file_ids` on a node. In human-facing text use titles, not UUIDs; add a short id suffix only when two titles are near-identical.',
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
						title: z.string().optional(),
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
						driver: z.string().uuid().optional(),
						file_ids: z
							.array(z.string().uuid())
							.optional()
							.describe(
								'IDs of existing files to attach (upload first with create_file); each becomes an `attached` relationship.',
							),
					}),
					createObjectsMissingKey('nodes', 'call'),
				)
				.min(1)
				.max(50),
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
								'Relationship type (see get_workspace_schema), e.g. informs, breaks_into, blocks, relates_to.',
							),
					}),
				)
				.default([]),
		}),
	},
	get_objects: {
		description:
			"Get objects by ID. Returns {id, type, title, status, contextLine, url, workspaceId} plus an always-on `setup` block ({checks, next_steps, prose}) flagging gaps such as thin content or no driver. Add blocks with `include`: `content`, `metadata`, `relationships` (edges with sourceTitle and targetTitle), `connected_objects`, `events` (recent changes and comments), `files`. Relationships and connected objects cap at 100 per object (see `relationships_page` / `connected_objects_page`); page the rest with list_relationships and `object_id`. For a loop's deeper setup check call get_loop. In human-facing text use `title`, not the UUID. Before telling anyone whether something was sent, done, approved or on hold, read the task and its contact here: drafts pages, target lists and search snapshots can lag, and the task wins.",
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			ids: z.array(z.string().uuid()).min(1).max(50),
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
					'Blocks to add to each object. The default `[]` returns the core fields plus `setup`. `setup` is always attached; listing it is accepted and does nothing.',
				),
			wait_for_status: z
				.array(z.string().min(1))
				.min(1)
				.max(20)
				.optional()
				.describe(
					'Hold until every object in `ids` has one of these statuses (e.g. ["done", "cancelled"]), then return as usual. List every status you would accept: an object that never reaches one holds the call for all of `wait_timeout_seconds`. The response carries `wait: { settled, waited_seconds, reason? }`; settled false means the wait stopped first (timeout, not_found with `missing_ids`, or status_check_failed).',
				),
			wait_timeout_seconds: z
				.number()
				.int()
				.min(1)
				.max(3600)
				.default(600)
				.describe(
					'With wait_for_status: the longest wait in seconds. Objects have no timeout of their own, so the wait always stops here.',
				),
		}),
	},
	update_objects: {
		description:
			'Update objects and/or create relationships between existing objects; send `updates`, `edges` or both. Call get_workspace_schema first for valid metadata fields and relationship types. To edit part of a long body send `append` or `replace` ({find, with, all?}) instead of `content`; a missing or ambiguous `replace` writes nothing and says why. Attach or detach files with `attach_file_ids` (upload first with create_file) and `detach_file_ids`. In human-facing text use titles, not UUIDs. When you move a draft or task to done because something was sent, update every page that lists it (drafts page, target list, contact) in the same turn; if a human says they sent something themselves, log it on the contact and the task.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			updates: z
				.array(
					z.object({
						id: z.string().uuid(),
						title: z.string().optional(),
						content: z.string().optional(),
						append: z
							.string()
							.min(1)
							.optional()
							.describe(
								'Text added to the end of the body exactly as sent (start it with a newline to begin a new line). Not together with content or replace.',
							),
						replace: z
							.object({
								find: z
									.string()
									.min(1)
									.describe(
										'The exact piece of the stored body to change, character for character.',
									),
								with: z
									.string()
									.describe('What to put in its place. An empty string removes the piece.'),
								all: z
									.boolean()
									.optional()
									.describe('Replace every match instead of refusing when there is more than one.'),
							})
							.optional()
							.describe(
								'Change one piece of the body. If find is missing, or matches more than once and all is not true, nothing is written and the error says which. Not together with content or append.',
							),
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
								'IDs of existing files to attach (upload first with create_file); already-attached files are skipped.',
							),
						driver: z.string().uuid().nullable().optional(),
						detach_file_ids: z
							.array(z.string().uuid())
							.optional()
							.describe(
								'IDs of attached files to detach. Removes the `attached` edge only; the file stays (delete_file removes it).',
							),
					}),
				)
				.default([]),
			edges: z
				.array(
					z.object({
						source_id: z.string().uuid(),
						target_id: z.string().uuid(),
						type: z
							.string()
							.describe(
								'Relationship type (see get_workspace_schema), e.g. informs, breaks_into, blocks, relates_to.',
							),
					}),
				)
				.default([]),
		}),
	},
	set_next_step: {
		description:
			'Give an object you drive its next step: what happens, who does it, by when. At most one open or blocked step per object; a second is refused (409) unless replace: true, which closes the old one as skipped. Pass action (one short sentence), due_at (ISO time with timezone) and optionally owner_id (defaults to you). If it waits on something, pass exactly one of blocked_on_object_id, blocked_on_actor_id (blocked_reason holds the question) or blocked_on_decision_comment_id. Stores the step and wakes no one. Change or close it with update_next_step.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			object_id: z.string().uuid(),
			...setNextStepSchema.shape,
		}),
	},
	update_next_step: {
		description:
			"Change or close an object's open or blocked next step; pass only what changes (action, due_at, owner_id, status). done or skipped closes it and needs evidence (link or result; reason for skipped). blocked needs exactly one of blocked_on_object_id, blocked_on_actor_id (with blocked_reason) or blocked_on_decision_comment_id; open clears it. 404 when there is no open or blocked step: use set_next_step. To close and plan the next, set done, then call set_next_step.",
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			object_id: z.string().uuid(),
			...updateNextStepSchema.shape,
		}),
	},
	schedule_next_step: {
		description:
			'End a turn with a next step that is backed by something, instead of promising to check back. Pass object_id, action (one short sentence) and due_at (ISO time with timezone, at least 5 minutes away). By default you own it: the step is stored and you are woken at due_at on that object. With owner_id for another agent, a task is created with that agent as driver and the step waits on it; no timer is set. A person as owner is stored and nobody is woken. update_next_step or replace: true cancels the wake-up. Refused (409) while an open or blocked step exists unless replace is true; refused (429) when a self-started run already has its limit of wake-ups waiting. A wake-up more than 1 hour late does nothing. Use set_next_step when nobody should be woken.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			object_id: z.string().uuid(),
			...scheduleNextStepSchema.shape,
		}),
	},
	record_go_ahead: {
		description:
			'Record a person\u2019s go-ahead on a job: their yes to keep going without asking at each step. Pass object_id, via chat and message_id, the id of their message, which must be in a chat about this job and written by a person (yours or another agent\u2019s is refused, 403). You cannot grant it yourself; quote their message rather than asking again. Then say so in the chat and in a comment on the job. Sessions on the job then carry on with steps that send nothing in a person\u2019s name, spend nothing and delete nothing; sending, spending and deleting still need their own approval. It ends when the job closes or a person takes it back. Returns the go-ahead (200 if one exists).',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			object_id: z.string().uuid().describe('The job (object) the go-ahead is for.'),
			...recordGoAheadShape,
		}),
	},
	take_back_go_ahead: {
		description:
			'Take back the go-ahead on a job when a person says stop or you are unsure it still stands. Anyone may call it, since it only makes things safer. The next session sees no go-ahead and asks again for anything that is not a safe step. 404 when the job has none.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			object_id: z.string().uuid().describe('The job (object) to take the go-ahead back from.'),
		}),
	},
	skip_done_when: {
		description:
			'Write "list skipped, because X" on a job that needs no done-when list: one session can finish it, it undoes cleanly, nothing in it sends, spends or deletes, and no target is behind it. A plain chat question needs no skip. Anything else gets a list: propose it with create_comment and a done_when block on a decision card, mentioning the person. Refused (403) on a bet, a target or a job with a target behind it; 400 when the job already has a list.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			object_id: z.string().uuid().describe('The job (object) that needs no list.'),
			...skipDoneWhenSchema.shape,
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
			'List or search objects. Filter by type, status (one or a list), driver, updated window or custom metadata. Without `q`, newest-created first unless `sort` says otherwise. With `q`, text search on title and content ranked by match (`sort` does not reorder it). Archived rows are hidden unless `include_archived: true`. Default 25, max 100. Pass `next_cursor` as `cursor` for the next page (same filters and `q`). The page block has `has_more` and `total` (null with `q`). `detail: "concise"` returns id, type, title, status, driver, updatedAt and url only.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			q: z
				.string()
				.min(1)
				.optional()
				.describe(
					'Search text, matched against title and content (case-insensitive). When set, results are ranked by match quality.',
				),
			type: z
				.string()
				.describe('Object type. Call get_workspace_schema to see the live list.')
				.optional(),
			status: z
				.union([z.string(), z.array(z.string())])
				.optional()
				.describe(
					'One status, or a list of statuses meaning "any of these", e.g. ["todo", "in_progress"].',
				),
			driver: z.string().uuid().optional(),
			updated_before: z
				.string()
				.datetime({ offset: true })
				.optional()
				.describe(
					'ISO-8601. Returns rows with `updated_at < updated_before` (bound excluded), e.g. now - 6h to find stalled work.',
				),
			updated_after: z
				.string()
				.datetime({ offset: true })
				.optional()
				.describe(
					'ISO-8601. Returns rows with `updated_at > updated_after` (bound excluded). Combine with `updated_before` for a window.',
				),
			sort: z
				.enum(LIST_OBJECTS_SORTS)
				.optional()
				.describe(
					'`created_at_desc` (default without `q`), `created_at_asc`, `updated_at_desc`, `updated_at_asc`, or `relevance` (default with `q`, an error without it).',
				),
			detail: z
				.enum(['concise', 'full'])
				.optional()
				.describe(
					'`full` (default) returns every field of each row. `concise` returns id, type, title, status, driver, updatedAt and url only, no content.',
				),
			limit: z
				.number()
				.int()
				.min(1)
				.max(100)
				.optional()
				.describe('Max rows to return. Default 25, max 100.'),
			cursor: z
				.string()
				.optional()
				.describe(
					'Opaque `next_cursor` from a prior response. Continues the snapshot-consistent walk, so rows added or (under an updated-at order) updated after the first call cannot leak in. Works for `q` searches too.',
				),
			metadata_eq: metadataEqSchema,
			include_archived: z
				.boolean()
				.default(false)
				.describe(
					'Include rows with `status = "archived"` (excluded by default, whatever the type).',
				),
		}),
	},
	search_objects: {
		description: 'Deprecated, use list_objects with q.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			q: z
				.string()
				.min(1)
				.describe(
					'Matches title and content (case-insensitive). Only the first 6 distinct words of 3+ letters are used; the rest are ignored, not an error.',
				),
			type: z
				.string()
				.describe('Object type. Call get_workspace_schema to see the live list.')
				.optional(),
			status: z.string().optional(),
			driver_id: z.string().uuid().optional(),
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
			cursor: z
				.string()
				.optional()
				.describe('`next_cursor` from the previous response, to fetch the next page.'),
			metadata_eq: metadataEqSchema,
			include_archived: z
				.boolean()
				.default(false)
				.describe(
					'Include rows with `status = "archived"` (excluded by default, whatever the type).',
				),
		}),
	},
	create_relationship: {
		description:
			"Create a relationship (graph edge) between two objects or files; endpoint types are worked out for you. Idempotent on (source_id, target_id, type): a repeat returns the existing row. 404 when either id is neither an object nor a file in the caller's workspace. Remove an edge with delete_relationship.",
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			source_id: z
				.string()
				.uuid()
				.describe("Source object or file UUID (404 if not in the caller's workspace)."),
			target_id: z
				.string()
				.uuid()
				.describe("Target object or file UUID (404 if not in the caller's workspace)."),
			type: z
				.string()
				.min(1)
				.describe(
					'Relationship type as configured in this workspace (get_workspace_schema): informs, breaks_into, blocks, relates_to, duplicates are common defaults; `attached` for file edges.',
				),
		}),
	},
	list_relationships: {
		description:
			'List relationships. `object_id` returns every edge connected to an object in either direction; use `source_id` / `target_id` only when direction matters. Send at least one of `object_id`, `source_id`, `target_id` or `type`; unlisted parameters are rejected. Default page 25; pass `next_cursor` as `cursor` for the next page.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			object_id: z
				.string()
				.uuid()
				.optional()
				.describe(
					'Matches edges where this object is source or target. Prefer it over source_id/target_id for every edge connected to an object.',
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
			cursor: z.string().optional().describe('Opaque `next_cursor` from a prior response.'),
		}),
	},
	delete_relationship: {
		description:
			'Delete a relationship (graph edge) by ID. Permanent; create_relationship makes a new one. The objects or files at either end are untouched.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			id: z.string().uuid(),
		}),
	},
	traverse_graph: {
		description:
			"Bounded breadth-first traversal from one object over the relationships table. Returns `{ nodes: [{id, type, title}], edges: [{source, target, type}] }` plus a `truncated` flag. Use it for supersedes/contradicts chains, breaks_into hierarchies or multi-hop context in one call instead of chaining get_objects and list_relationships; prefer get_objects when you know the ids. Bounded by `max_depth` (default 3), `max_nodes` (default 200) and their product (5000 max). Nodes can be objects, files, chats (`conversation`) and sessions in the caller's workspace; the start node must be an object (404 otherwise). A default call follows every edge type, so on a loop item the siblings fill the result up to `max_nodes`: pass `edge_type_allow_list` (e.g. `attached`, `produced_by`, `spawned`, `in_loop`) or a smaller `max_depth`.",
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
					'Maximum BFS depth (1 = direct neighbours only). max_depth * max_nodes must be at most 5000.',
				),
			max_nodes: z
				.number()
				.int()
				.min(1)
				.max(1000)
				.default(200)
				.describe(
					'Max objects returned, including the start node. When it trips, `truncated` is true and `truncated_reason` is "max_nodes".',
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
						'attached',
						'in_loop',
						'produced_by',
						'spawned',
						'has_file',
					]),
				)
				.optional()
				.describe(
					'Only follow these relationship types; omit to follow all. `attached` links an object to a file, `in_loop` a loop to its items, `produced_by` a session to what it created, `spawned` a chat to a session it started, `has_file` a chat to a file uploaded in it.',
				),
			direction: z
				.enum(['outbound', 'inbound', 'both'])
				.default('both')
				.describe(
					'`outbound` follows edges source to target, `inbound` target to source, `both` (default) either way.',
				),
		}),
	},
	create_actor: {
		description:
			'Create an actor (human or agent); returns it with an API key (shown once). With workspace_id an agent joins as a member (role ignored) and a human is emailed an invitation. Agents default to auto_create_workspace=false, so workspace_id is effectively required for type "agent"; omitting both fails. Humans default to auto_create_workspace=true, which creates a new empty workspace. To add an existing agent to a workspace use update_actor. Setting tools or llm_config needs a human admin or owner caller (otherwise 403 and nothing is created): leave them out and set them later with update_actor. attach_skill_ids (needs workspace_id) gives the agent skills from the start. The requester automatically gets a "Meet {name}" chat from the new agent, so do not send another hello. Pass first_steps (2 to 3, specific to the agent\'s job) and needed_integrations. Details: docs/reference/mcp-tools.md.',
		inputSchema: z.object({
			type: z.enum(['human', 'agent']),
			name: z.string().min(1),
			email: z.string().email().optional().describe('Required for humans'),
			auto_create_workspace: z
				.boolean()
				.optional()
				.describe(
					'true (default for humans) creates a new empty workspace with the actor as owner. Agent callers cannot send true (400). For agents pass workspace_id instead.',
				),
			workspace_id: z
				.string()
				.uuid()
				.optional()
				.describe(
					'Existing workspace to add the actor to. Required for agents unless auto_create_workspace is true.',
				),
			role: z
				.enum(['admin', 'member'])
				.default('member')
				.describe(
					'Invitation role for a human when workspace_id is given: member or admin. Ignored for agents (always member).',
				),
			description: z
				.string()
				.min(1)
				.max(80)
				.describe(
					'Required one-liner (max 80 chars), shown on the Agents page. Never empty or a placeholder.',
				),
			system_prompt: z
				.string()
				.optional()
				.describe(
					'Agents only. The param that most decides agent quality: write an opinionated subject-matter-expert persona, not a bland instruction list: a clear domain and job-to-be-done, a decision framework (plus a couple of named biases), scope boundaries, how to use its tools, the output format, and ideally worked examples ending in a concrete recommendation. Bias it against hedging. If omitted, sessions use a generic default prompt.',
				),
			tools: z
				.record(z.unknown())
				.optional()
				.describe(
					'MCP server config for agents: { mcpServers: { <name>: { type, command, args, env } | { type: "http", url, headers } } }. For a connected integration copy that provider\'s `mcp.server` from list_integration_providers in under the provider name (connecting alone exposes no tools unless its `mcp.autoInject` is true). `type` ("stdio" or "http") is required on each entry.',
				),
			llm_config: actorLlmConfigSchema,
			first_steps: z
				.array(firstStepSchema)
				.min(1)
				.max(4)
				.optional()
				.describe(
					'Agents only. 2 to 3 steps specific to the agent\'s job, shown as buttons in its intro chat, each { label (max 60), prompt (max 200), action }. "send" sends the prompt as written (prompt must equal label, no trailing space) and is only for steps that read and report. "fill" puts the prompt in the message box for the person to finish: use it for anything that needs their words or writes, sends, spends or deletes. Plain text, no line breaks.',
				),
			needed_integrations: z
				.array(z.string().min(1).max(100))
				.min(1)
				.max(4)
				.optional()
				.describe(
					'Agents only. Provider names the agent cannot work without, e.g. "linear", "gmail", "slack", "github". The intro names up to 3 and points to Settings, Integrations. Names with no usable tools are ignored.',
				),
			attach_skill_ids: z
				.array(z.string().uuid())
				.optional()
				.describe(
					"Workspace skill IDs to attach on creation (agents only). Check list_workspace_skills for skills matching the agent's job; if none fit, attach none, then tell the user and ask whether to author one (create_workspace_skill).",
				),
		}),
	},
	update_actor: {
		description:
			"Update an actor by ID: name, email, description (max 80 chars), system_prompt / instructions (agents only), tools, llm_config (agents only), skill attachments (attach_skill_ids / detach_skill_ids), starter_prompts (agents only), and optionally add the actor to a workspace (workspace_id + role). This is how to add an existing agent created in this workspace to a workspace (a person or an agent created elsewhere gets 403; people join by accepting an email invitation); to add a brand-new actor while creating it, use create_actor. Changing another actor's `tools` needs owner or admin. A `tools` config read back from get_actor can be sent as-is: env and header values shown as `********` keep their stored value if the server command, args and url are unchanged.",
		inputSchema: z.object({
			id: z.string().uuid(),
			name: z.string().min(1).optional(),
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
					'MCP server config for agents: { mcpServers: { <name>: { type, command, args, env } | { type: "http", url, headers } } }. REPLACES the whole map: read the actor first and merge. For a connected integration, copy that provider\'s `mcp.server` from list_integration_providers in under the provider name. `type` ("stdio" or "http") is required on each entry.',
				),
			starter_prompts: starterPromptListSchema
				.optional()
				.describe(
					"Chips in a new chat with this agent (agents only); each entry is the label and the exact text put in the message box, so write it as the person would say it. Up to 4, 1-60 characters, no line breaks, no repeats. REPLACES the whole list; [] clears. An agent may set its own; another actor's needs owner or admin.",
				),
			llm_config: actorLlmConfigSchema,
			initials: z
				.string()
				.max(3)
				.nullable()
				.optional()
				.describe(
					'The 1 to 3 letters or digits on the agent avatar, e.g. "DEV" (saved upper case). An agent may set its own; another agent\'s needs owner or admin. "" or null resets to letters from the name. Agents only.',
				),
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
				.describe('Also add this actor to this workspace. Omit to leave membership unchanged.'),
			role: z
				.enum(['admin', 'member'])
				.default('member')
				.describe(
					'Role when adding via workspace_id: admin (manage members) or member (read/write). Ignored without workspace_id.',
				),
		}),
	},
	list_actors: {
		description:
			"List actors (humans and agents). With workspace_id, that workspace's members with their role; without it, actors across all the caller's workspaces with memberships. Rows are short: id, type, `title` (name), status, role, one-line `description`, link; agent rows in a workspace listing also carry `skills` (names, sorted). Call get_actor for an agent's full `system_prompt`, triggers and loops, or for context on a human @mentioned in a comment. To find one agent without paging, pass `name` or `name_prefix` (empty list on no match). `include=triggers,loops` with `workspace_id` adds `connectedTriggers`/`connectedLoops` lists of `{ name, url }`. The workspace path pages by cursor (default page 25): pass `next_cursor` as `cursor`; the cross-workspace listing uses `offset`.",
		inputSchema: z.object({
			workspace_id: z
				.string()
				.uuid()
				.optional()
				.describe("Scope to this workspace; omit to list across all the caller's workspaces."),
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
					'Cross-workspace listing only (no `workspace_id`); the workspace path pages via `cursor`. Default 0.',
				),
			cursor: z
				.string()
				.optional()
				.describe(
					'Opaque `next_cursor` from a prior response. Only with `workspace_id`; the cross-workspace listing has none (use `offset`).',
				),
			include: z
				.string()
				.regex(LIST_ACTORS_INCLUDE_PATTERN, {
					message: `include must be a comma-separated list of: ${LIST_ACTORS_INCLUDE_VALUES.join(', ')}`,
				})
				.optional()
				.describe(
					'Extra fields per row: `triggers`, `loops` or `triggers,loops`. Only with `workspace_id`.',
				),
			name: z
				.string()
				.min(1)
				.max(128)
				.optional()
				.describe('Only actors whose name equals this (case-insensitive). Not with `name_prefix`.'),
			name_prefix: z
				.string()
				.min(1)
				.max(64)
				.optional()
				.describe('Only actors whose name starts with this (case-insensitive). Not with `name`.'),
		}),
	},
	get_actor: {
		description:
			"Get an actor by ID. Returns `actor`, the full record: `description` (one-liner), `system_prompt` (longer context on who they are and how to work with them), `skills` (id and name), and `connectedTriggers`/`connectedLoops` (as in list_actors), plus `heroCard`, a display-only summary of the same actor; read `actor`. For an agent, `access` lists what it can use: each integration with its level (`none`, `read`, `read_write`), whether that level is the agent's own (`grant`) or the integration's default, whether its MCP server is attached, and each saved Keychain credential and whether it has access (the same as the Integrations, Keychain and agent pages; change it with update_integration_access). With `workspace_id`, `status` is the actor's membership role there (owner/admin/member). When a human is @mentioned on a comment, call this to pick up their instructions. Read-only: to change `system_prompt`, `tools` or skills use update_actor. In `tools`, env and header values show as `********` unless you are that actor or an owner/admin of a workspace it belongs to.",
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
	delete_agent: {
		description:
			'Delete another agent with its sessions, triggers, files and memory; this cannot be undone. A person must approve first: post `create_comment` on a relevant object with a `decision` card, mention the person, and put `delete_agent: { actor_id }` on the destructive option that approves it. When they choose it you are woken by their reply; then call this tool with the same `id`. Refused (403) without that approval, after 24 hours, or for another agent than the card named. You cannot delete yourself, a person or a system agent.',
		inputSchema: z.object({
			id: z.string().uuid().describe('The agent to delete: its id from list_actors.'),
			workspace_id: optionalWorkspaceId,
		}),
	},
	create_workspace: {
		description:
			'Create a new workspace. The authenticated actor becomes the owner. Only people can create workspaces: an agent key gets a 403 and nothing is created.',
		inputSchema: z.object({
			name: z.string().min(1),
			settings: z.record(z.unknown()).optional(),
		}),
	},
	update_workspace: {
		description:
			'Update a workspace by ID (name and/or settings). Settings are shallow-merged into existing ones (llm_keys is deep-merged). Keys include north_star_metric (onboarding answer), llm_keys, tags and other workspace-level configuration.',
		inputSchema: z.object({
			id: z.string().uuid(),
			name: z.string().min(1).optional(),
			settings: z
				.record(z.unknown())
				.optional()
				.describe(
					'Partial settings to merge (north_star_metric, llm_keys, tags, others). Shallow merge; llm_keys is deep-merged.',
				),
		}),
	},
	list_workspaces: {
		description:
			"List workspaces accessible to the authenticated actor. Use this to discover workspace IDs, which can be passed to any workspace-scoped tool via the workspace_id parameter. Each row has id, name, role, createdAt, updatedAt, onboardingEnabled and isDefault; pass include_settings: true to also get each workspace's settings (secrets redacted). isDefault is true for the one workspace the user chose as their default in Settings (at most one row; none if they have not chosen). Prefer it when the user does not name a workspace. Paginated via a snapshot-consistent cursor (default page: 25) — pass `next_cursor` from the previous response as `cursor` to fetch the next page.",
		inputSchema: z.object({
			limit: z.number().int().min(1).max(100).optional().describe('Default 25.'),
			cursor: z.string().optional().describe('The `next_cursor` from a prior response.'),
			include_settings: z
				.boolean()
				.optional()
				.describe('Return full workspace records with settings (secrets redacted). Default false.'),
		}),
	},
	get_workspace_schema: {
		description:
			'Get the workspace schema: statuses per object type, custom metadata field definitions (name, type, required, enum values), display names and relationship types. Call it before creating or updating objects to see which fields and values are valid. Types with Hero Card settings also carry a `hero_card` block (`hero_card_context`, `hero_card_metas`, `primary_action`) describing how they render in the Hero Card widget.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			type: z
				.string()
				.optional()
				.describe('Object type to filter by (built-in or custom). Omit for all types.'),
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
			'Add a metadata field to an object type (built-in or custom). Once added, it shows in get_workspace_schema and is accepted in create_objects and update_objects metadata. Names must be unique within a type.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			type: z.string().min(1),
			name: z.string().min(1).describe('Field name. Must be unique within the type.'),
			field_type: z
				.enum(['text', 'number', 'date', 'enum', 'boolean'])
				.describe('"enum" needs values[].'),
			required: z
				.boolean()
				.optional()
				.describe('When true, the field is required on objects of this type.'),
			values: z
				.array(z.string().min(1))
				.optional()
				.describe('Allowed enum values. Required when field_type is "enum".'),
		}),
	},
	update_workspace_field: {
		description:
			'Update a metadata field on an object type: rename, change type, toggle required, or edit enum values. Pass only what changes. For enum values prefer add_values/remove_values (idempotent); use values only to replace the whole list. Objects keep values already stored even after they are removed from the list; only new writes are constrained.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			type: z.string().min(1),
			name: z.string().min(1),
			new_name: z
				.string()
				.min(1)
				.optional()
				.describe('New name. Must stay unique within the type.'),
			field_type: z
				.enum(['text', 'number', 'date', 'enum', 'boolean'])
				.optional()
				.describe('New field type.'),
			required: z.boolean().optional().describe('New required flag.'),
			values: z
				.array(z.string().min(1))
				.optional()
				.describe(
					'Full replacement list, applied before add_values/remove_values. An empty array clears it, which is only valid if add_values then supplies at least one value. Omit to keep current values.',
				),
			add_values: z
				.array(z.string().min(1))
				.optional()
				.describe(
					'Enum values to add. Only valid for an enum field (or one changed to enum via field_type).',
				),
			remove_values: z
				.array(z.string().min(1))
				.optional()
				.describe('Enum values to remove, applied after add_values. Enum fields only.'),
		}),
	},
	delete_workspace_field: {
		description:
			'Remove a metadata field from an object type. Existing objects keep data already stored under it; new writes cannot set it. Idempotent: deleting a missing field succeeds.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			type: z.string().min(1),
			name: z.string().min(1),
		}),
	},
	// ─── Workspace Skills ─────────────────────────────────────
	// Shared, workspace-scoped skills that any agent in the workspace can be given.
	// NOT the same as per-agent skills (those live under an agent's own file store).
	list_workspace_skills: {
		description:
			'List shared workspace skills (SKILL.md files stored once per workspace, attachable to any agent; not per-agent skills). Rows omit the SKILL.md body; get_workspace_skill returns it. Find one with `q`, a word of its name or description. Default 25, max 100. The response has `page` ({ limit, returned, has_more, total }, total counts rows matching your filters) and `next_cursor` while `has_more` is true; pass it as `cursor` for the next page.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			q: z.string().min(1).optional().describe('Match in name or description, ignoring case.'),
			limit: z.number().int().min(1).max(100).optional().describe('Default 25.'),
			cursor: z.string().optional().describe('The `next_cursor` from a prior response.'),
		}),
	},
	get_workspace_skill: {
		description:
			'Get a shared workspace skill by id or name, with its full SKILL.md content. Not a per-agent skill.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			name: skillNameSchema.describe('Skill id (from list_workspace_skills) or name.'),
		}),
	},
	create_workspace_skill: {
		description:
			'Create a shared workspace skill, stored once and attachable to any number of agents. Not a per-agent skill. Content is SKILL.md (markdown, optional YAML frontmatter); the server reads the description from the frontmatter.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			name: skillNameSchema.describe(
				'Lowercase letters, numbers and hyphens, max 64 chars. Unique in the workspace.',
			),
			content: z
				.string()
				.min(1)
				.describe('Full SKILL.md. Optional YAML frontmatter supplies the description.'),
		}),
	},
	update_workspace_skill: {
		description:
			'Replace the content of a shared workspace skill, found by id or name. Affects every agent it is attached to. The server re-reads the description from the frontmatter.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			name: skillNameSchema.describe('Skill id (from list_workspace_skills) or name.'),
			content: z
				.string()
				.min(1)
				.describe('New SKILL.md content. Replaces the existing body entirely.'),
		}),
	},
	delete_workspace_skill: {
		description:
			'Delete a shared workspace skill, found by id or name. Its attachments to agents are removed too.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			name: skillNameSchema.describe('Skill id (from list_workspace_skills) or name.'),
		}),
	},
	// ─── Files ───────────────────────────────────────────────
	create_file: {
		description:
			'Create a file in the workspace (design docs, notes, reports). The response has a `url` that any workspace member can open in a browser. Text content: pass `content` as a raw string. Binary content (images, PDFs, archives): set `encoding` to "base64" and pass base64 bytes. Max 10 MB after decoding (50 MB for `video/*`). Use the real `mime_type`; markdown renders inline, other types download. The file is linked to the chat you are in; pass `conversation_id` to link another chat and `object_id` to attach it to a work item.',
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
					'Set `"briefing"` on an HTML page meant to be read in the For you tab (a daily briefing, a loop briefing). Only briefing files appear there. Omit for ordinary files.',
				),
			tags: z
				.array(z.string())
				.max(20)
				.optional()
				.describe(
					'Labels for finding the file later, e.g. "b-roll" or "clip_type:b_roll" (a colon marks a structured tag). Trimmed and lowercased on save. Up to 20, 60 characters each, no commas. Call list_file_tags first and reuse an existing tag. Put longer notes in `description`.',
				),
			mime_type: z.string().describe('MIME type, e.g. "text/markdown" or "application/pdf".'),
			content: z
				.string()
				.describe(
					'File content: a raw string for text, or base64 bytes with `encoding` "base64". Max 10 MB.',
				),
			encoding: z
				.enum(['base64', 'utf8'])
				.optional()
				.describe('Default "utf8". Use "base64" for binary files.'),
			conversation_id: z
				.string()
				.uuid()
				.optional()
				.describe('Chat to link the file to. Default: the chat you are in, if any.'),
			object_id: z
				.string()
				.uuid()
				.optional()
				.describe('Work item (bet, task, insight, ...) to attach the file to.'),
		}),
	},
	list_files: {
		description:
			'List files in the workspace, newest first. Filter by name substring `q`, `kind: "briefing"` (briefings shown in For you), or `tags` (`tags_match: "all"`, the default, needs every tag; "any" needs at least one). Rows show their `tags`. Files attached to chat messages are included: when a name search finds nothing, narrow by tag or page on with `next_cursor` instead of asking for a re-upload. `conversation_id` (a chat you are in) returns the 50 newest files attached to that chat\'s messages (name, mime type, size, who attached it, when) plus `total` and `omitted`; narrow with `type` (mime type or prefix, e.g. "video") and `uploaded_by` (actor id). With `conversation_id` the other filters and paging do not apply. Default page 25; pass `next_cursor` as `cursor` for the next page.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			q: z.string().optional().describe('Case-insensitive substring match on file name.'),
			kind: z.enum(['briefing']).optional().describe('Only files of this kind.'),
			conversation_id: z
				.string()
				.uuid()
				.optional()
				.describe(
					'List files attached to messages in this chat (one you are in) instead of the whole workspace.',
				),
			type: z
				.string()
				.optional()
				.describe('With conversation_id: mime type or prefix, e.g. "video".'),
			uploaded_by: z
				.string()
				.uuid()
				.optional()
				.describe(
					'With conversation_id: only files attached by this actor (see get_conversation).',
				),
			tags: z
				.array(z.string())
				.max(20)
				.optional()
				.describe('Files carrying these tags (see tags_match). Trimmed and lowercased.'),
			tags_match: z
				.enum(['all', 'any'])
				.optional()
				.describe('"all" (default): every tag. "any": at least one.'),
			limit: z.number().int().min(1).max(200).optional().describe('Default 25.'),
			cursor: z.string().optional().describe('The `next_cursor` from a prior response.'),
		}),
	},
	list_file_tags: {
		description:
			'List the tags in use on files and how many files carry each, most-used first. Call it before tagging or searching by tag, so you reuse an existing tag instead of inventing a near copy ("b-roll" vs "broll"). Returns `[{ tag, count }]`. Use a tag in `tags` of list_files, create_file or update_file.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
		}),
	},
	rename_file_tag: {
		description:
			'Rename a tag on every file at once, all or nothing. Fails if `to` is already a tag (use merge_file_tags) or no file carries `from`. Names are trimmed and lowercased. Returns `{ from, to, files_changed }`. Per the workspace tag guide only the Knowledge Curator renames tags: if you are not the curator, ask it instead.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			from: z.string().describe('The tag to rename. Must be on at least one file.'),
			to: z.string().describe('The new name. Up to 60 characters, no commas.'),
		}),
	},
	merge_file_tags: {
		description:
			'Merge tag `from` into `into` on every file at once, all or nothing. Files with `from` get `into` (a file with both keeps one copy) and `from` disappears from list_file_tags. `into` need not exist yet. Fails if no file carries `from`. Returns `{ from, to, files_changed }`. Per the workspace tag guide only the Knowledge Curator merges tags: if you are not the curator, ask it instead.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			from: z.string().describe('The tag to fold away. Must be on at least one file.'),
			into: z.string().describe('The tag every file with `from` should carry instead.'),
		}),
	},
	get_file: {
		description:
			'Get a file with its content and a viewer URL. Over 50 MB: `content` is empty, `contentOmitted: true` and a short-lived `downloadUrl` is given. `encoding` is "utf8" (`content` is the raw string) or "base64". `annotations` are pinned reviewer comments (CSS `selector`, `bounds`, `comment`). Pass `contentHash` as `if_match` to update_file to refuse your write if someone saved in between. HTML pages (deck, website, dashboard, custom view) are mostly embedded fonts and inline CSS or script, so raw `content` is huge: pass `format: "text"` for `content_text`, the page\'s words as markdown (headings, tables, links, labels, slide notes), plus `title`, `meta_description`, `json_ld`, `source_object_id`, `contentHash`, `extracted: true`. A `note` means the page is drawn by script: read the raw file. A large raw HTML read opens with `readable_with`. Other text files are unchanged by format "text"; binary ignores it. There is no offset or limit; use format "text" rather than paging raw bytes.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			id: z.string().uuid(),
			format: z
				.enum(['raw', 'text'])
				.optional()
				.describe(
					'"raw" (default): stored bytes as `content`. "text": `content_text`, for HTML the readable words as markdown, other text files unchanged.',
				),
			offset: z
				.number()
				.int()
				.positive()
				.optional()
				.describe(
					'Start `content` or `content_text` at this character. A long file comes back cut, and the reply says which offset to pass to read on.',
				),
		}),
	},
	transcribe_file: {
		description:
			'Transcribe an uploaded audio or video file to text. Pass the file `id` (from list_files or create_file). Audio (mp3, m4a, wav, ogg, flac, webm) and video (mp4, mov, mkv, webm) work; no need to convert. Up to 60 minutes per call; cut longer recordings into parts. Returns `{ file_id, name, transcript_file_id, transcript_file_url, text, timed }`. The transcript is saved as a .txt workspace file, one line per speaker turn (`[mm:ss] Speaker 1: text`, `timed` true), or plain text when no timing came back (`timed` false). Read it with get_file on `transcript_file_id` and share `transcript_file_url`; `text` is null unless saving failed (then it holds the transcript) or no speech was found (then no file is saved). Pass `language` (e.g. "en", "nb-NO") if known, otherwise it is detected. Counts toward plan usage; a long file can take a minute or more. Fails with 402 when the plan cap is reached (enterprise has none), and 400 for a file that is not audio or video, has no audio track, or is over the limit.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			id: z.string().uuid().describe('File ID of the uploaded audio or video file.'),
			language: z
				.string()
				.regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/, 'Use a language code such as "en" or "nb-NO"')
				.optional()
				.describe('Language hint, e.g. "en" or "nb-NO". Omit to detect it.'),
		}),
	},
	update_file: {
		description:
			'Update a file. Pass any subset of name, description, kind, mime_type, content (at least one). Updating content re-uploads the bytes; other fields update metadata only. Text: pass `content` as a raw string; binary: `encoding` "base64". To avoid overwriting a save made since you read the file, pass the `contentHash` from get_file as `if_match`: a stale hash fails with a 409, writes nothing and returns the current hash; re-read, merge, retry. Without `if_match` the last write wins. To change part of a text file pass `edits` instead of `content`: a list of `{old, new, replace_all?}` applied in order on the server. `old` must match exactly once (add context to be unique) unless `replace_all` is true; an edit that matches nothing or more than once fails with a 400 and nothing is written. `edits` and `content` cannot be combined. `edits` works with `if_match`. Copy `old` from the raw text of get_file, not the `format: "text"` extract.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			id: z.string().uuid(),
			name: z.string().min(1).max(255).optional(),
			description: z.string().max(1000).nullable().optional(),
			kind: z
				.enum(['briefing'])
				.nullable()
				.optional()
				.describe(
					'Set `"briefing"` on an HTML page meant to be read in the For you tab (a daily briefing, a loop briefing). Only briefing files appear there. Omit for ordinary files.' +
						' Pass null to clear.',
				),
			tags: z
				.array(z.string())
				.max(20)
				.optional()
				.describe(
					'Replaces the whole tag list: send every tag the file should have, or [] to clear. Omit to leave tags unchanged. Trimmed and lowercased. Up to 20, 60 characters each, no commas. Reuse tags from list_file_tags.',
				),
			mime_type: z.string().optional(),
			content: z
				.string()
				.optional()
				.describe(
					'New content: a raw string for text, or base64 bytes with `encoding` "base64". Max 10 MB.',
				),
			encoding: z
				.enum(['base64', 'utf8'])
				.optional()
				.describe('Encoding of `content`. Defaults to "utf8". Use "base64" for binary files.'),
			edits: z
				.array(
					z.object({
						old: z
							.string()
							.min(1)
							.max(200000)
							.describe(
								'Exact text to replace. Must occur exactly once unless replace_all is true.',
							),
						new: z.string().max(200000).describe('Replacement text. May be empty to delete.'),
						replace_all: z
							.boolean()
							.optional()
							.describe('Replace every occurrence of `old`. Default false.'),
					}),
				)
				.min(1)
				.max(50)
				.optional()
				.describe(
					'Partial edit of a text file, applied in order on the server. Cannot be combined with `content`. Max 50 edits.',
				),
			if_match: z
				.string()
				.regex(/^[0-9a-f]{64}$/, 'Expected a sha256 hex digest')
				.optional()
				.describe(
					'The `contentHash` from get_file. If the file changed since, the update is refused with a 409 and nothing is written.',
				),
		}),
	},
	propose_file_changes: {
		description:
			'Propose text changes to a markdown file for review instead of overwriting it. Pass the file `id` and `changes`, each with `old_text` (exact text from the file), `new_text` and optional `reason`. Each `old_text` is matched against the raw markdown and must occur exactly once (add context to be unique); changes may not overlap. If any change fails the whole call is rejected with the change index and nothing is stored. Limits: 50 changes, `old_text` up to 4000 characters, `new_text` up to 8000. Markdown files only. The file itself is not changed: the proposal is stored and the driver of each attached object is notified. Returns the proposal id and file URL. For a new file or a full rewrite, use update_file.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			id: z.string().uuid(),
			summary: z
				.string()
				.max(1000)
				.optional()
				.describe('One line on what the proposal does overall.'),
			changes: z
				.array(
					z.object({
						old_text: z
							.string()
							.min(1)
							.max(4000)
							.describe('Exact text to replace, from the raw markdown. Must match exactly once.'),
						new_text: z.string().max(8000).describe('Replacement text. Empty string deletes.'),
						reason: z.string().max(1000).optional().describe('Why, shown to the reviewer.'),
					}),
				)
				.min(1)
				.max(50)
				.describe('The proposed changes, up to 50. Must not overlap.'),
		}),
	},
	delete_file: {
		description: 'Delete a file from the workspace. Bytes are removed from storage.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			id: z.string().uuid(),
		}),
	},
	get_events: {
		description:
			'Get the workspace activity log: every mutation (create, update, delete) is an event. Pass `id` to fetch one event by its numeric event_id. Filter by entity_type (object|relationship|integration|capability_source|workspace) and action (created|updated|deleted|status_changed|capability_changed|capability_snapshot|capability_scan_completed). The daily capability scan writes capability_changed (tools newly available to agents), capability_snapshot (stored tool list per source), both on entity_type capability_source, and capability_scan_completed (entity_type workspace, one count per day). Pass `next_cursor` as `cursor` for the next page.',
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
			cursor: z.string().optional().describe('The `next_cursor` from a prior response.'),
		}),
	},
	get_comments: {
		description:
			'Get comments on an object, newest first. Replies point to the comment they answer through data.parentEventId. Pass `next_cursor` back as `cursor` for the next page.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			entity_id: z.string().uuid(),
			limit: z.number().int().min(1).max(100).default(50).describe('Defaults to 50.'),
			cursor: z.string().optional().describe('The `next_cursor` from a prior response.'),
		}),
	},
	create_comment: {
		description:
			'Comment on an object (bet, task, insight): a visible record for status updates, questions, findings, decisions and blockers. Do not bury that dialogue in `bet.content`, `task.content` or titles.\n\nTo get a human to make a call, put them in `mentions` and fill in `decision`; that pair is the only way an ask reaches their For You feed as a one-tap decision.\n\nA reply is threaded into the comment that dispatched this session automatically. Pass `parent_event_id` to reply under a different comment, or `no_thread: true` for a new top-level comment.\n\nOnly agents in `mentions` are woken, so mention the agent when you hand off or need a reply. Mentioned humans are notified.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			...createCommentSchema.shape,
			no_thread: z
				.boolean()
				.optional()
				.describe(
					'New top-level comment instead of replying in the dispatching thread. Ignored if `parent_event_id` is set.',
				),
			wait: z
				.boolean()
				.optional()
				.describe(
					'Hold until each mentioned agent has replied in the thread and return the replies. Ends early with settled false if an agent never starts or the wait runs out.',
				),
		}),
	},

	// ─── Conversations ───────────────────────────────────────
	get_conversation: {
		description:
			"Get a conversation's title and participants (humans and agents). Call it before replying to see who else is in the room. Each agent carries a `status` (starting, running, waiting_for_input, paused or not_running), so you can see who has a live session before you @mention them. Everyone listed sees every message, so no permission is needed to address a human; to make an agent respond, @mention its actorId via `metadata.mentions` of post_conversation_message.",
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			conversation_id: z.string().uuid(),
		}),
	},
	list_chats: {
		description:
			'List the chats you are in, most recent activity first. Each row has the chat id and title, participants (name and type), the last message (when, who wrote it, whether that was you in last_message.is_you, a snippet) and unread_count for you. Read a chat with list_conversation_messages. updated_after (ISO time) keeps chats with a message since then; has_human keeps chats that include a person. Archived chats are left out. Default page 25; pass `next_cursor` as `cursor` for the next page.',
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
			cursor: z.string().optional().describe('The `next_cursor` from a prior response.'),
		}),
	},
	list_conversation_messages: {
		description:
			'List messages in a conversation, newest first. Page with before_id (older) or after_id (newer), using the id of a message you already have. The main list holds top-level messages; one with replies carries a `thread` summary with its reply count. To read a thread, pass the root message id as `thread_root_id`: you get only its replies, newest first. Each row carries `metadata`; uploaded files are in `metadata.attachments`, an array of `{file_id, name, mime_type, size_bytes}`; fetch one with get_file. An upload is on the message it was sent with, so page back with before_id to find an older one. To answer inside a thread use post_conversation_message with the same `thread_root_id`.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			conversation_id: z.string().uuid(),
			before_id: z.number().int().positive().optional(),
			after_id: z.number().int().positive().optional(),
			limit: z.number().int().min(1).max(200).default(50),
			thread_root_id: z
				.number()
				.int()
				.positive()
				.optional()
				.describe('Return only the replies of the thread rooted at this message id.'),
		}),
	},
	post_conversation_message: {
		description: `Post a message into a conversation you are in, mid-turn. Not needed for your actual reply: what you write at the end of your turn is posted automatically. Use it only when blocked on a person or to bring in another agent, never for progress notes. To make another agent respond, pass its name in \`mention_names\` (or its actorId from get_conversation in \`metadata.mentions\`); writing its name in \`content\` does not wake it. Humans see every message without a mention. To answer inside a thread pass \`thread_root_id\` (the top-level message id; threads do not nest); keep \`also_in_channel\` off unless the whole chat should see it. An interim post lands in the thread your turn started from, or the main timeline if it started from a top-level message; \`top_level: true\` overrides that. It cannot render cards (Connect, Keychain, computer or question cards): a card key in \`metadata\` is rejected; for a Connect card call connect_integration. An unmatched mentioned actor ID is listed in \`unresolved_mentions\` and the message is still posted, so post a correction. Hard limit: ${MESSAGE_MAX_LENGTH} characters.`,
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			conversation_id: z.string().uuid(),
			content: z.string().min(1).max(MESSAGE_MAX_LENGTH),
			metadata: agentMessageMetadataSchema.optional(),
			mention_names: z
				.array(z.string().min(1).max(200))
				.max(20)
				.optional()
				.describe(
					'Participant names to @mention, as get_conversation lists them (e.g. "Strategist"). Resolved to actor IDs and merged into `metadata.mentions`. Names matching nobody, or more than one participant, come back in `unresolved_mentions` and are not mentioned.',
				),
			sub_chat_session_id: z
				.string()
				.uuid()
				.optional()
				.describe(
					'Talk to a sub-chat you started with create_sub_chat: the message goes in its thread and to its agent, which takes it while running or starts a follow-up if it has ended. `conversation_id` is the chat the sub-chat lives in. The response reports `delivered_to_session` (live, continued or not_delivered). Fails until the reply that started the sub-chat has been posted.',
				),
			thread_root_id: z
				.number()
				.int()
				.positive()
				.optional()
				.describe(
					"Reply in the thread under this top-level message of the conversation (pass the thread's root, not a reply). A sub-chat hanging from it gets the reply too; most callers want sub_chat_session_id instead.",
				),
			also_in_channel: z
				.boolean()
				.optional()
				.describe('With thread_root_id: also show the reply in the main timeline.'),
			top_level: z
				.boolean()
				.optional()
				.describe(
					'Post in the main timeline even though your turn started from a thread message. Without it such a post goes into that thread. Ignored when thread_root_id or sub_chat_session_id is given.',
				),
			wait: z
				.boolean()
				.optional()
				.describe(
					'Hold until every agent you @mentioned (or, with no mention, every other agent in the chat) has replied, and return the replies. Ends early with settled false if an agent never starts or the wait runs out; read the chat later with list_conversation_messages.',
				),
		}),
	},
	create_chat: {
		description: `Start a top-level chat with other agents and/or people, with you in it, separate from the chat you are in. With one other actor and no subject this opens your direct message with them (each pair has exactly one, so asking again returns it). \`topical: true\` makes a new room for a topic; with two or more others it is always a new chat. To hand a task to an agent from the current chat, use create_sub_chat instead (a thread under your message). Give \`participant_actor_ids\` (agents are woken by \`first_message\`; people just see it) and a \`title\`. The first message is posted as you, so write it as a clear request. \`wait: true\` holds until the agents reply. \`subject_type\` and \`subject_id\` open (or rejoin) the chat that belongs to a bet, task, insight or loop. Hard limit on the first message: ${MESSAGE_MAX_LENGTH} characters.`,
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
					'Opening message. Every agent in `participant_actor_ids` is @mentioned on it so they start. Omit to open an empty chat.',
				),
			subject_type: z
				.enum(['object', 'loop'])
				.optional()
				.describe(
					'With subject_id: tie the chat to an object or a loop. Asking again returns the existing chat.',
				),
			subject_id: z.string().uuid().optional(),
			topical: z
				.boolean()
				.optional()
				.describe(
					'With one other actor: open a separate chat for this topic instead of your direct message.',
				),
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
			'Bring an agent or person into a chat you are in, so they see everything from now on and can be @mentioned. Anyone in the workspace can be added. Adding someone already in does nothing; someone who left comes back. Mentioning an agent with post_conversation_message also pulls it in, so use this to add someone silently, or to add people.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			conversation_id: z.string().uuid(),
			actor_ids: z.array(z.string().uuid()).min(1).max(MAX_CONVERSATION_PARTICIPANTS),
		}),
	},
	remove_chat_participant: {
		description:
			'Take an agent or person out of a chat you are in. They stop seeing new messages and cannot be woken by a mention; what they wrote stays. You can remove yourself, or anyone if you started the chat; otherwise it is refused. To stop an agent that is working right now, use stop_chat_agent.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			conversation_id: z.string().uuid(),
			actor_id: z.string().uuid(),
		}),
	},
	get_chat_activity: {
		description:
			"See what the agents in a chat did: tool calls, thinking, errors and results, turn by turn. Give the chat's `conversation_id`, and an `actor_id` for one agent (otherwise every agent that has run in the chat is returned). Each agent entry has a live-session `status` (starting, running, waiting_for_input, paused or not_running) and the same trace get_session_activity returns for its latest run (`limit_turns` for more turns). For an agent started with create_sub_chat, pass the sub-chat's `session_id` instead. To stop a working agent use stop_chat_agent; to talk to it, post_conversation_message.",
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			conversation_id: z.string().uuid().optional(),
			actor_id: z.string().uuid().optional(),
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
			"Interrupt an agent running in a chat. It stops what it is doing, stays in the chat and wakes again on the next @mention. Give the `conversation_id` and the agent's `actor_id` (get_chat_activity or get_conversation shows who is running). For a sub-chat from create_sub_chat, pass its `session_id` instead.",
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			conversation_id: z.string().uuid().optional(),
			actor_id: z.string().uuid().optional(),
			session_id: z
				.string()
				.uuid()
				.optional()
				.describe('A sub-chat from create_sub_chat, instead of conversation_id'),
		}),
	},

	create_trigger: {
		description:
			"Create an automation trigger that fires an agent on a schedule (cron) or on an event; the `config` param shows both shapes. To fire only for items with a given driver, add `conditions` to the event config, e.g. { entity_type: 'task', action: 'status_changed', conditions: [{ field: 'driver', operator: 'equals', value: '<actor UUID>' }] }; driver works on created, updated, status_changed and commented events. To start whoever drives the item, put target: 'item_driver' in the event config and omit target_actor_id (same four events; skipped if no agent drives it); otherwise target_actor_id is required and must be an agent. For a one-off, pass `run_at` instead of `type` and `config`: it runs once, then disables itself and shows as one-time in list_triggers. Never use a cron with a fixed day and month for a one-off; it repeats every year. Say in the prompt what to do if the run starts late. Call list_triggers first and reuse a trigger when one fits. The result is the saved trigger in short form plus `warnings`, notes that never block the save. The model route (llm_route, llm_oauth_slot) comes from the target agent and workspace settings; sending either in config is rejected.",
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			name: z.string(),
			type: z
				.enum(['cron', 'event'])
				.optional()
				.describe('cron or event. Leave out when you pass run_at.'),
			config: z
				.record(z.unknown())
				.optional()
				.describe(
					'Cron: { "expression": "*/5 * * * *" }. Event: { "entity_type": "object", "action": "created"|"updated"|"deleted"|"status_changed", "filter": { ... } }. Omit with run_at.',
				),
			run_at: z
				.string()
				.datetime({ offset: true })
				.optional()
				.describe(
					'Run once at this ISO 8601 time (e.g. 2026-11-12T09:00:00Z), then disable. Must be in the future. Use instead of type and config.',
				),
			action_prompt: z.string().describe(TRIGGER_PROMPT_GUIDANCE),
			target_actor_id: z
				.string()
				.uuid()
				.optional()
				.describe(
					'The agent to start. Required, except when the event config has "target": "item_driver".',
				),
			enabled: z.boolean().default(true),
		}),
	},
	update_trigger: {
		description:
			'Update a trigger by ID. Can change name, schedule/event config, action_prompt, target agent, or enabled/disabled state. To start the driver of the item instead of a fixed agent, put "target": "item_driver" in the event config (created, updated, status_changed and commented events only); to go back to a fixed agent, send a config without it and a target_actor_id. To filter an event trigger by the driver of the item, put { "field": "driver", "operator": "equals" (or not_equals, is_set, is_not_set), "value": "<actor UUID>" } in config.conditions. The result is the saved trigger in short form plus `warnings`, notes that never block the save. The model route (llm_route, llm_oauth_slot) is not set on triggers: it is resolved at dispatch from the target agent and workspace settings, and sending either in config is rejected.',
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
			'List triggers, newest first. Call it before creating one, to see what already runs. Rows are short (id, name, status, kind, schedule, next_run, last_run, agent, purpose, url); read one in full with get_trigger, or set `compact` false. Filters (`agent_id`, `status`, `q`) combine with AND and carry through the cursor; `q` matches name, agent name or id, kind (recurring, one-time, event), status, schedule and loop name (never the prompt), every word must match. Default 25, max 100. Every response carries `page` ({ limit, returned, has_more, total }, total counts rows matching your filters) and `next_cursor` while `has_more` is true; pass it back as `cursor` for the next page. A page cut for length sets `truncated` and a `hint`. Unknown parameters are rejected.',
		// Strict: an unknown parameter is an error, never a silently ignored filter.
		inputSchema: z
			.object({
				workspace_id: optionalWorkspaceId,
				limit: z.number().int().min(1).max(100).optional().describe('Default 25.'),
				cursor: z.string().optional().describe('The `next_cursor` of the previous page.'),
				agent_id: z
					.string()
					.uuid()
					.optional()
					.describe('Only triggers that run this agent (id from list_actors).'),
				status: z.enum(['enabled', 'disabled']).optional().describe('Omit for both.'),
				q: z
					.string()
					.trim()
					.min(1)
					.max(200)
					.optional()
					.describe(
						'Words to match (case-insensitive, all must match) against name, agent, kind, status, schedule or loop name. Not the prompt.',
					),
				compact: z
					.boolean()
					.optional()
					.describe(
						'Default true: short rows without the prompt or config. False returns full rows.',
					),
			})
			.strict(),
	},
	get_trigger: {
		description:
			'Read one trigger in full by id, including its action prompt and config. Find ids with list_triggers.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			id: z.string().uuid(),
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
			"Create a Loop: a persistent process where agents (and humans) work toward a goal. For a ready-made marketplace loop use get_started. A STEP is a trigger that fires an agent on an object event or a schedule; add steps inline with `steps` or attach existing triggers with `trigger_ids`. Before adding a step, check with list_actors and list_triggers that the agent's role and system_prompt fit; never default to an unrelated agent, create one with create_actor if none fits. Member objects (any type) are linked by `in_loop` edges. Draft, paused and archived turn every trigger off. A loop is CLOSED when one step is a feedback step: an event trigger on the close condition whose agent captures learnings (an insight or knowledge object linked with `informs`), improves the loop or seeds the next object. To put a human on the loop, add a step whose agent @mentions them with create_comment. For custom object types pass `closed_statuses`, or `closed_when` for a metadata value such as loop_stage=live. Add more later with update_loop; read back with list_loops. Every loop needs a driver_id: an agent whose job covers the outcome. Details: docs/reference/loops.md.",
		inputSchema: z.object({
			workspace_id: requiredWorkspaceId,
			name: z.string().min(1),
			driver_id: loopDriverIdSchema,
			content: z.string().optional(),
			status: z
				.enum(MCP_LOOP_STATUSES)
				.default('draft')
				.describe(
					'Autonomy stage. `draft` (default), `paused` and `archived` (terminal) keep triggers off; `pilot`, `supervised` and `live` are the trust ladder, triggers on. Start at `pilot` or later for steps to fire.',
				),
			entry_condition: z
				.string()
				.optional()
				.describe(
					'When an object enters the loop, e.g. "A new insight is created with source=intercom".',
				),
			close_condition: z
				.string()
				.optional()
				.describe(
					`When an object is done and leaves the loop, e.g. "The task reaches status done or discarded". ${CLOSE_CONDITION_GUIDANCE}`,
				),
			steps: z
				.array(loopStepSchema)
				.max(20)
				.default([])
				.describe(
					'Inline steps, each created as a trigger and attached. Include a feedback step (event `when` on the close condition) to make the loop CLOSED.',
				),
			trigger_ids: z
				.array(z.string().uuid())
				.max(50)
				.default([])
				.describe(
					'Existing triggers to attach as steps (see the tool description for picking an agent). Find them with list_triggers. Combined with inline `steps`.',
				),
			object_ids: z
				.array(z.string().uuid())
				.max(50)
				.default([])
				.describe(
					'Existing objects of any type to run through the loop, each linked by an `in_loop` edge (source = loop). Can also be added later with update_loop.',
				),
			closed_statuses: closedStatusesSchema,
			closed_when: closedWhenSchema,
			tags: loopTagsSchema.optional(),
			targets: loopTargetsSchema.optional(),
		}),
	},
	update_loop: {
		description:
			"Update a Loop: rename it, change its status or entry/close conditions, add inline steps, attach or detach triggers (the loop's steps), add or remove member objects, and set closed_statuses (or closed_when) for custom object types. A step and a trigger are the same thing: see create_loop for `steps`/`trigger_ids` and how to pick a fitting agent. Use add_steps with an event `when` on the close condition to CLOSE an open loop (the feedback step that captures learnings and seeds the next object). Added trigger ids are validated against the workspace. Setting `status` to `draft`, `paused` or `archived` disables every trigger on the loop (including ones added in this call); a running status re-enables them. add_object_ids creates `in_loop` edges (idempotent), remove_object_ids deletes them. driver_id changes the driver (it cannot be cleared). Find loop ids with list_loops. Fails if the id is not a loop: use update_objects for other objects.",
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			id: z.string().uuid(),
			name: z.string().min(1).optional(),
			driver_id: loopDriverIdSchema.optional(),
			content: z.string().optional().describe('New description (replaces the current one).'),
			status: z
				.enum(MCP_LOOP_STATUSES)
				.optional()
				.describe(
					"New autonomy stage (see create_loop). `draft`, `paused` and `archived` disable the loop's triggers; a running stage re-enables them. `archived` is terminal.",
				),
			entry_condition: z
				.string()
				.optional()
				.describe('New entry condition. An empty string clears it.'),
			close_condition: z
				.string()
				.optional()
				.describe(`New close condition. An empty string clears it. ${CLOSE_CONDITION_GUIDANCE}`),
			closed_statuses: closedStatusesSchema,
			closed_when: closedWhenSchema,
			tags: loopTagsSchema.optional(),
			targets: loopTargetsSchema.optional(),
			add_steps: z
				.array(loopStepSchema)
				.max(20)
				.optional()
				.describe(
					'Inline steps to add, each created as a trigger and attached. A feedback step (event `when` on the close condition) closes an open loop.',
				),
			add_trigger_ids: z
				.array(z.string().uuid())
				.max(50)
				.optional()
				.describe(
					'Trigger ids to attach as steps. Unknown ids fail the call; already-attached ones are ignored.',
				),
			remove_trigger_ids: z
				.array(z.string().uuid())
				.max(50)
				.optional()
				.describe('Trigger ids to detach. The triggers are not deleted (use delete_trigger).'),
			add_object_ids: z
				.array(z.string().uuid())
				.max(50)
				.optional()
				.describe(
					'Object ids to add (creates `in_loop` edges). Objects already in the loop are fine.',
				),
			remove_object_ids: z
				.array(z.string().uuid())
				.max(50)
				.optional()
				.describe(
					'Object ids to remove (deletes their `in_loop` edges). The objects are untouched.',
				),
		}),
	},
	list_loops: {
		description:
			'List Loops as a lean index of `{id, workspaceId, name, url}`. For live stats and `steps` (each trigger with its agent) call get_loop. For the objects inside a loop call list_relationships with source_id=<loop id> and type="in_loop". Filter with `status` and `q` (a word of the name). Default 25, max 100. Every response carries `page` ({ limit, returned, has_more, total }, where total counts rows matching your filters) and `next_cursor` while `has_more` is true; pass it back as `cursor` for the next page.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			status: z
				.union([z.string().min(1), z.array(z.string().min(1)).min(1)])
				.optional()
				.describe(
					'One status, or a list: draft, pilot, supervised, live, paused, archived. Ignores case.',
				),
			q: z.string().min(1).optional().describe('Text the name contains. Ignores case.'),
			limit: z.number().int().min(1).max(100).optional().describe('Default 25.'),
			cursor: z.string().optional().describe('The `next_cursor` of the previous page.'),
		}),
	},
	get_loop: {
		description:
			'Get one Loop by id: status pill, entry/close conditions, in-progress and closed member counts, median time-to-close, and `steps` (each trigger with its agent). Find ids with list_loops. Fails if the id is not a loop.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			id: z.string().uuid(),
		}),
	},
	delete_loop: {
		description:
			'Delete a Loop and its `in_loop` edges. Member objects and step triggers are kept (remove unused triggers with delete_trigger). Fails if the id is not a loop. Cannot be undone.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			id: z.string().uuid(),
		}),
	},

	set_loop_view: {
		description: [
			'Pin an HTML file as a named view tab on a loop (several allowed). `name` (1 to 30 characters, e.g. "Results") picks the tab: same name replaces, new name adds, file_id null removes. Fails if not a loop or the file is not text/html.',
			'A view answers one question: are we reaching the outcome? Open with the outcome in one plain sentence and the headline number vs its target, then the three to five metrics that matter most (name, value with unit, comparison, source), then what needs a person now.',
			'Build: one self-contained HTML file (create_file, mime_type text/html), no network calls, an empty and an error state for every number (show the error message), readable in light and dark. A source returns every group, so page or scroll long tables.',
			'Data: declare sources in <script id="maskin-sources" type="application/json">{ "<name>": <query_data input without workspace_id> }</script> and read them with window.maskin.query("<name>") (a promise). The page reloads itself when its numbers change: query once, never poll. Use moving date bounds ("now-7d", "today-30d"), never fixed dates.',
		].join('\n'),
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			loop_id: z.string().uuid(),
			file_id: z
				.string()
				.uuid()
				.nullable()
				.describe('A text/html file id, or null to remove the tab.'),
			name: loopViewRowSchema.shape.name.describe('Tab name, 1 to 30 characters.'),
		}),
	},
	query_data: {
		description:
			'Totals over objects (not SQL), computed in the database: count, or sum/avg of one numeric metadata field, for one object type, optionally filtered and grouped by status, type, a metadata field, or a time bucket (`created_at.day`, also updated_at and hour/week/month; oldest first, empty buckets omitted). `scope` is "workspace" (default) or a loop id for that loop\'s members. Date filters (created_after/before, updated_after/before) take a fixed ISO datetime or a moving bound re-evaluated every run: "now-7d", "now-24h", "now-4w", "now-3mo" (rolling), "today", "today-7d" (from midnight); prefer moving bounds. `timezone` (IANA, default UTC) sets where days start. Returns `{ groups: [{ key, count, value }], total: { count, value }, next_cursor }`; with no `group_by`, read `total`. Groups come back a page at a time (`limit`, default 50, max 1000): while `next_cursor` is set, repeat the query with `cursor: <next_cursor>`. Use it to test a query before declaring it as a source in set_loop_view. Returns no objects: use list_objects.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			...dataQuerySpecSchema.shape,
			cursor: z.string().max(80).optional().describe("The previous page's `next_cursor`."),
			limit: z
				.number()
				.int()
				.min(1)
				.max(DATA_QUERY_MAX_PAGE_SIZE)
				.optional()
				.describe(`Groups per page (default ${DATA_QUERY_PAGE_SIZE}).`),
		}),
	},

	// ─── Sessions ────────────────────────────────────────────
	create_sub_chat: {
		description:
			"Hand a task to another agent from inside the current chat. The agent works in a thread under your reply: the person sees a handoff card with live status and can open it or break it out into its own chat. For a separate top-level chat use create_chat. Returns at once with the sub-chat's details (its `id` is the `session_id` other chat tools take). The agent's final message comes back to you as a new turn: do not poll. Check on it with get_chat_activity or get_session, stop it with stop_chat_agent, message it with send_session_message, carry on after it ended, failed or paused with resume_session. Do not @mention the agent in a chat for this: a mention reaches a different session of that agent. Give `action_prompt` a clear first line: it becomes the card's title.",
		inputSchema: startAgentInputSchema,
	},
	list_sessions: {
		description:
			'List sessions, filtered by status, actor, trigger or last-updated window. Rows are lean by default ({ id, title, status, updated_at }); verbose: true returns the full payload. A response over the size cap is trimmed from the tail: _meta.truncated is true and next_cursor holds the updated_at of the last row. To continue, repeat the call with the same filters, before = next_cursor and offset 0, until next_cursor is absent.',
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
			trigger_id: z.string().uuid().optional().describe('Only sessions spawned by this trigger.'),
			updated_before: z
				.string()
				.datetime({ offset: true })
				.optional()
				.describe(
					'ISO-8601. Rows with `updated_at < updated_before` (exclusive). Use it to find stalled sessions, e.g. now - 6h.',
				),
			updated_after: z
				.string()
				.datetime({ offset: true })
				.optional()
				.describe(
					'ISO-8601. Rows with `updated_at > updated_after` (exclusive). Combine with `updated_before` for a window.',
				),
			before: z
				.string()
				.datetime({ offset: true })
				.optional()
				.describe(
					"Cursor: the last row's `updated_at` from the previous page. Exclusive: rows with `updated_at < before`.",
				),
			verbose: z
				.boolean()
				.default(false)
				.describe('False (default): lean rows, about 10x smaller. True: the full session payload.'),
			limit: z.number().int().min(1).max(200).default(50),
			offset: z.number().int().min(0).default(0),
		}),
	},
	get_session: {
		description:
			'Get session details by id, optionally with container logs (stdout/stderr/system, newest first). To page through log history use get_session_logs. Set `wait: true` to hold until the session has finished and get it back with the first 500 lines of its output; the wait stops after 2 hours, or early if the session waits for input or is paused, with `settled: false` (not finished, not failed). To talk to a running session use send_session_message; to carry on with an ended or paused one use resume_session.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			id: z.string().uuid(),
			include_logs: z.boolean().default(false).describe('Add a `logs` array, newest first.'),
			log_limit: z
				.number()
				.int()
				.min(1)
				.max(500)
				.default(100)
				.describe('Max log lines (with include_logs).'),
			wait: z
				.boolean()
				.optional()
				.describe(
					'Hold until the session finishes, then return it with the first 500 output lines (oldest first) and `settled`. Gives up after 2 hours or when the session waits for input or is paused: `settled` is false. Ignores include_logs.',
				),
		}),
	},
	get_session_logs: {
		description:
			'Read a session\'s log history, newest first by default. Page backward with before_id (id < before_id), forward with after_id (id > after_id), or use both for a window. direction "oldest_first" (no cursor) starts at boot. Row shape: { id, sessionId, stream, content, createdAt }.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			id: z.string().uuid().describe('Session id'),
			direction: z
				.enum(['newest_first', 'oldest_first'])
				.default('newest_first')
				.describe(
					'`newest_first` (default) returns id DESC, `oldest_first` id ASC (jump to boot).',
				),
			before_id: z
				.number()
				.int()
				.positive()
				.optional()
				.describe('Rows with `id < before_id`. Pages backward.'),
			after_id: z
				.number()
				.int()
				.positive()
				.optional()
				.describe('Rows with `id > after_id`. Live-tails from a known cursor.'),
			stream: z
				.enum(['stdout', 'stderr', 'system'])
				.optional()
				.describe('Filter to a single log stream.'),
			limit: z.number().int().min(1).max(500).default(100).describe('Max rows per page.'),
		}),
	},
	get_session_activity: {
		description:
			'Compact activity trace of a session: turns per conversation message, each with its steps (tool calls, thinking, text, errors), status and final result. Page to older turns with the previous `oldest_log_id` as `before_log_id` while `has_older` is true. It is read-only, so for raw log lines use get_session with `include_logs: true`; to change a session use stop_session, pause_session or resume_session.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			id: z.string().uuid().describe('Session ID'),
			limit_turns: z
				.number()
				.int()
				.min(1)
				.max(20)
				.default(5)
				.describe('Newest turns to return (a turn is one answered message).'),
			message_id: z
				.number()
				.int()
				.positive()
				.optional()
				.describe('Only the turn for this conversation message id.'),
			before_log_id: z
				.number()
				.int()
				.positive()
				.optional()
				.describe('Pass a previous `oldest_log_id` to page older.'),
		}),
	},
	stop_session: {
		description:
			'Stop a running session. Only the actor that started it can; anyone else gets 403. To end work another agent started, comment on its task instead.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			id: z.string().uuid(),
		}),
	},
	ask_user_question: {
		description:
			'Ask the person you are working with a question they can answer by tapping a button, and wait for the answer. Prefer it over a free-text question whenever the reply fits in a few options: confirmations, approvals, timing, choosing between alternatives, ambiguity, permission before something risky or hard to undo, a detail only they can give when a default would be a guess. Do not ask when you can reasonably decide yourself. Their pick comes back as your next turn: after calling it, end your turn with no closing message and do not repeat the question. In a session that runs on its own (a trigger, a schedule) the question goes to the person\'s chat with the Chief of Staff, so do not wait: decide, state your assumption and continue. If there is nobody to ask, the tool says so; do the same. Give 2 to 4 options each, with a one- or two-word label and a description only when the label is unclear. A person can always type something else. For a yes/no put the one-line question in `question` and a short `header` such as "Confirm". `multi_select` allows several picks; up to 4 related questions per call.',
		inputSchema: z.object({
			questions: z
				.array(
					z.object({
						question: z.string().min(1).max(1000).describe('The full question.'),
						header: z.string().min(1).max(24).describe('Short label, e.g. "Job board".'),
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
			'Carry on with a sub-chat that is not running: paused, finished, failed, timed out, out of tokens or stopped (for an ordinary chat, @mention the agent with post_conversation_message instead). You need not know which. A paused session continues where it stopped. An ended one gets a follow-up session for the same agent in the same thread, started from your `message` (it gets only a short reminder of the old task, not its files or history). Without a `message` an ended session is told to carry on where it left off. If the session is still running, use send_session_message. Set `wait: true` to hold until the agent has finished and get its output (stops after 2 hours, or early if the agent waits for input or is paused, with `settled: false`). For an ended session the response is the new follow-up session (`continued_from_session_id` names the old one). Only the person or agent that started the session, or someone in its chat, can do this.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			id: z.string().uuid().describe('The session to carry on with'),
			message: z.string().min(1).optional().describe('What the agent should do next. Optional.'),
			wait: z
				.boolean()
				.optional()
				.describe(
					'Wait for the agent to finish, then return the session with the first 500 output lines. Gives up after 2 hours, or when it waits for input or is paused: settled is false.',
				),
		}),
	},
	send_session_message: {
		description:
			'Send a message into a running sub-chat you started with create_sub_chat (post_conversation_message with its `sub_chat_session_id` also works, running or not). In an ordinary chat do not use this: post with post_conversation_message and @mention the agent. It only works while the session is running: if it ended, failed or paused, use resume_session, which also takes a message. Do not @mention the agent in a chat for this: a mention reaches a different session of that agent. Returns once the message is delivered; read the reply with get_session_activity, or set `wait: true` to hold until the session has finished and get its output (stops after 2 hours, or early if the session waits for input or is paused, with `settled: false`). `wait` only works for sessions that end after replying. Only the actor that started the session can message it; anyone else gets 403: comment on the task or start your own with create_sub_chat.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			id: z.string().uuid().describe('The running session to talk to'),
			content: z.string().min(1).describe('The message to send'),
			wait: z
				.boolean()
				.optional()
				.describe(
					'Hold until the session finishes, then return it with the first 500 output lines. Gives up after 2 hours: settled is false. Ignored if the session stays open after replying.',
				),
		}),
	},

	// ─── Notifications ───────────────────────────────────────
	create_notification: {
		description:
			'Create a notification for a human when you need input to make a decision you cannot make yourself. Use it sparingly: call list_notifications first for a similar pending one and update that with update_notification instead. Pass session_id when the agent expects to be resumed with the human\'s reply (enables the free-text "Reply to agent" input). For clickable buttons pass metadata.actions as a NATIVE JSON array (not stringified). For a structured picker (radio/checkbox/text) set metadata.input_type and metadata.options as a NATIVE JSON array.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			type: z
				.enum(['needs_input', 'recommendation', 'good_news', 'alert'])
				.describe(
					'needs_input: blocked, needs a decision. recommendation: worth attention. good_news: a positive outcome. alert: needs attention.',
				),
			title: z.string().min(1),
			content: z.string().optional(),
			metadata: notificationMetadataInput
				.optional()
				.describe(
					'Structured UI data. Known fields: actions, input_type, options, question, placeholder, multiline, suggestion, urgency_label, meta_text, tags, due_at (other keys pass through). due_at (ISO 8601, e.g. 2026-10-26T08:00:00Z) is for decisions needed by a time: the push then starts with "Before <time>". Omit it when nothing expires.',
				),
			source_actor_id: z.string().uuid().describe('The agent creating this notification.'),
			target_actor_id: z
				.string()
				.uuid()
				.optional()
				.describe('Human to notify. Omit to notify all workspace members.'),
			object_id: z.string().uuid().optional().describe('Related object (insight, bet or task).'),
			session_id: z
				.string()
				.uuid()
				.optional()
				.describe(
					'Session to resume with the reply. Without metadata.input_type, the UI shows a free-text "Reply to agent" input.',
				),
		}),
	},
	list_for_you: {
		description:
			'What needs one person, as the web For You page shows it: dead, read and answered cards removed, ranked, then decision cards agents addressed to them. Use this, not list_notifications, to say what needs a person. Pass their actor id. Returns { total, next_offset, items }: total counts the whole list, offset pages through it, next_offset is null at the end. Each item { rank, source (curated or decision), headline, rationale, notification_id, comment_id, object_id, title, type, status, due_at, ask }; start with rank 1 and say first any card due today. object_id, title, type and status are null for a card with no object. To answer a card use create_comment (or update_objects to change the object); to retire a dead card use withdraw_decision_card with its comment_id.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			actor_id: z
				.string()
				.uuid()
				.describe('The person whose list to read. A person can read only their own.'),
			limit: z
				.number()
				.int()
				.min(1)
				.max(FOR_YOU_TOOL_MAX_LIMIT)
				.default(FOR_YOU_TOOL_DEFAULT_LIMIT)
				.describe(`Cards to return (default ${FOR_YOU_TOOL_DEFAULT_LIMIT}).`),
			offset: z
				.number()
				.int()
				.min(0)
				.default(0)
				.describe('Cards to skip. Pass the previous next_offset; stop when it is null.'),
		}),
	},
	withdraw_decision_card: {
		description:
			"Retire a dead decision card so nobody is shown it any more (test card, passed deadline, moved-on object, duplicate), instead of posting a replacement. It leaves every list, the briefing and the pushes. Pass comment_id (from list_for_you, or the id create_comment returned) and a one-line reason up to 200 characters. Only the card's author or the Chief of Staff may do this; anyone else gets 403. A comment without a decision block gets 400. Calling it again is harmless. Do NOT use it on a live ask, or to hide a card the person has not answered: they have Dismiss for their own list.",
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			comment_id: z
				.number()
				.int()
				.positive()
				.describe("The card's comment id (from list_for_you)."),
			reason: z.string().min(1).max(200).describe('One line on why the card is dead.'),
		}),
	},
	list_notifications: {
		description:
			'List raw notifications for every person, in creation order. Does NOT answer "what needs this person": use list_for_you.',
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
				.describe('Only notifications with this metadata.kind, e.g. "for_you".'),
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
					'Same shape as create_notification.metadata (native arrays for actions/options, do not stringify).',
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
			'Mark an entity as read up to an event id: pass the highest event id the actor has seen. The mark never moves backward.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			entity_type: z.enum(['object']),
			entity_id: z.string().uuid(),
			last_event_id: z.number().int().positive(),
		}),
	},
	list_unread: {
		description:
			'List subscribed entities with unread activity (comments newer than the actor\'s last_read_event_id), with object summaries inline when entity_type="object". Default page 25; pass `next_cursor` as `cursor` for the next page.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			entity_type: z.enum(['object']).optional(),
			limit: z.number().int().min(1).max(100).optional().describe('Default 25.'),
			cursor: z.string().optional().describe('The `next_cursor` of the previous page.'),
		}),
	},
	// ─── Integrations ─────────────────────────────────────────
	list_integrations: {
		description:
			'List integrations connected to the workspace, live ones first, newest first within each group. Dead rows (never finished, revoked) sort last but are listed. Every page starts with a `summary` of the whole workspace (rows per status, which connections are active). A connection missing from this page is NOT proof it is absent: find it with `provider` (e.g. "slack"), `status` or `q` (a word of its name), or follow `next_cursor` while `page.has_more` is true. To answer "can I use X?" call `get_actor` on yourself and read `access`. Rows are slim: `defaultAgentAccess`, `agentGrants` and `chatGrants`; `verbose: true` adds config, granted scopes and provider-side ids. Change access with update_integration_access. Default page 25.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			provider: z
				.string()
				.optional()
				.describe('Only this provider, e.g. "slack" or "gmail". Exact match, ignoring case.'),
			status: z
				.string()
				.optional()
				.describe('Exact status: "active", "pending", "revoked", "undone" or "awaiting_secret".'),
			q: z
				.string()
				.optional()
				.describe('Words in the provider or saved name, e.g. "google". Every word must appear.'),
			verbose: z
				.boolean()
				.optional()
				.describe(
					'Return full rows (config, granted scopes, provider-side ids). Default false: slim rows.',
				),
			limit: z
				.number()
				.int()
				.min(1)
				.max(100)
				.optional()
				.describe('Max rows to return. Defaults to 25.'),
			cursor: z.string().optional().describe('The `next_cursor` from the previous response.'),
		}),
	},
	list_integration_providers: {
		description:
			"List integration providers, their events and MCP surface. A provider with one returns `{ envKey, autoInject, server }`. `server` is the value to paste into an agent's `tools.mcpServers.<provider>` via create_actor/update_actor, `${TOKEN}` placeholders included. If `autoInject` is true it is already in every agent session (github: one `github-<owner>` entry per organisation) and `server` may be absent. If false (the default), connecting gives NO tools until you attach `server` to the agent.",
		inputSchema: z.object({}),
	},
	connect_integration: {
		description:
			'Ask the user to connect an integration (e.g. "linear"). Also the way to re-authenticate a connection whose status is not active (revoked, expired, needs reconnect; see list_integrations): call it instead of sending the user to Settings. In a chat it shows a Connect card; end your turn afterwards. Never ask for an API key or paste a link yourself, and never write card text without calling this tool. Outside a chat, OAuth providers return an install_url to open in a browser; API-key providers (e.g. "posthog") use `api_key` and activate at once.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			provider: z
				.string()
				.describe('Provider name (e.g. "github"). See list_integration_providers.'),
			api_key: z
				.string()
				.optional()
				.describe(
					'Non-chat fallback only: the API key for "api_key" providers (e.g. "posthog"). Ignored in a chat; never ask the user for one.',
				),
		}),
	},
	gmail_send_email: {
		description:
			'Send an email from the connected Gmail account. Cannot be undone, never retried. Needs "Read & write" Gmail access; your email send setting decides the rest. Always allow: pass `to`, `subject`, `body` (optional `cc`) to send at once, or `object_id` of a kept email object. Ask first: create_objects with `metadata: { kind: "email", to: "...", subject: "...", cc: "..." }` and the text as `content`, mention the person with create_comment (no `decision` needed); they approve the exact text (may edit first) or say yes in chat (then call approve_draft_from_chat). Any edit withdraws approval. Files: create_file ids in `metadata.attachment_file_ids` (max 5, 20 MB total). Then call this with only `object_id`: it sends the object as it reads now, once. If refused for no approval, end your turn; you are woken after approval. Older route: pass only `approval_comment_id` of a decision comment whose `draft` holds the email, after the person chose send (plus `draft_id` for several drafts). Deny: refused. If the outcome is unknown, do not resend: tell the person to check the Sent folder.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			to: z
				.string()
				.optional()
				.describe('Recipients, comma separated, e.g. "Mette Holm <mette@northwind.dk>".'),
			cc: z.string().optional().describe('Cc addresses, comma separated.'),
			subject: z.string().optional().describe('Subject line.'),
			body: z.string().optional().describe('Plain-text body.'),
			object_id: z
				.string()
				.uuid()
				.optional()
				.describe('The email object to send (metadata.kind "email"). Use alone.'),
			approval_comment_id: z
				.number()
				.int()
				.positive()
				.optional()
				.describe('Id of the decision comment (from create_comment) after a person chose send.'),
			draft_id: z
				.string()
				.optional()
				.describe(
					'Only with approval_comment_id, when the card has several `decision.drafts`: the `id` of the one to send.',
				),
		}),
	},
	gmail_save_attachment: {
		description:
			'Save one Gmail attachment as a workspace file. Pass message_id, attachment_id and part_id from the message you read; attachment ids change on every read, so always pass part_id (e.g. "1"). Needs "Read" or "Read & write" Gmail access. Max 20 MB. Returns file_id, name, mime_type, size_bytes, url. To send it, put file_id in `attachment_file_ids` on an email object (metadata.kind "email"), get approval, then call gmail_send_email.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			message_id: z.string().min(1).describe('The Gmail message id.'),
			attachment_id: z.string().min(1).describe('As the message lists it (body.attachmentId).'),
			part_id: z
				.string()
				.min(1)
				.optional()
				.describe('The partId next to the attachment, e.g. "1". Stable between reads.'),
		}),
	},
	resend_send_email: {
		description:
			'Send an email from your own maskin.io mailbox through Resend. Cannot be undone. create_objects with `metadata: { kind: "email", to: "...", subject: "...", cc: "..." }` and the text as `content`, then call this with only `object_id`: it sends the object as it reads now, once. With send setting ask first, a person must approve that exact text: mention them with create_comment (no `decision` needed); they approve it in a preview (may edit first) or say yes in chat (then call approve_draft_from_chat). Any edit withdraws approval. If refused for no approval, end your turn; you are woken after approval. Always allow sends at once; deny is refused. Files: create_file ids in `metadata.attachment_file_ids` (max 5, 20 MB total). The sender is your own mailbox, set by an admin (none recorded: refused). Never pass `to`, `subject`, `body` or `from`. If the outcome is unclear, calling again with the same object_id is safe.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			object_id: z.string().uuid().describe('The email object to send (metadata.kind "email").'),
		}),
	},
	approve_draft_from_chat: {
		description:
			"Count a person's \"send it\" in a chat as the Approve on a draft (email, LinkedIn item, or Slack message). Only for agents whose send setting is ask first, and only after a person just said yes in a chat you are in, having seen the draft in a message there that links the draft object. Pass the draft's object_id and the id of that reply message. The server refuses unless a person wrote it, as their latest message in that chat, after the draft's last edit and after a message linking the draft; if refused, post the link again and ask, or ask them to press Approve on the card. On success call the send tool for that kind (resend_send_email or gmail_send_email, the LinkedIn tool, slack_send_message) with the same object_id. Any edit to recipients, subject, text or files withdraws approval.",
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			object_id: z.string().uuid().describe('The draft object.'),
			message_id: z
				.number()
				.int()
				.positive()
				.describe("Id of the person's chat message that says yes."),
		}),
	},
	approve_object_draft: {
		description:
			'A person approves a drafted object (email, LinkedIn message) exactly as it reads. Called by the Approve button; agents are refused and the tool is hidden from the model.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			object_id: z.string().uuid().describe('The draft object.'),
			content_hash: z
				.string()
				.optional()
				.describe("The preview's content_hash; a changed draft is refused."),
		}),
	},
	request_keychain_credential: {
		description:
			'Ask the user to add a credential to their Keychain with a card in the chat: an API key, token, or a username and password for a site or app. For a provider Maskin integrates with (GitHub, Slack, Linear...) use `connect_integration`. If the user offers a login, password or API key, call this right away with kind "login" or "api_key": do not refuse, warn about passwords, or send them to Settings, even if the site also has an integration. The value goes from the card straight to the encrypted vault: you never see it, never ask for it in chat. It is shared with the agents in this chat unless you name others in `target_agent_ids` (from `list_actors`); name the agent that will use it. After calling, end your turn without a closing message; you are restarted when it is saved. An API key is then in your environment as `KEYCHAIN_BYO_APIKEY_<NAME>` (name in capitals, other characters as underscores). A login is never in your environment: type it with `desktop_type` using `{{keychain:<Name>.username}}` and `{{keychain:<Name>.password}}`. Chat with a person only; otherwise say what you need in your reply.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			kind: z
				.enum(['api_key', 'login'])
				.describe('"api_key" for one secret, "login" for username and password.'),
			suggested_name: z
				.string()
				.min(1)
				.max(80)
				.optional()
				.describe('Service name the card pre-fills, e.g. "e-conomic".'),
			hint: z.string().min(1).max(300).optional().describe('What it is for, shown on the card.'),
			target_agent_ids: z
				.array(z.string())
				.max(10)
				.optional()
				.describe('Other agents that will use it. Shown ticked; non-agent ids are ignored.'),
		}),
	},
	list_keychain_credentials: {
		description:
			'List Keychain credentials by name, with kind (api_key or login) and whether you have access. Never returns a value. Use it before asking: if the credential exists, call `request_keychain_access`, not `request_keychain_credential`. An API key you can use is in your environment as `KEYCHAIN_BYO_APIKEY_<NAME>` (name in capitals, other characters as underscores); a login never is: type it with `desktop_type` using `{{keychain:<Name>.username}}` and `{{keychain:<Name>.password}}`. Only works inside an agent session.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
		}),
	},
	request_keychain_access: {
		description:
			'Ask the user, with an Allow / Not now card in the chat, to let you use an existing Keychain credential. Use it when `list_keychain_credentials` shows one you need with `has_access` false; otherwise `request_keychain_credential`. You never see the value. They choose this chat only, or always; in another chat, ask again. If allowed you are restarted with it (API key in your environment; login typed with `desktop_type` as `{{keychain:<Name>.password}}`). After calling, end your turn without a closing message. Chat with a person only; otherwise say what you need in your reply.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			credential_name: z
				.string()
				.min(1)
				.max(80)
				.describe('The name as list_keychain_credentials shows it.'),
			hint: z.string().min(1).max(300).optional().describe('What it is for, shown on the card.'),
		}),
	},
	request_integration_access: {
		description:
			'Ask the user, with an Allow / Not now card in the chat, to let you use a connected integration you may not use (or not at the level you need). Use it when a call was refused for access, or `list_integrations` shows no access or only read when you need to write. Use `connect_integration` when it is not connected, `request_keychain_access` for a saved key or login. Only a person can change your access (`update_integration_access` refuses agents). If allowed you are restarted with it. After calling, end your turn without a closing message. Chat with a person only; otherwise say what you need in your reply.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			integration_id: z.string().uuid().describe('Id from list_integrations.'),
			level: z
				.enum(['read', 'read_write'])
				.describe('"read" to look up, "read_write" to also change.'),
			reason: z.string().min(1).max(300).optional().describe('What it is for, shown on the card.'),
		}),
	},
	add_mcp_server: {
		description:
			'Add a tool (MCP) server for the user when you know how to run or reach it. It shows an Add card; when the user presses Add, the server is saved, given to you, and you are restarted with it. Do not explain Settings: call this tool. First check `list_integrations` that it is not already added (if added but unusable, call `request_integration_access`). Give either `command` (with `args`) for a server that runs inside you, or `url` for a remote one, never both. Never put a key, token or password in any value or in `args`: name each in `secret_env` (environment variable) or `secret_headers` (e.g. "Authorization") and the user types it into the card. A key already in the Keychain can be referenced in the value, like `${KEYCHAIN_BYO_APIKEY_LINEAR}` (see `list_keychain_credentials`). If unsure of exact names, check the server\'s documentation. After calling, end your turn without a closing message. Chat with a person only; otherwise say what you need in your reply.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			name: z
				.string()
				.min(1)
				.max(60)
				.describe('What the person will call it, e.g. "Linear". Must be unused.'),
			command: z
				.string()
				.min(1)
				.max(512)
				.optional()
				.describe('For a server that runs inside you: the program, e.g. "npx".'),
			args: z
				.array(z.string().max(2048))
				.max(100)
				.optional()
				.describe(
					'Arguments for command, e.g. ["-y", "@linear/mcp-server"]. Never a key or token.',
				),
			url: z
				.string()
				.min(1)
				.max(2048)
				.optional()
				.describe('Remote server https address, e.g. "https://mcp.linear.app/mcp".'),
			env: z
				.record(z.string().max(100), z.string().max(4096))
				.optional()
				.describe(
					'Non-secret variables, e.g. {"REGION": "eu"}, or a Keychain reference like {"LINEAR_API_KEY": "${KEYCHAIN_BYO_APIKEY_LINEAR}"}.',
				),
			headers: z
				.record(z.string().max(100), z.string().max(4096))
				.optional()
				.describe('Non-secret headers, or a Keychain reference. Same as env.'),
			secret_env: z
				.array(z.string().min(1).max(100))
				.max(20)
				.optional()
				.describe('Variable names the user types in, e.g. ["LINEAR_API_KEY"]. No values.'),
			secret_headers: z
				.array(z.string().min(1).max(100))
				.max(20)
				.optional()
				.describe(
					'Header names the user types in, e.g. ["Authorization"] (whole value, such as "Bearer ..."). No values.',
				),
			hint: z.string().min(1).max(300).optional().describe('What it is for, shown on the card.'),
		}),
	},
	show_computer: {
		description:
			'Bring your own computer into the chat and ask the user to act on it, with a card showing the screen. Use it when a step needs a person: approving a two-factor prompt, an image or puzzle challenge, signing in with a login you cannot use, confirming a payment, or any choice you must not make for them. A plain "I\'m not a robot" checkbox is not one: you act for the person, so tick it yourself; hand over only if it turns into an image or puzzle challenge. First use the desktop tools to put the computer on the right page. `task` is the instruction on the card: say exactly what to do and when they are done. For a secret you can then use yourself, use `request_keychain_credential`. After calling, end your turn without a closing message. When the user presses Done you get a message with a screenshot of your computer: look at it before carrying on (if none came, call `desktop_screenshot`). Chat with a person only; otherwise say what you need in your reply.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			task: z
				.string()
				.min(1)
				.max(500)
				.describe('What the user should do, e.g. "Approve the 2FA prompt, then press Done."'),
		}),
	},
	update_integration_access: {
		description:
			'Change which agents may use an integration or a saved Keychain credential, and how. Only a person can (its connector or an admin): an agent is refused and should tell the user what it needs. `default_agent_access` is what agents without their own entry get: "read", "read_write" or "none" (not for a saved key or login, which are always explicit). `agent_access` sets individual agents: "read", "read_write" (an irreversible action such as sending Gmail still waits for a person), "none" (beats a read default), or "default" to remove the agent\'s own entry. A saved key or login is on or off per agent: "read_write" gives it, "default" takes it away. Applies to sessions started afterwards. Current access: `list_integrations` (`defaultAgentAccess`, `agentGrants`) or `get_actor` (`access`).',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			integration_id: z
				.string()
				.uuid()
				.describe('Integration or saved credential id, from list_integrations.'),
			default_agent_access: z
				.enum(['read', 'read_write', 'none'])
				.optional()
				.describe('For agents without their own entry. Not for a saved key or login.'),
			agent_access: z
				.array(
					z.object({
						agent_id: z.string().uuid(),
						access: z.enum(['none', 'read', 'read_write', 'default']),
					}),
				)
				.max(50)
				.optional()
				.describe('Per-agent access. "default" removes the entry.'),
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
			'List extensions and their status: registered (e.g. "work") and custom. Each bundles object types with statuses, fields and relationship types. Filter with `enabled` and `q` (a word of the id or name). Default 25, max 100. Every response has `page` ({ limit, returned, has_more, total }, total counts rows matching your filters) and `next_cursor` while `has_more` is true; pass it back as `cursor`.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			enabled: z.boolean().optional().describe('true: only enabled. false: only disabled.'),
			q: z.string().min(1).optional().describe('Matches id or name, ignoring case.'),
			limit: z.number().int().min(1).max(100).optional().describe('Defaults to 25.'),
			cursor: z.string().optional().describe('The `next_cursor` from the previous response.'),
		}),
	},
	create_extension: {
		description:
			'Add an extension to the workspace. Either enable a registered extension by ID (e.g. "work"), or create a custom one: pass id, name and object_types. Call list_extensions first.',
		inputSchema: z.object({
			workspace_id: z.string().uuid().describe('Workspace to add the extension to'),
			id: z
				.string()
				.regex(/^[a-z][a-z0-9_]*$/)
				.describe('"work" for a registered extension, any lowercase identifier for a custom one.'),
			name: z.string().optional().describe('Name of a custom extension, e.g. "My CRM".'),
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
				.describe('Type definitions for a custom extension only.'),
		}),
	},
	update_extension: {
		description:
			'Update an extension: enable or disable it (`enabled`), or change the object types of a custom one (statuses, fields, display names).',
		inputSchema: z.object({
			workspace_id: z.string().uuid(),
			id: z.string().describe('Extension ID to update'),
			enabled: z.boolean().optional().describe('false disables, true re-enables.'),
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
				.describe('Type definitions (PATCH: only provided fields change).'),
		}),
	},
	delete_extension: {
		description:
			'Remove an extension and its object type definitions from workspace settings. Existing objects of those types are kept but no new ones can be created. Types from registered extensions like "work" cannot be deleted: disable them with update_extension.',
		inputSchema: z.object({
			workspace_id: z.string().uuid(),
			id: z.string().describe('Extension ID, not a type name.'),
		}),
	},
	// Agent computer: every agent has its own long-lived Linux desktop (1920x1080,
	// Chromium + xterm) that it drives and humans can watch and take over from the
	// Desktop page. An agent always gets ITS OWN; only a person calling these
	// tools has to say whose (agent_id). Behind the `workspace-desktop` flag.
	desktop_screenshot: {
		description:
			'Screenshot your computer (1920x1080 Linux screen with Chromium and a terminal). Starts it if needed (the first call can take a minute). Humans watch this screen live and may take over, so screenshot again before acting. Coordinates for desktop_click, desktop_move, desktop_drag and desktop_scroll are pixels in this image, (0,0) top-left.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			agent_id: optionalDesktopAgentId,
		}),
	},
	desktop_click: {
		description:
			'Click at a pixel position on your computer. Take a screenshot first to find the target, and another afterwards to confirm. If a page shows a plain "I\'m not a robot" checkbox, click it yourself; use show_computer only if it turns into an image or puzzle challenge.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			agent_id: optionalDesktopAgentId,
			x: z.number().int().min(0).max(1919),
			y: z.number().int().min(0).max(1079),
			button: z.enum(['left', 'middle', 'right']).optional().describe('Defaults to left.'),
			double: z.boolean().optional().describe('Double-click. Defaults to false.'),
		}),
	},
	desktop_move: {
		description: 'Move the pointer to a pixel position on your computer without clicking (hover).',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			agent_id: optionalDesktopAgentId,
			x: z.number().int().min(0).max(1919),
			y: z.number().int().min(0).max(1079),
		}),
	},
	desktop_drag: {
		description:
			'Press at one pixel position on your computer, drag, and release at another (select text, move a window, drag a slider).',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			agent_id: optionalDesktopAgentId,
			from_x: z.number().int().min(0).max(1919),
			from_y: z.number().int().min(0).max(1079),
			to_x: z.number().int().min(0).max(1919),
			to_y: z.number().int().min(0).max(1079),
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
			x: z.number().int().min(0).max(1919).optional(),
			y: z.number().int().min(0).max(1079).optional(),
		}),
	},
	desktop_type: {
		description:
			'Type text into whatever has keyboard focus on your computer (click a field first). Up to 2000 characters; use desktop_key for Enter, Tab, Escape and shortcuts. Typed text is visible to anyone watching: never type a secret yourself. To log in with a saved Keychain login, pass the reference as the whole text, nothing before or after: `{{keychain:<Name>.username}}` or `{{keychain:<Name>.password}}` (name as `list_keychain_credentials` shows it). Maskin types the real value and you never see it. Order: username, Tab, password reference, then Enter via desktop_key. If you may not use that login, call `request_keychain_access` and end your turn. The login is not in your environment: do not look for it there.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			agent_id: optionalDesktopAgentId,
			text: z.string().min(1).max(2000),
		}),
	},
	desktop_key: {
		description:
			'Press key combinations on your computer, in order. Each entry is an xdotool key name or "+"-joined combo, e.g. ["ctrl+l"], ["Tab", "Return"], ["alt+Tab"].',
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
			'Run a shell command inside your computer (the desktop VM), not the host or your sandbox. DISPLAY is set, so GUI programs appear on your screen, e.g. `chromium --no-sandbox https://example.com &`. Returns exit code, stdout and stderr (each cut at 20,000 characters). Default timeout 30s, max 120s. Background anything that should keep running with `&`.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			agent_id: optionalDesktopAgentId,
			command: z.string().min(1).max(10000),
			timeout_s: z.number().int().min(1).max(120).optional().describe('Defaults to 30.'),
		}),
	},
	desktop_put_file: {
		description:
			"Put a workspace file on YOUR computer (the desktop VM) by file id, so a browser there can pick it in a file field. Your computer is a separate machine: a file in your session or the workspace is not on it until you call this. Returns the path, size and sha256 as it landed and free_space_bytes. Default folder ~/Downloads; a same-name file is overwritten. Takes up to two minutes. Earlier desktop_put_file files are cleaned up first: over 24 hours old always, and, if the disk lacks room for this file plus 1 GB, over 1 hour old, oldest first (your own and Chromium downloads stay). If there is still no room the call is refused. To upload in Chromium: click the page's file field, press ctrl+L in the chooser, type the returned full path, then click Open (or press alt+O). Do not press Enter or double click: both close the chooser without choosing the file. Only your own computer is reachable.",
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			agent_id: optionalDesktopAgentId,
			file_id: z.string().uuid().describe('Workspace file id (create_file, list_files).'),
			folder: z
				.string()
				.max(255)
				.optional()
				.describe('Absolute or ~/ path. Created if missing. Defaults to ~/Downloads.'),
		}),
	},
	desktop_apply_settings: {
		description:
			"Bring YOUR computer up to date without deleting it (saved logins and open pages stay). It keeps the image it was created from, so later fixes do not reach it until now. Replaces its control helper when older than the server's (run this when typing a saved password says the computer is an older version) and rewrites a fixed list of user settings files. Nothing else is touched; the browser is not restarted. Returns the settings version, whether anything changed, helper_updated, browser_debug_port_open, and chromium_restart_needed (when true, restart Chromium yourself before relying on the change, e.g. before typing a saved password; it closes open pages). Starts your computer if needed. Only your own computer is reachable.",
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			agent_id: optionalDesktopAgentId,
		}),
	},
	desktop_settings: {
		description:
			"Look at YOUR computer: its image_tag (null if it predates image tags), settings version against the current one, the file chooser's size and position, free and total disk in MB, and whether idle computers are suspended on this host. Does not wake it: while asleep only the host's answer comes back and the rest is null. If settings_version is null or below current_settings_version, run desktop_apply_settings.",
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			agent_id: optionalDesktopAgentId,
		}),
	},
	desktop_save_file: {
		description:
			'Save a file from YOUR computer (the desktop VM) into the workspace as a new file and get its file id. Do it as soon as a finished render, cut list or working package exists: your computer can be reset at any time and everything on it is lost; a saved file is safe, and desktop_put_file brings it back. Returns file_id, name, size_bytes, sha256 and a url. Every call makes a new file. Limits: a regular, non-empty file under your home folder, not inside a hidden folder (the browser keeps its logins there); up to 100 MB (bigger is refused: cut or split it, or re-fetch raw footage from its source such as Drive); at most 20 saves per hour, so zip small files together. A file over 50 MB is not returned inline by get_file: you get a download link. Only your own computer is reachable.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			agent_id: optionalDesktopAgentId,
			path: z.string().min(1).max(1024).describe('Absolute or ~/ path, under your home folder.'),
			name: z.string().min(1).max(200).optional().describe('Defaults to the name on disk.'),
		}),
	},
	desktop_expose_port: {
		description:
			'Make a dev server in YOUR session sandbox (e.g. Vite on 5173) openable in the browser on your computer. Start the server first, bound to 0.0.0.0 or 127.0.0.1, then call this with its port. Returns a URL like http://host.microsandbox.internal:20003: open it in Chromium on your computer (ctrl+l, type the URL, Return). Localhost there is NOT your sandbox: use the returned URL. Idempotent per port. Ports are limited; free one with desktop_close_port. Set MASKIN_DEV_EXTERNAL=1 when starting the Maskin web dev server, or Vite rejects the host name. The tunnel closes when your session ends. Only works from inside a session.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			agent_id: optionalDesktopAgentId,
			guest_port: z
				.number()
				.int()
				.min(1)
				.max(65535)
				.describe('Port your server listens on, e.g. 5173.'),
		}),
	},
	desktop_list_ports: {
		description:
			'List the dev-server ports open from your computer: sandbox port, URL to open on your computer, and session. Does not start your computer.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			agent_id: optionalDesktopAgentId,
		}),
	},
	desktop_close_port: {
		description:
			'Close one open dev-server port to free a slot. Pass relay_port: the number after the colon in the URL from desktop_expose_port or desktop_list_ports.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			agent_id: optionalDesktopAgentId,
			relay_port: z.number().int().min(1).max(65535),
		}),
	},
} as const

// list_objects and search_objects as they were before the list contract (wave 2, T3):
// the definitions MASKIN_MCP_LIST_CONTRACT=off registers instead of the ones above, so a
// rollback restores tools/list as well as the handlers. Delete with the switch.
export const legacyListTools = {
	list_objects: {
		description:
			'List objects in the workspace. Filter by type, status, driver, last-updated window, or custom metadata fields. Newest created first unless `sort` is set. Archived rows are hidden unless `include_archived: true`. Default page 25; pass `next_cursor` as `cursor` for the next page (also with `sort`).',
		inputSchema: z.object({
			workspace_id: requiredWorkspaceId,
			type: z
				.string()
				.describe('Object type. Call get_workspace_schema to see the live list.')
				.optional(),
			status: z.string().optional(),
			driver: z.string().uuid().optional(),
			updated_before: z
				.string()
				.datetime({ offset: true })
				.optional()
				.describe(
					'ISO-8601 timestamp, exclusive: rows with `updated_at < updated_before`. Use to scan for stalled work, e.g. now - 6h.',
				),
			updated_after: z
				.string()
				.datetime({ offset: true })
				.optional()
				.describe(
					'ISO-8601 timestamp, exclusive: rows with `updated_at > updated_after`. Pairs with `updated_before` for a window.',
				),
			sort: z
				.enum(['updated_at_asc', 'updated_at_desc'])
				.optional()
				.describe(
					'Sort by `updated_at`: `updated_at_asc` oldest-stalled first, `updated_at_desc` most recent first. Omit for newest created first.',
				),
			limit: z.number().int().min(1).max(100).optional().describe('Defaults to 25.'),
			cursor: z
				.string()
				.optional()
				.describe('The `next_cursor` from the previous response (snapshot-consistent walk).'),
			metadata_eq: metadataEqSchema,
			include_archived: z
				.boolean()
				.default(false)
				.describe('Include rows with `status = "archived"` (excluded by default).'),
		}),
	},
	search_objects: {
		description:
			'Search objects by text in title or content, with optional type/status filters. Narrow by a custom metadata field with `metadata_eq`, e.g. `{"promotion_mode": "human_approved"}` (fields per type: get_workspace_schema). Archived rows are hidden unless `include_archived: true`. Paginated via `offset` (default page 25); results are ranked, so there is no `cursor` (unlike list_objects). Pages of one walk share a snapshot.',
		inputSchema: z.object({
			workspace_id: optionalWorkspaceId,
			q: z
				.string()
				.min(1)
				.describe(
					'Matches title and content (case-insensitive). Only the first 6 distinct words of 3 or more letters are used; the rest are ignored.',
				),
			type: z
				.string()
				.describe('Object type, built-in or custom. See get_workspace_schema.')
				.optional(),
			status: z.string().optional(),
			driver_id: z.string().uuid().optional(),
			updated_after: z
				.string()
				.datetime({ offset: true })
				.optional()
				.describe('ISO-8601 timestamp, exclusive: rows with `updated_at > updated_after`.'),
			limit: z.number().int().min(1).max(100).optional().describe('Defaults to 25.'),
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
				.describe('Include rows with `status = "archived"` (excluded by default).'),
		}),
	},
} as const
