import { z } from 'zod'

/** Why an account can't be deleted yet. Each names the workspace and what to do about it. */
export const accountDeletionBlockerSchema = z.object({
	/** `transfer_ownership`: you pay for a workspace other people use; hand it to one of them first.
	 * `cancel_plan`: you pay for a plan; cancel it first so billing doesn't outlive the account. */
	code: z.enum(['transfer_ownership', 'cancel_plan']),
	workspace_id: z.string().uuid(),
	workspace_name: z.string(),
})

export const accountDeletionPreviewSchema = z.object({
	can_delete: z.boolean(),
	blockers: z.array(accountDeletionBlockerSchema),
	/** The workspaces the person will leave, with how many OTHER people are in each. A workspace
	 * with nobody else keeps its content but has no human left in it. */
	leaving: z.array(
		z.object({
			workspace_id: z.string().uuid(),
			workspace_name: z.string(),
			other_members: z.number().int().nonnegative(),
		}),
	),
})

export const deleteAccountSchema = z.object({
	/** Re-entered so a stolen or left-open session can't delete the account. */
	password: z.string().min(1).max(256),
})

export type AccountDeletionBlocker = z.infer<typeof accountDeletionBlockerSchema>
export type AccountDeletionPreview = z.infer<typeof accountDeletionPreviewSchema>
