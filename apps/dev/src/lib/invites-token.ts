import { createHash, randomBytes } from 'node:crypto'

// 32 random bytes → base64url encoding lands at 43 chars (256 / 6, no padding).
// Well above the 128-bit entropy floor. Store only the hash — the raw token
// leaves the process exactly once, in the invite email URL.
export function generateInviteToken(): string {
	return randomBytes(32).toString('base64url')
}

export function hashInviteToken(token: string): string {
	return createHash('sha256').update(token).digest('hex')
}
