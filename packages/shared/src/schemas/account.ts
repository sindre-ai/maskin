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
			/** True when nobody else is in it. Such a workspace is deleted with the account if the
			 * request sets `delete_sole_workspaces`; otherwise it stays, with no human able to open it. */
			will_delete: z.boolean(),
		}),
	),
})

export const deleteAccountSchema = z.object({
	/** Re-entered so a stolen or left-open session can't delete the account. */
	password: z.string().min(1).max(256),
	/** Also delete every workspace the person is the only human in (the `will_delete` ones). */
	delete_sole_workspaces: z.boolean().default(false),
})

/** Deleting a workspace outright. Only its billing owner may; everything in it is purged. */
export const workspaceDeletionPreviewSchema = z.object({
	workspace_id: z.string().uuid(),
	workspace_name: z.string(),
	can_delete: z.boolean(),
	/** `not_billing_owner`: only the billing owner can delete. `cancel_plan`: cancel the live plan first. */
	blockers: z.array(
		z.object({ code: z.enum(['not_billing_owner', 'cancel_plan']), message: z.string() }),
	),
	/** Other people who lose access. */
	other_members: z.number().int().nonnegative(),
})

export const deleteWorkspaceSchema = z.object({
	/** The workspace name, typed back, so a misclick can't erase a workspace. */
	confirm_name: z.string().min(1).max(256),
})

export type AccountDeletionBlocker = z.infer<typeof accountDeletionBlockerSchema>
export type AccountDeletionPreview = z.infer<typeof accountDeletionPreviewSchema>
export type WorkspaceDeletionPreview = z.infer<typeof workspaceDeletionPreviewSchema>
