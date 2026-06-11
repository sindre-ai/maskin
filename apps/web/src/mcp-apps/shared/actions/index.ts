/**
 * MCP card action layer — barrel.
 *
 * Companion to the widget catalog (`../widgets/`). Wave 2/3 cards (F7/F8)
 * import these primitives instead of re-rolling confirmation dialogs,
 * optimistic update plumbing, or per-mutation auth wiring.
 *
 * See `packages/mcp/ACTIONS.md` for the full design contract.
 */

export { ActionButton } from './action-button'
export { ConfirmDialog } from './confirm-dialog'
export { useObjectMutation } from './use-object-mutation'
export { MUTATION_POLICY, getMutationPolicy } from './policy'
export type {
	MutationKind,
	MutationOutcome,
	MutationPolicy,
	ObjectMutation,
	ObjectMutationState,
} from './types'
