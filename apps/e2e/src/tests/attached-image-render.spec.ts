import { expect, test } from '../fixtures/auth.fixture'

// A 1x1 transparent PNG, base64-encoded. Keeps the test self-contained — no
// fixture file needed, and the bytes are valid PNG so the server accepts them.
const PNG_1X1_BASE64 =
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgAAIAAAUAAarVyFEAAAAASUVORK5CYII='

test.describe('Attached image rendering', () => {
	test('lists an attached image as a file row on the object detail page', async ({
		page,
		account,
	}) => {
		// createFile requires S3/SeaweedFS — not provisioned in the verify-e2e CI job
		test.skip(!!process.env.CI, 'S3/SeaweedFS not available in CI')
		const obj = await account.api.createObject(account.workspaceId, {
			type: 'bet',
			title: 'Bet with image attachment',
			status: 'opportunity',
		})

		const file = await account.api.createFile(account.workspaceId, {
			name: 'pixel.png',
			mime_type: 'image/png',
			content: PNG_1X1_BASE64,
			encoding: 'base64',
		})

		await account.api.createRelationship(account.workspaceId, {
			source_type: 'object',
			source_id: obj.id,
			target_type: 'file',
			target_id: file.id,
			type: 'attached',
		})

		await page.goto(`/${account.workspaceId}/objects/${obj.id}`)
		await expect(page.getByRole('heading', { name: 'Bet with image attachment' })).toBeVisible({
			timeout: 10000,
		})

		// The item page lists an attached image in its Files section as a row that
		// links to the file (the inline <img> lives in chat and comments, not here).
		const row = page.getByRole('link', { name: /^pixel\.png/ })
		await expect(row).toBeVisible({ timeout: 10000 })
		await expect(row).toHaveAttribute('href', new RegExp(`/files/${file.id}$`))
	})
})
