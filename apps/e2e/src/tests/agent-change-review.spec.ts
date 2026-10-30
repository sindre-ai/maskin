import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// Bet "Humans accept, edit or reject an agent's proposed changes": the banner and
// review view behind the agent-change-review flag. Like markdown-file-editor.spec.ts
// the file bytes live in S3/SeaweedFS, so this runs against a dev stack with real
// storage. Accept and reject are covered by the unit tests until the decide
// endpoints land on the bet branch.

// Changes land in blocks 2 and 4. The block on each side of a change is context, so
// the last block is the one run of untouched blocks.
const TEXT = [
	'# Launch plan',
	'',
	'We will ship the new onboarding next week.',
	'',
	'Owners are still being decided.',
	'',
	'Budget is capped at ten thousand euros.',
	'',
	'Questions go to the project channel.',
	'',
	'Notes are kept in the shared folder.',
	'',
].join('\n')

const CHANGES = [
	{
		old_text: 'We will ship the new onboarding next week.',
		new_text: 'We will ship the new onboarding on Monday.',
		reason: 'Give a real date',
	},
	{ old_text: 'ten thousand euros', new_text: '10,000 EUR', reason: 'Use numerals' },
]

test.describe('Agent change review in the file viewer', () => {
	test.beforeEach(async ({ page }) => {
		await page.addInitScript(() => {
			localStorage.setItem('ff:rich-markdown-editor', 'on')
			localStorage.setItem('ff:agent-change-review', 'on')
		})
	})

	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`banner opens the review view with a card per change at ${viewport.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			const file = await account.api.createFile(account.workspaceId, {
				name: 'plan.md',
				mime_type: 'text/markdown',
				content: TEXT,
				encoding: 'utf8',
			})
			await account.api.createFileProposal(account.workspaceId, file.id, CHANGES)

			await page.goto(`/${account.workspaceId}/files/${file.id}`)
			await expect(page.getByText(/proposed 2 changes to this text\./)).toBeVisible({
				timeout: 10000,
			})
			await expect(page.locator('.ProseMirror')).toBeVisible()

			await page.getByRole('button', { name: 'Review changes' }).click()
			await expect(page.locator('.ProseMirror')).toHaveCount(0)
			await expect(page.getByRole('region', { name: 'Change 1' })).toBeVisible()
			await expect(page.getByRole('region', { name: 'Change 2' })).toBeVisible()
			await expect(page.getByText('1 unchanged block')).toBeVisible()

			await page.getByRole('button', { name: 'Edit' }).first().click()
			await page.getByRole('textbox', { name: 'Edit change 1' }).fill('We ship on Tuesday.')
			await expect(page.getByText('Your edit will be applied.')).toBeVisible()
			await page.getByRole('textbox', { name: 'Edit change 1' }).press('Escape')
			await expect(page.getByRole('textbox', { name: 'Edit change 1' })).toHaveCount(0)
			await expect(page.getByRole('region', { name: 'Change 1' })).toBeVisible()
		})
	}

	test('with the flag off the file viewer shows no banner', async ({ page, account }) => {
		await page.addInitScript(() => localStorage.setItem('ff:agent-change-review', 'off'))
		const file = await account.api.createFile(account.workspaceId, {
			name: 'plan.md',
			mime_type: 'text/markdown',
			content: TEXT,
			encoding: 'utf8',
		})
		await account.api.createFileProposal(account.workspaceId, file.id, CHANGES)

		await page.goto(`/${account.workspaceId}/files/${file.id}`)
		await expect(page.locator('.ProseMirror')).toBeVisible({ timeout: 10000 })
		await expect(page.getByRole('button', { name: 'Review changes' })).toHaveCount(0)
	})
})
