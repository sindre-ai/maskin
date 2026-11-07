import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// A markdown file opens text-first: title, meta, attachment, tappable lines and
// "Ask about this file". "Edit and review" reaches the editor. Like the other
// markdown specs this needs real file storage, so it runs against a local stack.

for (const vp of SHIP_GATE_VIEWPORTS) {
	test(`markdown file opens text-first at ${vp.label}`, async ({ page, account }) => {
		await page.setViewportSize({ width: vp.width, height: vp.height })
		const obj = await account.api.createObject(account.workspaceId, {
			type: 'bet',
			title: 'Read view bet',
			status: 'opportunity',
		})
		const file = await account.api.createFile(account.workspaceId, {
			name: 'brief.md',
			mime_type: 'text/markdown',
			content: '# Brief\n\nFirst line of the brief.\n\nSecond line.\n',
			encoding: 'utf8',
		})
		await account.api.createRelationship(account.workspaceId, {
			source_type: 'object',
			source_id: obj.id,
			target_type: 'file',
			target_id: file.id,
			type: 'attached',
		})
		await page.goto(`/${account.workspaceId}/files/${file.id}`)

		await expect(page.getByRole('heading', { name: 'brief.md', level: 1 })).toBeVisible()
		await expect(page.getByText('Tap a line to pin a comment')).toBeVisible()
		await expect(page.getByRole('button', { name: 'First line of the brief.' })).toBeVisible()
		await expect(page.getByRole('link', { name: /Read view bet/ })).toBeVisible()
		await expect(page.getByRole('button', { name: 'Ask about this file' })).toBeVisible()

		await page.getByRole('button', { name: 'Edit and review' }).click()
		await expect(page.getByTestId('file-read-view')).toHaveCount(0)
	})
}
