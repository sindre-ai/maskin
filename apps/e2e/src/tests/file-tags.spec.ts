import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// A person can see a file's tags, change them, and narrow the Items page's Files tab by tags,
// without asking an agent.

test.describe('File tags', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`filter the file list by tag, all or any — ${vp.label}`, async ({ page, account }) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			const make = (name: string, tags: string[]) =>
				account.api.createFile(account.workspaceId, {
					name,
					mime_type: 'text/markdown',
					content: '# Clip',
					encoding: 'utf8',
					tags,
				})
			await make('clip-both.md', ['b-roll', 'interview'])
			await make('clip-broll.md', ['b-roll'])
			await make('clip-plain.md', [])

			await page.goto(`/${account.workspaceId}/objects?type=file`)
			await expect(page.getByRole('link', { name: /clip-plain\.md/ })).toBeVisible({
				timeout: 10000,
			})

			await page.getByRole('button', { name: 'Filter by tag' }).click()
			// Existing tags are offered A to Z with their file counts.
			await expect(page.getByRole('checkbox')).toHaveCount(2)
			await page.getByRole('checkbox', { name: /^b-roll/ }).click()
			await page.getByRole('checkbox', { name: /^interview/ }).click()
			// Below 768px the picker is a modal sheet that hides the list; close it to read the list.
			await page.keyboard.press('Escape')

			// "Has all of these" is the default: only the file with both tags.
			await expect(page.getByRole('link', { name: /clip-both\.md/ })).toBeVisible()
			await expect(page.getByRole('link', { name: /clip-broll\.md/ })).toHaveCount(0)
			await expect(page.getByRole('link', { name: /clip-plain\.md/ })).toHaveCount(0)

			await page.getByRole('button', { name: 'Filter by tag' }).click()
			await page.getByRole('radio', { name: 'Has any of these' }).click()
			await page.keyboard.press('Escape')
			await expect(page.getByRole('link', { name: /clip-broll\.md/ })).toBeVisible()
			await expect(page.getByRole('link', { name: /clip-plain\.md/ })).toHaveCount(0)

			const overflow = await page.evaluate(
				() => document.documentElement.scrollWidth > document.documentElement.clientWidth,
			)
			expect(overflow).toBe(false)
		})

		test(`rename a tag and merge another into it — ${vp.label}`, async ({ page, account }) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			const make = (name: string, tags: string[]) =>
				account.api.createFile(account.workspaceId, {
					name,
					mime_type: 'text/markdown',
					content: '# Clip',
					encoding: 'utf8',
					tags,
				})
			const one = await make('one.md', ['broll', 'raw'])
			const two = await make('two.md', ['b-roll', 'broll'])
			const three = await make('three.md', ['raw'])

			await page.goto(`/${account.workspaceId}/objects?type=file`)
			await expect(page.getByRole('link', { name: /three\.md/ })).toBeVisible({ timeout: 10000 })

			// Rename "raw" to "footage".
			await page.getByRole('button', { name: 'Filter by tag' }).click()
			await page.getByRole('button', { name: 'Edit tag raw' }).click()
			await page.getByRole('textbox', { name: 'New name' }).fill('  Footage ')
			await page.getByRole('button', { name: 'Rename', exact: true }).click()
			await expect(page.getByText('Renamed to "footage" on 2 files.')).toBeVisible()
			await expect
				.poll(async () => (await account.api.getFile(account.workspaceId, one.id)).tags)
				.toEqual(['broll', 'footage'])
			expect((await account.api.getFile(account.workspaceId, three.id)).tags).toEqual(['footage'])

			// Merge "broll" into "b-roll": the file that had both keeps one copy.
			await page.getByRole('button', { name: 'Filter by tag' }).click()
			await page.getByRole('button', { name: 'Edit tag broll' }).click()
			await page.getByRole('combobox', { name: 'Merge into' }).click()
			await page.getByRole('option', { name: 'b-roll' }).click()
			await page.getByRole('button', { name: 'Merge', exact: true }).click()
			await expect(page.getByText('Merged into "b-roll" on 2 files.')).toBeVisible()
			await expect
				.poll(async () => (await account.api.getFile(account.workspaceId, two.id)).tags)
				.toEqual(['b-roll'])
			expect((await account.api.getFile(account.workspaceId, one.id)).tags).toEqual([
				'b-roll',
				'footage',
			])

			// The tag list now has the new names only.
			await page.getByRole('button', { name: 'Filter by tag' }).click()
			await expect(page.getByRole('checkbox')).toHaveCount(2)
			await expect(page.getByRole('button', { name: 'Edit tag broll' })).toHaveCount(0)
		})

		test(`add and remove a tag on the file page — ${vp.label}`, async ({ page, account }) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			await account.api.createFile(account.workspaceId, {
				name: 'other.md',
				mime_type: 'text/markdown',
				content: '# Other',
				encoding: 'utf8',
				tags: ['interview'],
			})
			const file = await account.api.createFile(account.workspaceId, {
				name: 'tag-me.md',
				mime_type: 'text/markdown',
				content: '# Tag me',
				encoding: 'utf8',
			})

			await page.goto(`/${account.workspaceId}/files/${file.id}`)
			// A file with no tags shows no tag band.
			await expect(page.getByTestId('file-tag-chips')).toHaveCount(0)

			await page.getByRole('button', { name: 'Add tag' }).click()
			// A tag already in use is offered with its file count.
			await page.getByRole('button', { name: /^interview\s*1$/ }).click()
			await expect(page.getByTestId('file-tag-chips').getByText('interview')).toBeVisible()

			// A new tag is stored trimmed and lowercase.
			await page.getByRole('textbox', { name: 'Tag name' }).fill('  B-Roll ')
			await page.getByRole('button', { name: 'Add', exact: true }).click()
			await expect(page.getByTestId('file-tag-chips').getByText('b-roll')).toBeVisible()
			await expect
				.poll(async () => (await account.api.getFile(account.workspaceId, file.id)).tags)
				.toEqual(['interview', 'b-roll'])

			await page.keyboard.press('Escape')
			await page.getByRole('button', { name: 'Remove tag interview' }).click()
			await expect(page.getByRole('button', { name: 'Remove tag interview' })).toHaveCount(0)
			await expect
				.poll(async () => (await account.api.getFile(account.workspaceId, file.id)).tags)
				.toEqual(['b-roll'])
		})
	}
})
