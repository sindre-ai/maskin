import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// Object-detail hero — verifies the identity row above the <h1> renders only
// TypeBadge + driver (OwnerSelect) at each ship-gate viewport (375 / 768 /
// 1024). Status and the bet-status chip were moved to the properties
// sidebar and must NOT render in this row.

const HEADER_TITLE = 'T2 header reorder'

test.describe('Object detail — above-title identity row', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`renders TypeBadge + driver above <h1>, without status controls at ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })

			const bet = await account.api.createObject(account.workspaceId, {
				type: 'bet',
				title: HEADER_TITLE,
				status: 'active',
			})

			await page.goto(`/${account.workspaceId}/objects/${bet.id}`)
			const title = page.getByPlaceholder('Untitled')
			await expect(title).toHaveValue(HEADER_TITLE, { timeout: 15000 })

			const identityRow = page.getByTestId('object-identity-row')
			await expect(identityRow).toBeVisible()

			// DOM order: the identity row must appear before the <textarea> title.
			const order = await page.evaluate(() => {
				const row = document.querySelector('[data-testid="object-identity-row"]')
				const textarea = document.querySelector('textarea')
				if (!row || !textarea) return null
				const relation = row.compareDocumentPosition(textarea)
				return {
					rowBeforeTitle: (relation & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
				}
			})
			expect(order?.rowBeforeTitle).toBe(true)

			// Fold check: the <h1> textarea must still be inside the viewport
			// at this ship-gate viewport.
			const titleBox = await title.boundingBox()
			expect(titleBox).not.toBeNull()
			if (titleBox) {
				expect(titleBox.y + titleBox.height).toBeLessThanOrEqual(vp.height)
			}

			// TypeBadge + driver (OwnerSelect) — the only two elements the
			// identity row should show.
			await expect(identityRow.getByText('bet', { exact: true })).toBeVisible()
			await expect(identityRow.getByRole('combobox').filter({ hasText: /driver/i })).toBeVisible()

			// Status / dynamic-status controls must NOT render in the identity
			// row — the driver combobox should be the only combobox present.
			await expect(identityRow.getByRole('combobox')).toHaveCount(1)
			await expect(identityRow.getByText(/^active$/i)).toHaveCount(0)

			// SubscribeToggle + creator + created/updated timestamps must not
			// render inline in the identity row either.
			await expect(identityRow.getByRole('button', { name: /subscribe/i })).toHaveCount(0)
			await expect(identityRow.locator('time')).toHaveCount(0)
		})
	}
})
