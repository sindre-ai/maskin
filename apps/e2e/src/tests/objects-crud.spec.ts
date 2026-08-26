import { expect, test } from '../fixtures/auth.fixture'

test.describe('Objects CRUD', () => {
	test('the header New menu hands a task description to an agent', async ({ page, account }) => {
		// The overlay never structures prose itself — picking an object type and
		// sending opens a conversation with the routed agent, which holds
		// `get_workspace_schema` + `create_objects` and creates the row. So the
		// assertion is that the request lands in a chat, not that an object
		// appeared. See create-overlay.spec.ts for the full overlay contract.
		const agent = await account.api.createAgentActor(`E2E Router ${Date.now()}`)
		await account.api.addWorkspaceMember(account.workspaceId, agent.id)

		await page.goto(`/${account.workspaceId}/objects`)

		// The app-bar New button lives inside the layout, which only renders
		// once the workspace resolves. Anchor on a layout element first — on a
		// cold CI worker the first navigation can outlast the default click
		// wait while the workspace fetch is still in flight.
		await expect(page.getByRole('link', { name: 'Objects' }).first()).toBeVisible({
			timeout: 30000,
		})

		// Header "New" menu → "New task" opens the CreatePicker dialog pre-seeded
		// to the task subtype, so no type-selector step is shown.
		// The split New button's primary half runs the screen's default create
		// action directly (no menu) — the chevron half opens the full menu, so
		// that's the one that exposes "New task". The objects list toolbar has
		// its own "New" button too — scope to the global header so this
		// exercises the header's New menu specifically.
		await page.locator('header').getByRole('button', { name: 'More ways to start' }).click()
		await page.getByRole('menuitem', { name: /new task/i }).click()

		await page.getByRole('dialog').getByLabel('Title', { exact: true }).fill('E2E Test Object')

		const send = page.getByRole('button', { name: /^Send to / })
		await expect(send).toBeEnabled({ timeout: 15000 })
		await send.click()

		await expect(page).toHaveURL(new RegExp(`/${account.workspaceId}/chats/[^/]+$`), {
			timeout: 15000,
		})
		await expect(page.getByText('E2E Test Object').first()).toBeVisible({ timeout: 15000 })
	})

	test('can view an object created via API', async ({ page, account }) => {
		const obj = await account.api.createObject(account.workspaceId, {
			type: 'bet',
			title: 'API Created Bet',
			status: 'signal',
		})

		await page.goto(`/${account.workspaceId}/objects/${obj.id}`)

		await expect(page.getByRole('heading', { level: 1, name: 'API Created Bet' })).toBeVisible({
			timeout: 10000,
		})
	})

	test('renders the object title as a static heading on the rebuilt detail surface', async ({
		page,
		account,
	}) => {
		const obj = await account.api.createObject(account.workspaceId, {
			type: 'bet',
			title: 'Original Title',
			status: 'signal',
		})

		await page.goto(`/${account.workspaceId}/objects/${obj.id}`)
		await expect(page.getByRole('heading', { level: 1, name: 'Original Title' })).toBeVisible({
			timeout: 10000,
		})

		// The rebuilt surface (bet/object-detail, T1 static shell) renders the
		// title read-only — the legacy edit-in-place textarea is gone. Title
		// editing is out of scope for this surface; nothing else on the page may
		// masquerade as the title editor.
		await expect(page.getByPlaceholder('Untitled')).toHaveCount(0)
	})

	test('can delete an object', async ({ page, account }) => {
		const obj = await account.api.createObject(account.workspaceId, {
			type: 'insight',
			title: 'Object To Delete',
			status: 'new',
		})

		await page.goto(`/${account.workspaceId}/objects/${obj.id}`)
		await expect(page.getByRole('heading', { level: 1, name: 'Object To Delete' })).toBeVisible({
			timeout: 10000,
		})

		// Delete is inside the "More actions" dropdown
		await page.getByRole('button', { name: 'More actions' }).click()
		await page.getByRole('menuitem', { name: 'Delete' }).click()
		await expect(page.getByText('Delete this insight?')).toBeVisible()
		await page.getByRole('button', { name: 'Delete' }).last().click()

		// Should redirect back to workspace
		await expect(page).not.toHaveURL(/objects\//, { timeout: 10000 })
	})

	test('can open create form via the header New menu', async ({ page, account }) => {
		await page.goto(`/${account.workspaceId}/objects`)

		// Same cold-boot anchor as the create test above.
		await expect(page.getByRole('link', { name: 'Objects' }).first()).toBeVisible({
			timeout: 30000,
		})

		// The objects list toolbar has its own "New" button too — scope to the
		// global header so this exercises the header's New menu specifically.
		// See the note above: the chevron half opens the menu with "New insight".
		await page.locator('header').getByRole('button', { name: 'More ways to start' }).click()
		await page.getByRole('menuitem', { name: /new insight/i }).click()

		// Seeded with a defaultType, so the picker skips straight to the composer.
		// The placeholder is per-type, so target the stable accessible name.
		await expect(page.getByRole('dialog').getByLabel('Title', { exact: true })).toBeVisible()
	})
})
