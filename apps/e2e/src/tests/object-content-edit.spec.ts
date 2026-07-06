import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

test.describe('Object content contentEditable formatting', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`formatting stays visible while editing and round-trips on save @ ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })

			const obj = await account.api.createObject(account.workspaceId, {
				type: 'bet',
				title: `Content edit probe ${vp.label}`,
				status: 'signal',
				content: 'Some **bold** text',
			})

			await page.goto(`/${account.workspaceId}/objects/${obj.id}`)
			await expect(page.getByText(obj.title)).toBeVisible({ timeout: 10_000 })

			const contentArea = page.getByText('bold', { exact: true })
			await expect(contentArea).toBeVisible()

			// Click into the content to enter edit mode.
			await contentArea.click()
			const editable = page.locator('[contenteditable="true"]')
			await expect(editable).toBeVisible()

			// Formatting must stay visible while editing, not collapse to raw markdown.
			await expect(editable.locator('strong')).toHaveText('bold')
			await expect(editable).not.toContainText('**')

			// Type more text at the end, then blur to save.
			await editable.click()
			await page.keyboard.press('End')
			await page.keyboard.type(' and more')
			await page.getByText(obj.title).click()

			await page.reload()
			await expect(page.getByText(obj.title)).toBeVisible({ timeout: 10_000 })

			// The addition persisted and the original formatting still renders correctly.
			await expect(page.getByText(/and more/)).toBeVisible({ timeout: 10_000 })
			const savedStrong = page.locator('strong', { hasText: 'bold' })
			await expect(savedStrong).toBeVisible()
		})
	}

	test('pressing Enter inserts a line break that persists after reload', async ({
		page,
		account,
	}) => {
		const obj = await account.api.createObject(account.workspaceId, {
			type: 'bet',
			title: 'Content edit line break probe',
			status: 'signal',
			content: 'line one',
		})

		await page.goto(`/${account.workspaceId}/objects/${obj.id}`)
		await expect(page.getByText(obj.title)).toBeVisible({ timeout: 10_000 })

		await page.getByText('line one', { exact: true }).click()
		const editable = page.locator('[contenteditable="true"]')
		await expect(editable).toBeVisible()

		await page.keyboard.press('End')
		await page.keyboard.press('Enter')
		// Regression guard: document.execCommand('insertLineBreak') inserts two
		// <br> elements per Enter press in real Chrome (a trailing-<br>-needs-a-
		// companion quirk) — the component must never use it for Enter, always
		// going through the manual, deterministic insertion instead.
		await expect(editable.locator('br')).toHaveCount(1)
		await page.keyboard.type('line two')
		await page.getByText(obj.title).click()

		await page.reload()
		await expect(page.getByText(obj.title)).toBeVisible({ timeout: 10_000 })
		await expect(page.getByText('line one', { exact: false })).toBeVisible()
		await expect(page.getByText('line two', { exact: false })).toBeVisible()
	})

	test('typing raw markdown syntax from scratch converts live and round-trips on save', async ({
		page,
		account,
	}) => {
		const obj = await account.api.createObject(account.workspaceId, {
			type: 'bet',
			title: 'Content edit typed-markdown probe',
			status: 'signal',
		})

		await page.goto(`/${account.workspaceId}/objects/${obj.id}`)
		await expect(page.getByText(obj.title)).toBeVisible({ timeout: 10_000 })

		await page.getByPlaceholder('Click to add content...').click()
		const editable = page.locator('[contenteditable="true"]')
		await expect(editable).toBeVisible()

		// Typed one character at a time (Playwright dispatches real keydown/input
		// events), matching exactly how the user found the original bug: raw
		// markdown syntax typed from scratch must convert live, not sit as inert
		// escaped text until save.
		await page.keyboard.type('# Heading')
		await expect(editable.locator('h1')).toHaveText('Heading')
		await expect(editable).not.toContainText('#')

		await page.keyboard.press('End')
		await page.keyboard.press('Enter')
		await page.keyboard.type('and some **bold** text')
		await expect(editable.locator('strong')).toHaveText('bold')
		await expect(editable).not.toContainText('**')

		await page.getByText(obj.title).click()
		await page.reload()
		await expect(page.getByText(obj.title)).toBeVisible({ timeout: 10_000 })

		await expect(page.locator('h1', { hasText: 'Heading' })).toBeVisible({ timeout: 10_000 })
		await expect(page.locator('strong', { hasText: 'bold' })).toBeVisible()
		await expect(page.getByText('and some')).toBeVisible()
	})
})
