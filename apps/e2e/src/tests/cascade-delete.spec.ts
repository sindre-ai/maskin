import { expect, test } from '../fixtures/auth.fixture'

test.describe('Cascade-delete bet with child tasks', () => {
	async function seedBetWithTasks(
		account: { workspaceId: string; api: import('../helpers/api.helper').TestAPI },
		options: { betTitle: string; taskTitles: string[] },
	) {
		const bet = await account.api.createObject(account.workspaceId, {
			type: 'bet',
			title: options.betTitle,
			status: 'active',
		})

		const tasks: { id: string; title: string }[] = []
		for (const title of options.taskTitles) {
			const task = await account.api.createObject(account.workspaceId, {
				type: 'task',
				title,
				status: 'todo',
			})
			await account.api.createRelationship(account.workspaceId, {
				source_type: 'bet',
				source_id: bet.id,
				target_type: 'task',
				target_id: task.id,
				type: 'breaks_into',
			})
			tasks.push({ id: task.id, title: task.title })
		}

		return { bet, tasks }
	}

	test('cascades by default — confirm wipes the bet and every child task', async ({
		page,
		account,
	}) => {
		const { bet, tasks } = await seedBetWithTasks(account, {
			betTitle: 'E2E cascade happy path',
			taskTitles: ['Cascade task one', 'Cascade task two'],
		})

		await page.goto(`/${account.workspaceId}/objects/${bet.id}`)
		await expect(page.getByText(bet.title)).toBeVisible({ timeout: 10000 })

		await page.getByRole('button', { name: 'More actions' }).click()
		await page.getByRole('menuitem', { name: /^delete$/i }).click()

		await expect(
			page.getByRole('heading', { name: /delete 'E2E cascade happy path'\?/i }),
		).toBeVisible()
		await expect(page.getByText('2 of 2 will be deleted')).toBeVisible()

		await page.getByRole('button', { name: /delete bet · 2 deleted · 0 kept/i }).click()

		await expect(page).toHaveURL(new RegExp(`/${account.workspaceId}/objects(\\?|$)`), {
			timeout: 10000,
		})

		await page.goto(`/${account.workspaceId}/objects`)
		await expect(page.getByText(bet.title)).toHaveCount(0)
		for (const task of tasks) {
			await expect(page.getByText(task.title)).toHaveCount(0)
		}
	})

	test('detach-then-delete — unchecked task survives parentless while the bet is gone', async ({
		page,
		account,
	}) => {
		const { bet, tasks } = await seedBetWithTasks(account, {
			betTitle: 'E2E detach then delete',
			taskTitles: ['Survivor task', 'Doomed task'],
		})
		const survivor = tasks[0]
		const doomed = tasks[1]

		await page.goto(`/${account.workspaceId}/objects/${bet.id}`)
		await expect(page.getByText(bet.title)).toBeVisible({ timeout: 10000 })

		await page.getByRole('button', { name: 'More actions' }).click()
		await page.getByRole('menuitem', { name: /^delete$/i }).click()

		await expect(page.getByText('2 of 2 will be deleted')).toBeVisible()
		await page.getByRole('checkbox', { name: new RegExp(survivor.title, 'i') }).click()

		await expect(page.getByText('1 of 2 will be deleted')).toBeVisible()
		await page.getByRole('button', { name: /delete bet · 1 deleted · 1 kept/i }).click()

		await expect(page).toHaveURL(new RegExp(`/${account.workspaceId}/objects(\\?|$)`), {
			timeout: 10000,
		})

		await page.goto(`/${account.workspaceId}/objects`)
		await expect(page.getByText(bet.title)).toHaveCount(0)
		await expect(page.getByText(doomed.title)).toHaveCount(0)
		await expect(page.getByText(survivor.title).first()).toBeVisible()
	})
})
