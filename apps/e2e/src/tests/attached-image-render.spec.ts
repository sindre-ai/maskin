import { expect, test } from '../fixtures/auth.fixture'

// 1x1 transparent PNG, base64-encoded. Smallest valid image we can attach.
const TINY_PNG_BASE64 =
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

test.describe('Attached image rendering', () => {
	test('renders an <img> for an image attachment on the object detail page', async ({
		page,
		account,
	}) => {
		const object = await account.api.createObject(account.workspaceId, {
			type: 'bet',
			title: 'Bet with image attachment',
			status: 'signal',
		})

		const file = await account.api.createFile(account.workspaceId, {
			name: 'pixel.png',
			mime_type: 'image/png',
			content: TINY_PNG_BASE64,
			encoding: 'base64',
		})

		await account.api.attachFileToObject(account.workspaceId, object.id, 'bet', file.id)

		await page.goto(`/${account.workspaceId}/objects/${object.id}`)

		// The image is rendered with the original filename as alt text. Wait for
		// the data URI src to arrive (lazy-loaded via the file detail query).
		const img = page.getByRole('img', { name: 'pixel.png' })
		await expect(img).toBeVisible({ timeout: 10000 })
		const src = await img.getAttribute('src')
		expect(src).toMatch(/^data:image\/png;base64,/)
	})
})
