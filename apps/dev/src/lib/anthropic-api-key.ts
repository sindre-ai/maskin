import type { Database } from '@maskin/db'
import { workspaces } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { decrypt, encrypt } from './crypto'

export interface EncryptedAnthropicApiKey {
	encryptedKey: string
	last4: string
	createdAt: number
}

const ANTHROPIC_MODELS_URL = 'https://api.anthropic.com/v1/models'
const ANTHROPIC_VALIDATION_TIMEOUT_MS = 10_000

export function maskAnthropicKey(plaintext: string): string {
	return plaintext.slice(-4)
}

export function encryptAnthropicApiKey(plaintext: string): EncryptedAnthropicApiKey {
	return {
		encryptedKey: encrypt(plaintext),
		last4: maskAnthropicKey(plaintext),
		createdAt: Date.now(),
	}
}

export function decryptAnthropicApiKey(data: EncryptedAnthropicApiKey): string {
	return decrypt(data.encryptedKey)
}

export interface ValidateResult {
	ok: boolean
	status?: number
	message?: string
}

/**
 * Validate an Anthropic API key by making a cheap GET /v1/models call.
 * Returns ok=true on 200, ok=false with status+message otherwise.
 */
export async function validateAnthropicApiKey(
	plaintext: string,
	fetchImpl: typeof fetch = fetch,
): Promise<ValidateResult> {
	try {
		const res = await fetchImpl(ANTHROPIC_MODELS_URL, {
			method: 'GET',
			headers: {
				'x-api-key': plaintext,
				'anthropic-version': '2023-06-01',
			},
			signal: AbortSignal.timeout(ANTHROPIC_VALIDATION_TIMEOUT_MS),
		})
		if (res.ok) {
			return { ok: true, status: res.status }
		}
		let message = `Anthropic API rejected the key (${res.status})`
		try {
			const body = (await res.json()) as { error?: { message?: string } }
			if (body?.error?.message) {
				message = body.error.message
			}
		} catch {
			// ignore non-JSON bodies
		}
		return { ok: false, status: res.status, message }
	} catch (err) {
		return { ok: false, message: `Could not reach Anthropic API: ${String(err)}` }
	}
}

/**
 * Load the decrypted Anthropic API key for a workspace, or null if not set.
 */
export async function getAnthropicApiKey(
	db: Database,
	workspaceId: string,
): Promise<string | null> {
	const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1)
	const settings = (ws?.settings as Record<string, unknown>) ?? {}
	const data = settings.anthropic_api_key as EncryptedAnthropicApiKey | undefined
	if (!data?.encryptedKey) return null
	return decryptAnthropicApiKey(data)
}
