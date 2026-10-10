import { expect } from '@playwright/test'

/**
 * Port of the in-memory Resend stand-in (scripts/mock-resend.mjs). The dev
 * server is pointed at it through RESEND_BASE_URL in playwright.config.ts, so
 * the real Resend SDK call from packages/email lands here and the invite email
 * — the only place the accept link is ever delivered — can be read back.
 */
export const E2E_MOCK_RESEND_PORT = 4010

const SINK_URL = `http://localhost:${E2E_MOCK_RESEND_PORT}/__sink`

interface SentEmail {
	to: string | string[]
	subject: string
	text: string
}

export async function clearSentEmails() {
	const res = await fetch(SINK_URL, { method: 'DELETE' })
	if (!res.ok) throw new Error(`clearSentEmails failed: ${res.status}`)
}

async function sentEmails(): Promise<SentEmail[]> {
	const res = await fetch(SINK_URL)
	if (!res.ok) throw new Error(`sentEmails failed: ${res.status}`)
	return res.json()
}

/** The accept-invite URL from the newest email sent to `to`, once one arrives. */
export async function waitForInviteLink(to: string): Promise<string> {
	let link = ''
	await expect
		.poll(
			async () => {
				const mail = (await sentEmails()).filter((m) => [m.to].flat().includes(to)).at(-1)
				link = mail?.text.match(/https?:\/\/\S+\/invite\?token=\S+/)?.[0] ?? ''
				return link
			},
			{ message: `invite email for ${to}`, timeout: 15000 },
		)
		.not.toBe('')
	return link
}
