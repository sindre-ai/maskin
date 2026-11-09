import { signEmailStopToken } from './email-stop-token'

/**
 * The "stop these emails" link for one account: the public GET and POST /api/email/stop route with
 * a signed token (lib/email-stop-token.ts). Throws when EMAIL_STOP_LINK_SECRET is not set, so a mail
 * without a working stop link is never built.
 */
export function buildEmailStopUrl(actorId: string, env: NodeJS.ProcessEnv = process.env): string {
	const base = env.APP_URL?.trim().replace(/\/+$/, '') || 'http://localhost:5173'
	return `${base}/api/email/stop?token=${encodeURIComponent(signEmailStopToken(actorId))}`
}
