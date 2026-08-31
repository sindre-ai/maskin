import type { FieldDefinition, ModuleDefinition } from '@maskin/module-sdk'
import { MODULE_ID, MODULE_NAME } from '../shared.js'

// The `loop` type: a named, iterative multi-agent process wrapping triggers +
// agents + a pipeline of object states. `status` is a graduated-trust ladder
// (draft → learning → supervised → fully_autonomous), not an on/off toggle;
// `paused` can be reached from any point on that ladder and disables every
// trigger the loop references (see the status hook in
// `apps/dev/src/routes/objects.ts`'s `PATCH /:id`). Metadata fields are plain
// text per T1's decision — no DSL until an orchestration runtime exists to
// consume it.
const LOOP_STATUSES = ['draft', 'paused', 'learning', 'supervised', 'fully_autonomous']
const LOOP_FIELDS: FieldDefinition[] = [
	{ name: 'entry_condition', type: 'text' },
	{ name: 'close_condition', type: 'text' },
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
			defaultStatuses: ['signal', 'define', 'active', 'live', 'succeeded', 'failed', 'paused'],
		},
		{
			type: 'task',
			label: 'Task',
			icon: 'check-square',
			defaultStatuses: ['todo', 'in_progress', 'in_review', 'validated', 'done', 'discarded'],
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
			loop: 'Loop',
		},
		statuses: {
			insight: ['new', 'processing', 'clustered', 'scored', 'parked', 'discarded'],
			bet: ['signal', 'define', 'active', 'live', 'succeeded', 'failed', 'paused'],
			task: ['todo', 'in_progress', 'in_review', 'validated', 'done', 'discarded'],
			loop: LOOP_STATUSES,
		},
		field_definitions: {
			loop: LOOP_FIELDS,
		},
	},
}

export default workExtension
