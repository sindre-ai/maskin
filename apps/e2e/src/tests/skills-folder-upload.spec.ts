import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

function makeSkillFolder(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'maskin-skill-'))
	const skillDir = path.join(root, 'my-e2e-skill')
	fs.mkdirSync(skillDir)
	fs.mkdirSync(path.join(skillDir, 'reference'))
	fs.writeFileSync(
		path.join(skillDir, 'SKILL.md'),
		'---\nname: my-e2e-skill\ndescription: Uploaded via folder picker\n---\n\nBody.\n',
	)
	fs.writeFileSync(path.join(skillDir, 'reference', 'style.md'), 'reference content')
	return skillDir
}

test.describe('Settings > Skills — folder upload', () => {
	// Skill uploads persist through agentStorage (S3/SeaweedFS), which isn't
	// provisioned in the verify-e2e CI job — same constraint documented on
	// attached-image-render.spec.ts's createFile-based test.
	test.skip(!!process.env.CI, 'S3/SeaweedFS not available in CI')

	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`"Import" dropdown exposes the folder option at ${viewport.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			await page.goto(`/${account.workspaceId}/settings/skills`)

			// Empty state renders the action twice (header + empty-state body) —
			// `.first()` avoids a strict-mode violation, same pattern as the
			// Integrations settings spec.
			const importButton = page.getByRole('button', { name: 'Import' }).first()
			await expect(importButton).toBeVisible({ timeout: 10000 })
			await importButton.click()

			await expect(page.getByRole('menuitem', { name: 'From file' })).toBeVisible()
			await expect(page.getByRole('menuitem', { name: 'From folder' })).toBeVisible()
			await page.keyboard.press('Escape')
		})
	}

	test('selecting a folder zips it client-side and lands a folder skill', async ({
		page,
		account,
	}) => {
		const skillDir = makeSkillFolder()

		await page.goto(`/${account.workspaceId}/settings/skills`)
		await expect(page.getByRole('button', { name: 'Import' }).first()).toBeVisible({
			timeout: 10000,
		})

		// Playwright supports handing a real directory path to a
		// `[webkitdirectory]` input — it reads the tree and populates each
		// File's webkitRelativePath the same way a native folder picker would.
		await page.locator('input[webkitdirectory]').setInputFiles(skillDir)

		const row = page.getByText('my-e2e-skill')
		await expect(row).toBeVisible({ timeout: 10000 })
		await expect(page.getByText('2 files')).toBeVisible()

		// Expand the row to confirm both bundled files made it through the
		// client-side zip and the server's upload/extract round trip.
		await row.click()
		await expect(page.getByText('SKILL.md')).toBeVisible()
		await expect(page.getByText('reference/style.md')).toBeVisible()
	})
})
