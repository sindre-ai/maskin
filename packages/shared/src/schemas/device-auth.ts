import { z } from 'zod'

/** Clients that may ask to be signed in with a code. Closed on purpose: the approver is shown the
 * client by name, so an unknown free-text value must not become a label. */
export const DEVICE_AUTH_CLIENTS = ['tvos'] as const
export const deviceAuthClientSchema = z.enum(DEVICE_AUTH_CLIENTS)

/** How long a sign-in code lives, and how often the device should poll. */
export const DEVICE_AUTH_EXPIRES_IN_SECONDS = 10 * 60
export const DEVICE_AUTH_POLL_INTERVAL_SECONDS = 5

/** Characters a person can read off a TV and type without doubt: consonants only (so a code never
 * spells a word) and the digits 2-9 (no 0/1/O/I look-alikes). 27 symbols over 8 positions is about
 * 2.8e11 codes. */
export const USER_CODE_ALPHABET = 'BCDFGHJKMNPQRSTVWXZ23456789' as const
export const USER_CODE_LENGTH = 8

/** "bcdf-2345" -> "BCDF2345", or null when it cannot be a code. Dashes, spaces and case are
 * ignored, so how it was typed does not matter. */
export function normalizeUserCode(raw: string): string | null {
	const cleaned = raw.toUpperCase().replace(/[\s-]/g, '')
	if (cleaned.length !== USER_CODE_LENGTH) return null
	for (const ch of cleaned) if (!USER_CODE_ALPHABET.includes(ch)) return null
	return cleaned
}

/** "BCDF2345" -> "BCDF-2345", the form shown on screen. */
export function formatUserCode(code: string): string {
	return `${code.slice(0, 4)}-${code.slice(4)}`
}

export const deviceAuthStartSchema = z.object({
	client: deviceAuthClientSchema,
	device_name: z.string().trim().min(1).max(60).optional(),
})

export const deviceAuthStartResponseSchema = z.object({
	device_code: z.string(),
	user_code: z.string(),
	verification_uri: z.string().url(),
	verification_uri_complete: z.string().url(),
	expires_in: z.number().int().positive(),
	interval: z.number().int().positive(),
})

export const deviceAuthCodeBodySchema = z.object({
	user_code: z.string().min(1).max(32),
})

export const deviceAuthPreviewResponseSchema = z.object({
	client: deviceAuthClientSchema,
	device_name: z.string().nullable(),
	created_at: z.string(),
})

export const deviceAuthTokenSchema = z.object({
	device_code: z.string().min(1).max(256),
})

export type DeviceAuthStartInput = z.infer<typeof deviceAuthStartSchema>
export type DeviceAuthStartResponse = z.infer<typeof deviceAuthStartResponseSchema>
