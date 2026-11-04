import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// 1x1 PNG.
const PNG = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
	'base64',
)

test.describe('Agent profile picture', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`an admin uploads a picture and it survives a reload @ ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			const agent = await account.api.createAgentActor('Pic Tester')
			await account.api.addWorkspaceMember(account.workspaceId, agent.id)

			await page.goto(`/${account.workspaceId}/agents/${agent.id}`)
			const change = page.getByRole('button', { name: 'Change profile picture for Pic Tester' })
			await expect(change).toBeVisible({ timeout: 10_000 })

			const chooser = page.waitForEvent('filechooser')
			await change.click()
			await (await chooser).setFiles({ name: 'face.png', mimeType: 'image/png', buffer: PNG })

			const picture = page.locator(`img[src*="/api/actors/${agent.id}/avatar?v="]`).first()
			await expect(picture).toBeVisible({ timeout: 10_000 })

			// The picture is served without an API key, since <img> cannot send one.
			const src = (await picture.getAttribute('src')) as string
			const res = await page.request.get(src, { headers: { Authorization: '' } })
			expect(res.status()).toBe(200)
			expect(res.headers()['content-type']).toBe('image/png')

			await page.reload()
			await expect(
				page.locator(`img[src*="/api/actors/${agent.id}/avatar?v="]`).first(),
			).toBeVisible({ timeout: 10_000 })
		})
	}
})
