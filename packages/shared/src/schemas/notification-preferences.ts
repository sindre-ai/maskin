import { z } from 'zod'

/** Push categories a notification can carry in `metadata.push_category`. */
export const PUSH_CATEGORIES = ['needs_you', 'conversation', 'digest', 'tips'] as const
export const pushCategorySchema = z.enum(PUSH_CATEGORIES)
export type PushCategory = z.infer<typeof pushCategorySchema>

export const NOTIFICATION_PREFERENCES_DEFAULTS = {
	timezone: null,
	quiet_hours_start: null,
	quiet_hours_end: null,
	categories: { needs_you: true, conversation: true, digest: true, tips: true },
	briefing_enabled: true,
	/** Minutes from local midnight: 08:30. */
	briefing_time: 510,
	muted_workspace_ids: [] as string[],
} as const

/** True when `tz` is a timezone the runtime's Intl database knows (IANA names, `UTC`). */
export function isValidTimezone(tz: string): boolean {
	if (!/^[A-Za-z][A-Za-z0-9_+\-]*(\/[A-Za-z0-9_+\-]+)*$/.test(tz)) return false
	try {
		new Intl.DateTimeFormat('en-US', { timeZone: tz })
		return true
	} catch {
		return false
	}
}

const minuteOfDay = z.number().int().min(0).max(1439)

export const timezoneSchema = z
	.string()
	.min(1)
	.max(64)
	.refine(isValidTimezone, { message: 'Must be a valid IANA timezone, e.g. Europe/Oslo' })

export const notificationCategoriesSchema = z.object({
	needs_you: z.boolean(),
	conversation: z.boolean(),
	digest: z.boolean(),
	tips: z.boolean(),
})

export const notificationPreferencesResponseSchema = z.object({
	timezone: timezoneSchema.nullable(),
	quiet_hours_start: minuteOfDay.nullable(),
	quiet_hours_end: minuteOfDay.nullable(),
	categories: notificationCategoriesSchema,
	briefing_enabled: z.boolean(),
	briefing_time: minuteOfDay,
	muted_workspace_ids: z.array(z.string().uuid()),
	/** Null when the actor has never saved preferences (defaults are returned). */
	updated_at: z.string().nullable(),
})

/**
 * PUT body: every field optional, omitted fields keep their current value (or the default),
 * so the call is an idempotent upsert. `null` clears timezone / quiet hours. Quiet hours are
 * all-or-nothing: send both bounds or neither.
 */
export const updateNotificationPreferencesSchema = z
	.object({
		timezone: timezoneSchema.nullable(),
		quiet_hours_start: minuteOfDay.nullable(),
		quiet_hours_end: minuteOfDay.nullable(),
		categories: notificationCategoriesSchema.partial(),
		briefing_enabled: z.boolean(),
		briefing_time: minuteOfDay,
		muted_workspace_ids: z.array(z.string().uuid()).max(200),
	})
	.partial()
	.superRefine((v, ctx) => {
		const hasStart = v.quiet_hours_start !== undefined
		const hasEnd = v.quiet_hours_end !== undefined
		if (hasStart !== hasEnd) {
			ctx.addIssue({
				code: 'custom',
				path: [hasStart ? 'quiet_hours_end' : 'quiet_hours_start'],
				message: 'quiet_hours_start and quiet_hours_end must be sent together',
			})
		} else if ((v.quiet_hours_start === null) !== (v.quiet_hours_end === null)) {
			ctx.addIssue({
				code: 'custom',
				path: ['quiet_hours_end'],
				message: 'quiet_hours_start and quiet_hours_end must both be set or both be null',
			})
		}
	})

export type NotificationPreferencesResponse = z.infer<typeof notificationPreferencesResponseSchema>
export type UpdateNotificationPreferencesInput = z.infer<typeof updateNotificationPreferencesSchema>
