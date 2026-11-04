import { expect, test } from '../fixtures/auth.fixture'
import { grantEnterprise } from '../helpers/plan.helper'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

const BASE = 'http://localhost:5173'

// Obviously fake values, never real credentials.
const SEEDED_KEY = 'sk-ant-fake-e2e-seed-key-1111'
const REPLACEMENT_KEY = 'sk-ant-fake-e2e-new-key-2222'

async function workspaceRow(apiKey: string, workspaceId: string) {
	const res = await fetch(`${BASE}/api/workspaces`, {
		headers: { Authorization: `Bearer ${apiKey}` },
	})
	if (!res.ok) throw new Error(`List workspaces failed: ${res.status} ${await res.text()}`)
	const rows = (await res.json()) as Array<{ id: string } & Record<string, unknown>>
	const row = rows.find((w) => w.id === workspaceId)
	if (!row) throw new Error('Workspace not in list')
	return row
}

async function saveAnthropicKey(apiKey: string, workspaceId: string, value: string | null) {
	const res = await fetch(`${BASE}/api/workspaces/${workspaceId}`, {
		method: 'PATCH',
		headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
		body: JSON.stringify({ settings: { llm_keys: { anthropic: value } } }),
	})
	if (!res.ok) throw new Error(`Save key failed: ${res.status} ${await res.text()}`)
}

test.describe('LLM API keys — settings screen', () => {
	test.describe.configure({ timeout: 60_000 })

	test('a saved key shows only its last four characters, at every ship-gate viewport', async ({
		page,
		account,
	}) => {
		await grantEnterprise(account.apiKey, account.workspaceId)
		await saveAnthropicKey(account.apiKey, account.workspaceId, SEEDED_KEY)

		await page.goto(`/${account.workspaceId}/settings/keys`)
		const saved = page.getByTestId('llm-key-saved-anthropic')
		await expect(saved).toBeVisible({ timeout: 30_000 })

		for (const vp of SHIP_GATE_VIEWPORTS) {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			await expect(saved).toBeVisible()
			await expect(saved).toContainText('ends in 1111')
			await expect(saved.getByRole('button', { name: 'Replace' })).toBeVisible()
			await expect(saved.getByRole('button', { name: 'Clear' })).toBeVisible()
		}

		// The key is nowhere in the page, not even in a hidden input.
		expect(await page.content()).not.toContain(SEEDED_KEY)
	})

	test('replacing a key saves the new one; the old one is not shown while doing it', async ({
		page,
		account,
	}) => {
		await grantEnterprise(account.apiKey, account.workspaceId)
		await saveAnthropicKey(account.apiKey, account.workspaceId, SEEDED_KEY)

		await page.goto(`/${account.workspaceId}/settings/keys`)
		const saved = page.getByTestId('llm-key-saved-anthropic')
		await expect(saved).toBeVisible({ timeout: 30_000 })

		await saved.getByRole('button', { name: 'Replace' }).click()
		const input = page.getByLabel('Anthropic API key')
		await expect(input).toHaveValue('')
		await input.fill(REPLACEMENT_KEY)
		await page.getByRole('button', { name: 'Save' }).first().click()

		await expect(page.getByTestId('llm-key-saved-anthropic')).toContainText('ends in 2222')
		expect(await page.content()).not.toContain(REPLACEMENT_KEY)
		const row = await workspaceRow(account.apiKey, account.workspaceId)
		expect(row.llm_key_hints).toMatchObject({ anthropic: '2222' })
		expect(JSON.stringify(row)).not.toContain(REPLACEMENT_KEY)
	})

	test('clearing a key removes it', async ({ page, account }) => {
		await grantEnterprise(account.apiKey, account.workspaceId)
		await saveAnthropicKey(account.apiKey, account.workspaceId, SEEDED_KEY)

		await page.goto(`/${account.workspaceId}/settings/keys`)
		const saved = page.getByTestId('llm-key-saved-anthropic')
		await expect(saved).toBeVisible({ timeout: 30_000 })

		await saved.getByRole('button', { name: 'Clear' }).click()

		await expect(page.getByTestId('llm-key-saved-anthropic')).toHaveCount(0)
		await expect(page.getByLabel('Anthropic API key')).toHaveValue('')
		const row = await workspaceRow(account.apiKey, account.workspaceId)
		expect(row.llm_configured).toMatchObject({ anthropic: false })
	})

	test('saving the custom endpoint without retyping its key keeps the key', async ({
		page,
		account,
	}) => {
		await grantEnterprise(account.apiKey, account.workspaceId)
		const seeded = await fetch(`${BASE}/api/workspaces/${account.workspaceId}`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${account.apiKey}` },
			body: JSON.stringify({
				settings: {
					custom_llm: {
						enabled: false,
						base_url: 'https://llm.example.test',
						api_key: 'fake-e2e-custom-key-3333',
						model: 'model-a',
					},
				},
			}),
		})
		expect(seeded.ok).toBe(true)

		await page.goto(`/${account.workspaceId}/settings/keys`)
		const saved = page.getByTestId('custom-llm-key-saved')
		await expect(saved).toBeVisible({ timeout: 30_000 })
		await expect(saved).toContainText('ends in 3333')

		await page.getByPlaceholder('deepseek/deepseek-v4-flash').fill('model-b')
		await page.getByRole('button', { name: 'Save' }).last().click()

		await expect(page.getByTestId('custom-llm-key-saved')).toContainText('ends in 3333')
		const row = await workspaceRow(account.apiKey, account.workspaceId)
		expect(row.llm_configured).toMatchObject({ custom_llm: true })
		expect(row.settings).toMatchObject({ custom_llm: { model: 'model-b' } })
	})
})
