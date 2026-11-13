import { randomUUID } from 'node:crypto'
import { hashPassword, issueApiKey, validateApiKey } from '@maskin/auth'
import { passwordResetTokens } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { insertActor } from '../factories'
import { jsonRequest } from '../helpers'
import { createIntegrationApp, db } from './global-setup'

// The route sends the mail without awaiting it. The send is mocked at the module boundary, so no
// Resend call is made and the link (and its token) can be read back.
const { sendPasswordResetEmailMock } = vi.hoisted(() => ({
	sendPasswordResetEmailMock: vi.fn().mockResolvedValue(true),
}))
vi.mock('@maskin/email', async (importOriginal) => ({
	...(await importOriginal<typeof import('@maskin/email')>()),
	sendPasswordResetEmail: sendPasswordResetEmailMock,
}))

const { default: authRoutes, _resetPasswordResetLimiters } = await import('../../routes/auth')
const { createPasswordResetToken, PASSWORD_RESET_TTL_MS } = await import('../../lib/password-reset')

const OLD_PASSWORD = 'old password 123'
const NEW_PASSWORD = 'new password 456'
const uniqueEmail = () => `reset-${randomUUID().slice(0, 8)}@example.com`

const app = () => createIntegrationApp({ path: '/api/auth', module: authRoutes as never })
const post = (path: string, body: unknown) =>
	app().request(jsonRequest('POST', `/api/auth${path}`, body))

async function person(opts: { password?: string | null } = {}) {
	const password = opts.password === undefined ? OLD_PASSWORD : opts.password
	return insertActor(db, {
		type: 'human',
		email: uniqueEmail(),
		passwordHash: password ? await hashPassword(password) : null,
		apiKey: null,
	})
}

async function login(email: string, password: string) {
	return post('/login', { email, password })
}

/** The token in the newest reset link sent to `to`, once the unawaited send has run. */
async function tokenSentTo(to: string): Promise<string> {
	let token = ''
	await vi.waitFor(() => {
		const call = sendPasswordResetEmailMock.mock.calls.map(([p]) => p).findLast((p) => p.to === to)
		expect(call).toBeDefined()
		token = new URL(call.resetUrl).searchParams.get('token') as string
	})
	return token
}

describe('Forgot password (real Postgres)', () => {
	beforeEach(() => {
		_resetPasswordResetLimiters()
		sendPasswordResetEmailMock.mockClear()
	})

	it('resets by email link: new password works, old fails, old sign-ins end', async () => {
		const p = await person()
		const email = p.email as string
		const oldLogin = ((await (await login(email, OLD_PASSWORD)).json()) as { api_key: string })
			.api_key
		const { key: personalKey } = await issueApiKey(db, { actorId: p.id, kind: 'personal' })
		expect(await validateApiKey(db, oldLogin)).not.toBeNull()

		const res = await post('/forgot-password', { email })
		expect(res.status).toBe(200)
		const token = await tokenSentTo(email)

		const reset = await post('/reset-password', { token, password: NEW_PASSWORD })
		expect(reset.status).toBe(200)

		expect((await login(email, OLD_PASSWORD)).status).toBe(401)
		expect((await login(email, NEW_PASSWORD)).status).toBe(200)
		expect(await validateApiKey(db, oldLogin)).toBeNull()
		expect(await validateApiKey(db, personalKey)).not.toBeNull()
	})

	it('stores only a hash of the token', async () => {
		const p = await person()
		await post('/forgot-password', { email: p.email })
		const token = await tokenSentTo(p.email as string)

		const rows = await db
			.select()
			.from(passwordResetTokens)
			.where(eq(passwordResetTokens.actorId, p.id))
		expect(rows).toHaveLength(1)
		expect(rows[0].tokenHash).not.toBe(token)
		expect(JSON.stringify(rows[0])).not.toContain(token)
	})

	it('works once', async () => {
		const p = await person()
		await post('/forgot-password', { email: p.email })
		const token = await tokenSentTo(p.email as string)

		expect((await post('/reset-password', { token, password: NEW_PASSWORD })).status).toBe(200)
		const again = await post('/reset-password', { token, password: 'another password 789' })
		expect(again.status).toBe(400)
		expect((await login(p.email as string, NEW_PASSWORD)).status).toBe(200)
	})

	it('does not work after an hour', async () => {
		const p = await person()
		const issuedAt = new Date(Date.now() - PASSWORD_RESET_TTL_MS - 60_000)
		const token = await createPasswordResetToken(db, p.id, issuedAt)

		const res = await post('/reset-password', { token, password: NEW_PASSWORD })
		expect(res.status).toBe(400)
		expect((await login(p.email as string, OLD_PASSWORD)).status).toBe(200)
	})

	it('voids older links when a newer one is requested', async () => {
		const p = await person()
		await post('/forgot-password', { email: p.email })
		const first = await tokenSentTo(p.email as string)
		sendPasswordResetEmailMock.mockClear()
		await post('/forgot-password', { email: p.email })
		const second = await vi.waitFor(async () => {
			const t = await tokenSentTo(p.email as string)
			expect(t).not.toBe(first)
			return t
		})

		expect((await post('/reset-password', { token: first, password: NEW_PASSWORD })).status).toBe(
			400,
		)
		expect((await post('/reset-password', { token: second, password: NEW_PASSWORD })).status).toBe(
			200,
		)
	})

	it('answers an unknown email exactly like a known one and sends nothing', async () => {
		const known = await person()
		const knownRes = await post('/forgot-password', { email: known.email })
		const knownBody = await knownRes.text()
		await tokenSentTo(known.email as string)
		sendPasswordResetEmailMock.mockClear()

		const unknownEmail = uniqueEmail()
		const unknownRes = await post('/forgot-password', { email: unknownEmail })

		expect(unknownRes.status).toBe(knownRes.status)
		expect(await unknownRes.text()).toBe(knownBody)
		await new Promise((r) => setTimeout(r, 100))
		expect(sendPasswordResetEmailMock).not.toHaveBeenCalled()
	})

	it('sends nothing for an account with no password, with the same answer', async () => {
		const noPassword = await person({ password: null })
		const res = await post('/forgot-password', { email: noPassword.email })

		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ ok: true })
		await new Promise((r) => setTimeout(r, 100))
		expect(sendPasswordResetEmailMock).not.toHaveBeenCalled()
	})

	it('rejects a short new password and keeps the link usable', async () => {
		const p = await person()
		await post('/forgot-password', { email: p.email })
		const token = await tokenSentTo(p.email as string)

		expect((await post('/reset-password', { token, password: 'short' })).status).toBe(400)
		expect((await post('/reset-password', { token, password: NEW_PASSWORD })).status).toBe(200)
	})

	it('keeps answering 200 past the per-email limit but stops sending', async () => {
		const p = await person()
		for (let i = 0; i < 5; i++) {
			expect((await post('/forgot-password', { email: p.email })).status).toBe(200)
		}
		await new Promise((r) => setTimeout(r, 200))
		const sent = sendPasswordResetEmailMock.mock.calls.filter(([x]) => x.to === p.email)
		expect(sent).toHaveLength(3)
	})

	it('answers 429 past the per-IP limit on both routes', async () => {
		for (let i = 0; i < 10; i++) await post('/forgot-password', { email: uniqueEmail() })
		expect((await post('/forgot-password', { email: uniqueEmail() })).status).toBe(429)

		for (let i = 0; i < 10; i++) {
			await post('/reset-password', { token: 'rst_nope', password: NEW_PASSWORD })
		}
		expect(
			(await post('/reset-password', { token: 'rst_nope', password: NEW_PASSWORD })).status,
		).toBe(429)
	})
})
