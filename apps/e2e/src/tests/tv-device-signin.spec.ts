import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

/**
 * Signing in an Apple TV with a code (RFC 8628 device authorization).
 *
 * The TV is not a browser, so the spec plays its part over HTTP: it asks for a code, shows it to the
 * page as the person would see it, and polls for the session. What it asserts is the contract the
 * TV depends on: the session arrives only after an explicit approval, exactly once, and a refusal
 * hands over nothing.
 */

const API = 'http://localhost:5173/api/device-auth'

async function startOnTv(deviceName = 'Living Room') {
	const res = await fetch(`${API}/start`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ client: 'tvos', device_name: deviceName }),
	})
	expect(res.status).toBe(201)
	return (await res.json()) as { device_code: string; user_code: string }
}

// Keys are stored hashed, so the TV is handed a key minted for it rather than the account's own.
// What matters is that it is a real key and signs in as the person who approved.
async function expectTvKeySignsInAs(apiKey: string | undefined, actorId: string) {
	expect(apiKey).toMatch(/^ank_[a-f0-9]{32}$/)
	const res = await fetch(`http://localhost:5173/api/actors/${actorId}`, {
		headers: { Authorization: `Bearer ${apiKey}` },
	})
	expect(res.status).toBe(200)
}

async function pollFromTv(deviceCode: string) {
	const res = await fetch(`${API}/token`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ device_code: deviceCode }),
	})
	expect(res.status).toBe(200)
	return (await res.json()) as { status: string; actor?: { api_key: string } }
}

for (const viewport of SHIP_GATE_VIEWPORTS) {
	test(`a person approves the TV from the code in its link at ${viewport.label}`, async ({
		page,
		account,
	}) => {
		const tv = await startOnTv()
		expect((await pollFromTv(tv.device_code)).status).toBe('pending')

		await page.setViewportSize({ width: viewport.width, height: viewport.height })
		await page.goto(`/tv?code=${tv.user_code}`)

		await expect(page.getByRole('heading', { name: 'Sign in Living Room?' })).toBeVisible()
		// Nothing is handed over until the person says so.
		expect((await pollFromTv(tv.device_code)).status).toBe('pending')

		await page.getByRole('button', { name: 'Approve' }).click()
		await expect(page.getByRole('heading', { name: 'Your TV is signing in' })).toBeVisible()

		const approved = await pollFromTv(tv.device_code)
		expect(approved.status).toBe('approved')
		await expectTvKeySignsInAs(approved.actor?.api_key, account.actorId)
		// Single use: the code is spent the moment the session is handed over.
		expect((await pollFromTv(tv.device_code)).status).toBe('expired')
	})
}

test('a person types the code by hand, lower case and without the dash', async ({
	page,
	account,
}) => {
	const tv = await startOnTv('Bedroom')
	await page.goto('/tv')

	const field = page.getByLabel('Code')
	await field.fill(tv.user_code.replace('-', '').toLowerCase())
	await expect(field).toHaveValue(tv.user_code)

	await page.getByRole('button', { name: 'Continue' }).click()
	await expect(page.getByRole('heading', { name: 'Sign in Bedroom?' })).toBeVisible()
	await page.getByRole('button', { name: 'Approve' }).click()
	await expect(page.getByRole('heading', { name: 'Your TV is signing in' })).toBeVisible()
	await expectTvKeySignsInAs((await pollFromTv(tv.device_code)).actor?.api_key, account.actorId)
})

// `account` is requested (not used) so the fixture signs the page in before it loads.
test('refusing a TV hands over nothing', async ({ page, account: _account }) => {
	const tv = await startOnTv()
	await page.goto(`/tv?code=${tv.user_code}`)
	await page.getByRole('button', { name: "This isn't me" }).click()

	await expect(page.getByRole('heading', { name: 'Sign-in refused' })).toBeVisible()
	const polled = await pollFromTv(tv.device_code)
	expect(polled.status).toBe('denied')
	expect(polled.actor).toBeUndefined()
})

test('a wrong code says so without revealing anything', async ({ page, account: _account }) => {
	await page.goto('/tv')
	await page.getByLabel('Code').fill('BCDF2345')
	await page.getByRole('button', { name: 'Continue' }).click()
	await expect(page.getByText(/isn't valid or has expired/)).toBeVisible()
})
