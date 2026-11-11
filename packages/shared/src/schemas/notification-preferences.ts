import { z } from 'zod'

/** Push categories a notification can carry in `metadata.push_category`. */
export const PUSH_CATEGORIES = [
	'needs_you',
	'conversation',
	'digest',
	'tips',
	'flow_activity',
] as const
export const pushCategorySchema = z.enum(PUSH_CATEGORIES)
export type PushCategory = z.infer<typeof pushCategorySchema>

/** How often the summary email comes. Off is the email switch being off, not a third value. */
export const EMAIL_RHYTHMS = ['daily', 'weekly'] as const
export const emailRhythmSchema = z.enum(EMAIL_RHYTHMS)
export type EmailRhythm = z.infer<typeof emailRhythmSchema>
/** No saved rhythm means daily. */
export const DEFAULT_EMAIL_RHYTHM: EmailRhythm = 'daily'

export const NOTIFICATION_PREFERENCES_DEFAULTS = {
	timezone: null,
	quiet_hours_start: null,
	quiet_hours_end: null,
	categories: {
		needs_you: true,
		conversation: true,
		digest: true,
		tips: true,
		/** Opt-in: off for everyone until chosen. */
		flow_activity: false,
	},
	briefing_enabled: true,
	/** Minutes from local midnight: 08:30. */
	briefing_time: 510,
	muted_workspace_ids: [] as string[],
} as const

/**
 * What a new sign-up starts with: Needs you, Chat replies and Digests on, Tips off. Stored on the
 * sign-up row only. A person with no row, or a row from before, keeps everything on.
 */
export const NEW_SIGNUP_PUSH_CATEGORIES = {
	needs_you: true,
	conversation: true,
	digest: true,
	tips: false,
	flow_activity: false,
} as const

/**
 * The Browser switch per kind. A kind that was never saved is "not asked": it follows that kind's
 * Push switch, so the person gets the same as before the Browser column existed.
 */
export function resolveBrowserCategories(
	push: Record<PushCategory, boolean>,
	saved: Partial<Record<PushCategory, boolean>> | null | undefined,
): { browser: Record<PushCategory, boolean>; notAsked: PushCategory[] } {
	const browser = { ...push }
	const notAsked: PushCategory[] = []
	for (const kind of PUSH_CATEGORIES) {
		const value = saved?.[kind]
		if (typeof value === 'boolean') browser[kind] = value
		else notAsked.push(kind)
	}
	return { browser, notAsked }
}

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
	flow_activity: z.boolean(),
})

/** The kinds that can also arrive as their own email. Only Flow activity so far; empty means off. */
export const EMAIL_KINDS = ['flow_activity'] as const
export const emailCategoriesSchema = z.object({ flow_activity: z.boolean() })

export const notificationPreferencesResponseSchema = z.object({
	timezone: timezoneSchema.nullable(),
	quiet_hours_start: minuteOfDay.nullable(),
	quiet_hours_end: minuteOfDay.nullable(),
	categories: notificationCategoriesSchema,
	/** The Browser switch per kind; a kind listed in `browser_not_asked` follows its Push switch. */
	browser_categories: notificationCategoriesSchema,
	browser_not_asked: z.array(pushCategorySchema),
	briefing_enabled: z.boolean(),
	briefing_time: minuteOfDay,
	/**
	 * Whether the summary email is on for this person. A saved choice is returned as saved; when
	 * there is none, it is what the sending rule would give them (on if they did something real in
	 * the last 30 days, otherwise off).
	 */
	email_digest_enabled: z.boolean(),
	/** The Email switch per kind other than the summary; a kind never switched on is false. */
	email_categories: emailCategoriesSchema,
	/** The Marketplace picks switch for the summary email. Off until the person turns it on. */
	marketplace_picks_enabled: z.boolean(),
	/** How often the summary email comes; daily when the person never chose. */
	email_rhythm: emailRhythmSchema,
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
		browser_categories: notificationCategoriesSchema.partial(),
		briefing_enabled: z.boolean(),
		briefing_time: minuteOfDay,
		email_digest_enabled: z.boolean(),
		email_categories: emailCategoriesSchema.partial(),
		marketplace_picks_enabled: z.boolean(),
		email_rhythm: emailRhythmSchema,
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
