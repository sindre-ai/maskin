import { z } from 'zod'
import { tagListSchema } from './tags'

export const SAVED_VIEW_KINDS = ['flow', 'agent', 'chat'] as const
export const savedViewKindSchema = z.enum(SAVED_VIEW_KINDS)
export type SavedViewKind = z.infer<typeof savedViewKindSchema>

export const SAVED_VIEW_NAME_MAX_LENGTH = 60

/**
 * What a view keeps: tags (a row matches when it carries every one of them) and, for flows only,
 * the driver. No sorting rules and no query language, on purpose.
 */
export const savedViewFilterSchema = z
	.object({
		tags: tagListSchema.optional(),
		driverId: z.string().uuid().optional(),
	})
	.strict()

export const savedViewGroupBySchema = z.enum(['tag', 'driver'])

/** Rules that depend on the kind. A driver means a flow's driver, so agents and chats have none. */
function refineSavedViewForKind(
	v: {
		kind?: SavedViewKind
		filter?: { driverId?: string }
		groupBy?: 'tag' | 'driver' | null
	},
	ctx: z.RefinementCtx,
) {
	if (v.kind === undefined || v.kind === 'flow') return
	if (v.filter?.driverId !== undefined) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			path: ['filter', 'driverId'],
			message: 'Only flow views can filter by driver',
		})
	}
	if (v.groupBy === 'driver') {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			path: ['groupBy'],
			message: 'Only flow views can group by driver',
		})
	}
}

export const createSavedViewSchema = z
	.object({
		name: z.string().trim().min(1).max(SAVED_VIEW_NAME_MAX_LENGTH),
		kind: savedViewKindSchema,
		filter: savedViewFilterSchema.default({}),
		groupBy: savedViewGroupBySchema.nullable().default(null),
	})
	.superRefine(refineSavedViewForKind)

export const savedViewListQuerySchema = z.object({
	kind: savedViewKindSchema.optional(),
})

export const savedViewResponseSchema = z.object({
	id: z.string().uuid(),
	workspaceId: z.string().uuid(),
	name: z.string(),
	kind: savedViewKindSchema,
	filter: savedViewFilterSchema,
	groupBy: savedViewGroupBySchema.nullable(),
	createdBy: z.string().uuid().nullable(),
	createdAt: z.string(),
	updatedAt: z.string(),
})

/**
 * A view applied: the ids that match, split into groups. Flows and agents come by name, chats
 * by latest message. With no group-by there is one group with a null key. With group-by tag a
 * row sits under each of its own tags, and rows with no tag sit under a null key. With group-by
 * driver a row sits under its driver's id, or a null key.
 */
export const savedViewApplyResponseSchema = z.object({
	view: savedViewResponseSchema,
	groups: z.array(z.object({ key: z.string().nullable(), ids: z.array(z.string().uuid()) })),
})
