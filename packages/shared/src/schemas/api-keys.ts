import { z } from 'zod'

/** Longest name a person can give a key. */
export const API_KEY_NAME_MAX = 60

export const apiKeyKindSchema = z.enum(['primary', 'login', 'login_ios', 'session', 'personal'])

/**
 * One of a person's own live keys, as the Keys and MCP page shows it. The secret and its hash
 * never leave the server: `hint` is the front and the last four characters, enough to recognise
 * a key you hold.
 */
export const apiKeySchema = z.object({
	id: z.string().uuid(),
	kind: apiKeyKindSchema,
	/** The label the person gave a personal key. Null on every other kind. */
	name: z.string().nullable(),
	/** `ank_…` followed by the last four characters. */
	hint: z.string(),
	created_at: z.string().datetime(),
	/** Stamped when the key authenticates, at most once per cache window. Null: never used. */
	last_used_at: z.string().datetime().nullable(),
	expires_at: z.string().datetime().nullable(),
	/**
	 * What holds the key: the sign-in it was minted for, or null when Maskin cannot tell (a
	 * personal key can be pasted anywhere). A session key belongs to an agent, not a person, and
	 * so is never in this list.
	 */
	used_by: z.object({ type: z.literal('connection'), name: z.string() }).nullable(),
})

export const apiKeyListSchema = z.object({ keys: z.array(apiKeySchema) })

export const createApiKeySchema = z.object({
	name: z.string().trim().min(1).max(API_KEY_NAME_MAX),
})

/** Returned once, on creation. `secret` is the only copy there will ever be. */
export const createdApiKeySchema = z.object({
	key: apiKeySchema,
	secret: z.string(),
})

export type ApiKeySummary = z.infer<typeof apiKeySchema>
