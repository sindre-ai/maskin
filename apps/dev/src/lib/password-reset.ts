import { mintToken, sha256Hex } from '@maskin/auth'
import type { Database, Transaction } from '@maskin/db'
import { passwordResetTokens } from '@maskin/db/schema'
import { and, eq, gt, isNull } from 'drizzle-orm'

/** How long an emailed reset link works. */
export const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000

const TOKEN_PREFIX = 'rst_'

/**
 * Stores a fresh reset token for the actor and voids their older unused ones, so only the newest
 * emailed link works. Only the SHA-256 is stored; the returned raw token goes into the email
 * and nowhere else.
 */
export async function createPasswordResetToken(
	db: Database,
	actorId: string,
	now: Date = new Date(),
): Promise<string> {
	const { raw, hash } = mintToken(TOKEN_PREFIX)
	await db.transaction(async (tx) => {
		await tx
			.delete(passwordResetTokens)
			.where(and(eq(passwordResetTokens.actorId, actorId), isNull(passwordResetTokens.usedAt)))
		await tx.insert(passwordResetTokens).values({
			actorId,
			tokenHash: hash,
			expiresAt: new Date(now.getTime() + PASSWORD_RESET_TTL_MS),
		})
	})
	return raw
}

/**
 * Spends a reset token: marks it used and returns its actor, or null when the token is unknown,
 * already used or expired. The single UPDATE is the lock, so two requests with the same link
 * cannot both succeed.
 */
export async function consumePasswordResetToken(
	tx: Transaction,
	rawToken: string,
	now: Date = new Date(),
): Promise<string | null> {
	const [row] = await tx
		.update(passwordResetTokens)
		.set({ usedAt: now })
		.where(
			and(
				eq(passwordResetTokens.tokenHash, sha256Hex(rawToken)),
				isNull(passwordResetTokens.usedAt),
				gt(passwordResetTokens.expiresAt, now),
			),
		)
		.returning({ actorId: passwordResetTokens.actorId })
	return row?.actorId ?? null
}

/** The page the emailed link opens, or null when no safe base URL is configured. */
export function resolvePasswordResetUrl(rawToken: string): string | null {
	const configured = process.env.APP_URL?.trim().replace(/\/+$/, '')
	// Same rule as invite links: a localhost link must never reach a real inbox.
	const base = configured || (process.env.RESEND_API_KEY ? null : 'http://localhost:5173')
	return base ? `${base}/reset-password?token=${encodeURIComponent(rawToken)}` : null
}
