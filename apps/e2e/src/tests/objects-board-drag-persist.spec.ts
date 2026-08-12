import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// T3 (Board view + drag-persist) — the bet's observable success and headline
// acceptance criterion: "a card drags to another column and the status change
// survives a reload." The component unit tests drive dnd-kit's onDragEnd with
// a mount and assert the bulk-update fires; this spec proves the write lands
// in the real stack and re-renders on the persisted column after a page reload,
// at every ship-gate viewport.
test.describe('Objects board drag-persist', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`dragging a card across columns survives a reload @ ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })

			// Board is only reachable for a single type with configured statuses,
			// so make it deterministic: two bet statuses, one card in the first.
			await account.api.updateWorkspace(account.workspaceId, {
				settings: {
					statuses: { bet: ['todo', 'done'] },
				},
			})
			await account.api.createObject(account.workspaceId, {
				type: 'bet',
				title: 'Drag Persist Card',
				status: 'todo',
			})

			await page.goto(`/${account.workspaceId}/objects?type=bet`)

			// Wait for the List to settle, then switch to Board via the Display menu.
			await expect(page.getByText('Drag Persist Card')).toBeVisible({ timeout: 10_000 })
			await page.getByRole('button', { name: /display/i }).click()
			await page.getByRole('button', { name: 'Board', exact: true }).click()

			// The card starts in the "todo" column.
			const board = page.getByTestId('board-view')
			await expect(board).toBeVisible({ timeout: 10_000 })
			const todoColumn = page.getByTestId('board-column-todo')
			const doneColumn = page.getByTestId('board-column-done')
			await expect(todoColumn.getByText('Drag Persist Card')).toBeVisible()

			// Drag the card onto the empty "done" column.
			await page.getByText('Drag Persist Card').dragTo(doneColumn)

			// The status change lands optimistically and the card re-renders under
			// "done" while disappearing from "todo".
			await expect(doneColumn.getByText('Drag Persist Card')).toBeVisible({ timeout: 10_000 })
			await expect(todoColumn.getByText('Drag Persist Card')).not.toBeVisible()

			// Reload the page and come back to the board: the write must have
			// persisted to the backend, not just lived in component state.
			await page.reload()
			await expect(page.getByText('Drag Persist Card')).toBeVisible({ timeout: 10_000 })
			await page.getByRole('button', { name: /display/i }).click()
			await page.getByRole('button', { name: 'Board', exact: true }).click()
			await expect(board).toBeVisible({ timeout: 10_000 })

			await expect(doneColumn.getByText('Drag Persist Card')).toBeVisible({ timeout: 10_000 })
			await expect(todoColumn.getByText('Drag Persist Card')).not.toBeVisible()
		})
	}
})
