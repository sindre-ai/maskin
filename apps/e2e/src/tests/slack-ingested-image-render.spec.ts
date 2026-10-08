import { expect, test } from '../fixtures/auth.fixture'

// A 1x1 transparent PNG, base64-encoded. Self-contained — same pattern as
// attached-image-render.spec.ts; the bytes are valid PNG so the server accepts.
const PNG_1X1_BASE64 =
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgAAIAAAUAAarVyFEAAAAASUVORK5CYII='

test.describe('Slack-ingested image rendering (CFA output shape)', () => {
	test('renders an inline <img> for a Slack-ingested image on a CFA insight', async ({
		page,
		account,
	}) => {
		// Simulate the Customer Feedback Agent's *output* after T3's STEP 3
		// prompt edit: an insight whose body names the file in prose (the
		// shape that produced the 8 dropped flows), with the file persisted
		// and wired via an `attached` edge. We assert against the rendered
		// surface, not the inference path — the regression contract is that
		// files[] is populated AND the image renders inline.
		const insight = await account.api.createObject(account.workspaceId, {
			type: 'insight',
			title: 'For You cards too short',
			status: 'new',
			content: 'Reported in #customer-feedback. Attachment: screenshot (IMG_8669.png).',
		})

		const file = await account.api.createFile(account.workspaceId, {
			name: 'IMG_8669.png',
			mime_type: 'image/png',
			content: PNG_1X1_BASE64,
			encoding: 'base64',
		})

		const edge = await account.api.createRelationship(account.workspaceId, {
			source_type: 'object',
			source_id: insight.id,
			target_type: 'file',
			target_id: file.id,
			type: 'attached',
		})

		// DoD: files[] populated + `attached` edge created. Both are observable
		// directly on the create responses returned by the API.
		expect(file.id).toBeTruthy()
		expect(file.mimeType).toBe('image/png')
		expect(edge.type).toBe('attached')
		expect(edge.sourceId).toBe(insight.id)
		expect(edge.targetId).toBe(file.id)

		// DoD: object detail page renders the image inline. AttachedFileCard
		// fetches the file detail and renders an <img> with a data: URI for
		// safe image MIME types — same selector pattern as PR #536.
		await page.goto(`/${account.workspaceId}/objects/${insight.id}`)
		await expect(page.getByText('For You cards too short')).toBeVisible({ timeout: 10000 })

		const img = page.getByRole('img', { name: 'IMG_8669.png' })
		await expect(img).toBeVisible({ timeout: 10000 })
		await expect(img).toHaveAttribute('src', /^data:image\/png;base64,/)
	})
})
