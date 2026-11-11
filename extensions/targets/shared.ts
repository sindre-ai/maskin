import type { FieldDefinition, ModuleDefaultSettings } from '@maskin/module-sdk'

/** Module ID — shared between server and web definitions to ensure consistency */
export const MODULE_ID = 'targets' as const
export const MODULE_NAME = 'Targets'

export const TARGET_TYPE = 'target' as const
export const TARGET_DISPLAY_NAME = 'Target'

export const TARGET_STATUSES = ['open', 'hit', 'missed', 'dropped']

/**
 * Same shape as a row in `metadata.targets` on a loop
 * (packages/shared/src/schemas/loop-targets.ts), plus `deadline`. The title is
 * the label and the object's driver is the owner.
 */
export const TARGET_FIELDS: FieldDefinition[] = [
	{ name: 'deadline', type: 'date' },
	{ name: 'source', type: 'text' },
	{ name: 'actual', type: 'number' },
	{ name: 'target', type: 'number' },
]

/**
 * Link from a flow target to the flow it measures: source = target object,
 * target = loop. Deliberately not `in_loop` (the flow-membership edge), so a
 * target is never counted as flow work. A company target links down to a flow
 * target with the existing `breaks_into`.
 */
export const TARGET_OF_RELATIONSHIP_TYPE = 'target_of'

export const TARGET_RELATIONSHIP_TYPES = ['breaks_into', TARGET_OF_RELATIONSHIP_TYPE]

export const TARGETS_DEFAULT_SETTINGS: ModuleDefaultSettings = {
	display_names: { [TARGET_TYPE]: TARGET_DISPLAY_NAME },
	statuses: { [TARGET_TYPE]: TARGET_STATUSES },
	field_definitions: { [TARGET_TYPE]: TARGET_FIELDS },
	relationship_types: TARGET_RELATIONSHIP_TYPES,
}
