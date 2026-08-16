import type { FieldDefinition, ModuleDefinition } from '@maskin/module-sdk'
import { MODULE_ID, MODULE_NAME } from '../shared.js'

// The former `loop` object type — standing commitments graduated from
// succeeded bets — was renamed to `commitment` in T1 of bet/loops-first-class
// so the `loop` name could be reused for the new pipeline concept below.
// Fields and statuses are unchanged from the pre-rename shape, only the type
// name moved. Data migration lives in
// `packages/db/drizzle/0050_rename_loop_to_commitment.sql`.
const COMMITMENT_STATUSES = ['holding', 'at-risk', 'breached']
const COMMITMENT_FIELDS: FieldDefinition[] = [
	{ name: 'floor', type: 'text' },
	{ name: 'cadence', type: 'text' },
	{ name: 'source_bet_id', type: 'text' },
	{ name: 'last_breach_at', type: 'date' },
]

// The new `loop` type: a named, persistent multi-agent process wrapping
// triggers + agents + a pipeline of object states. `archived` is a silent
// terminal (mirrors the bet convention) and is kept out of the attention-worthy
// set. Metadata fields are plain text per T1's decision — no DSL until an
// orchestration runtime exists to consume it.
const LOOP_STATUSES = ['running', 'waiting', 'paused', 'archived']
const LOOP_FIELDS: FieldDefinition[] = [
	{ name: 'entry_condition', type: 'text' },
	{ name: 'close_condition', type: 'text' },
	{ name: 'human_decision_points', type: 'number' },
	{ name: 'installed_from_marketplace_loop_id', type: 'text' },
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
			icon: 'shield',
			defaultStatuses: COMMITMENT_STATUSES,
			defaultFields: COMMITMENT_FIELDS,
		},
		{
			type: 'loop',
			label: 'Loop',
			icon: 'repeat',
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
