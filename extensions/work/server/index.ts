import type { FieldDefinition, ModuleDefinition } from '@maskin/module-sdk'
import { MODULE_ID, MODULE_NAME } from '../shared.js'

// Standing-commitment primitive — statuses signal health of the commitment
// itself (holding = quiet, at-risk = drifting, breached = floor broken).
// Renamed from `loop` in the loops-first-class-type bet so the `loop` name
// is free for the multi-agent pipeline primitive below. See migration
// `0050_rename_loop_to_commitment.sql` for the existing-row rename.
const COMMITMENT_STATUSES = ['holding', 'at-risk', 'breached']
const COMMITMENT_FIELDS: FieldDefinition[] = [
	{ name: 'floor', type: 'text' },
	{ name: 'cadence', type: 'text' },
	{ name: 'source_bet_id', type: 'text' },
	{ name: 'last_breach_at', type: 'date' },
]

// Multi-agent pipeline primitive — a named, persistent process wrapping
// multiple triggers + agents + a queue of in-flight objects. Statuses:
// `running` (steady state), `waiting` (paused on human input), `paused`
// (operator-halted), `archived` (silent terminal — mirrors bet convention).
// Metadata is plain text for entry/close conditions per the T1 architecture
// decision — no orchestration engine exists yet to consume a parseable DSL.
const LOOP_STATUSES = ['running', 'waiting', 'paused', 'archived']
const LOOP_FIELDS: FieldDefinition[] = [
	{ name: 'entry_condition', type: 'text' },
	{ name: 'close_condition', type: 'text' },
	{ name: 'human_decision_points', type: 'number' },
	// `trigger_ids` (uuid[]) and `installed_from_package_id` (uuid) also
	// travel on metadata but are not surfaced as user-editable fields — the
	// install flow and trigger-attachment UI (both deferred) manage them.
]

const workExtension: ModuleDefinition = {
	id: MODULE_ID,
	name: MODULE_NAME,
	version: '0.1.0',
	objectTypes: [
		{
			type: 'insight',
			label: 'Insight',
			icon: 'lightbulb',
			defaultStatuses: ['new', 'processing', 'clustered', 'scored', 'parked', 'discarded'],
		},
		{
			type: 'bet',
			label: 'Bet',
			icon: 'target',
			defaultStatuses: [
				'signal',
				'qualified',
				'define',
				'active',
				'live',
				'succeeded',
				'failed',
				'paused',
			],
		},
		{
			type: 'task',
			label: 'Task',
			icon: 'check-square',
			defaultStatuses: ['todo', 'in_progress', 'in_review', 'validated', 'done', 'discarded'],
		},
		{
			type: 'commitment',
			label: 'Commitment',
			icon: 'repeat',
			defaultStatuses: COMMITMENT_STATUSES,
			defaultFields: COMMITMENT_FIELDS,
		},
		{
			type: 'loop',
			label: 'Loop',
			icon: 'infinity',
			defaultStatuses: LOOP_STATUSES,
			defaultFields: LOOP_FIELDS,
		},
	],
	defaultSettings: {
		display_names: {
			insight: 'Insight',
			bet: 'Bet',
			task: 'Task',
			commitment: 'Commitment',
			loop: 'Loop',
		},
		statuses: {
			insight: ['new', 'processing', 'clustered', 'scored', 'parked', 'discarded'],
			bet: ['signal', 'qualified', 'define', 'active', 'live', 'succeeded', 'failed', 'paused'],
			task: ['todo', 'in_progress', 'in_review', 'validated', 'done', 'discarded'],
			commitment: COMMITMENT_STATUSES,
			loop: LOOP_STATUSES,
		},
		field_definitions: {
			commitment: COMMITMENT_FIELDS,
			loop: LOOP_FIELDS,
		},
	},
}

export default workExtension
