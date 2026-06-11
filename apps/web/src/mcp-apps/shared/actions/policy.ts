/**
 * Mutation policy table for in-card actions. Single source of truth for
 * confirmation UX and optimistic-update behaviour.
 *
 * Documented in `packages/mcp/ACTIONS.md` (§ "Confirmation UX"). Adding a
 * new mutation kind = add an entry here, then build the matching
 * `<XAction>` component on top of `useObjectMutation` + `<ActionButton>`.
 */

import type { MutationKind, MutationPolicy } from './types'

const POLICY_TABLE: Record<MutationKind, MutationPolicy> = {
	object_status: {
		kind: 'object_status',
		confirm: false,
		label: 'Update status',
		variant: 'default',
		optimistic: true,
	},
	object_driver: {
		kind: 'object_driver',
		confirm: false,
		label: 'Assign driver',
		variant: 'default',
		optimistic: true,
	},
	object_relationship_add: {
		kind: 'object_relationship_add',
		confirm: false,
		label: 'Link',
		variant: 'default',
		optimistic: false,
	},
	object_delete: {
		kind: 'object_delete',
		confirm: true,
		label: 'Delete',
		confirmTitle: 'Delete this object?',
		confirmDescription:
			'This removes the object and its relationships. You can restore it from the activity feed if you change your mind.',
		variant: 'destructive',
		optimistic: false,
	},
}

export const MUTATION_POLICY: Readonly<Record<MutationKind, MutationPolicy>> = POLICY_TABLE

export function getMutationPolicy(kind: MutationKind): MutationPolicy {
	return POLICY_TABLE[kind]
}
