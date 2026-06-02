import { expect, test } from '../fixtures/auth.fixture'

// A 1x1 transparent PNG, base64-encoded. Keeps the test self-contained — no
// fixture file needed, and the bytes are valid PNG so the server accepts them.
const PNG_1X1_BASE64 =
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgAAIAAAUAAarVyFEAAAAASUVORK5CYII='

test.describe('Attached image rendering', () => {
	test('renders an inline <img> for an attached image on the object detail page', async ({
		page,
		account,
	}) => {
		const obj = await account.api.createObject(account.workspaceId, {
			type: 'bet',
			title: 'Bet with image attachment',
			status: 'signal',
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
		await expect(page.getByText('Bet with image attachment')).toBeVisible({ timeout: 10000 })

		// The AttachedFileCard fetches the file detail and renders an <img> with
		// a data: URI for safe image MIME types. The bet's regression-detection
		// contract is that the <img> actually shows up after attachment.
		const img = page.getByRole('img', { name: 'pixel.png' })
		await expect(img).toBeVisible({ timeout: 10000 })
		await expect(img).toHaveAttribute('src', /^data:image\/png;base64,/)
	})
})
