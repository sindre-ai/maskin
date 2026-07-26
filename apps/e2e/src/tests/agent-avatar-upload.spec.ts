import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from '../fixtures/auth.fixture'
import { createTestActor } from '../helpers/api.helper'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// Covers T7 of Per-agent avatars in Maskin — admin drag/drop upload widget on
// the agent detail page. Loops each behaviour across the ship-gate viewports so
// the touch surface (28px+ hit area) is reachable on mobile, iPad portrait and
// iPad landscape. Runs against T5's live endpoint at POST /api/actors/:id/avatar.

const API_BASE = 'http://localhost:5173/api'

// 1×1 red PNG. Small enough that sharp downsize keeps it as a valid PNG and the
// success path can assert an <img> renders. Real bytes matter — the endpoint
// runs sharp() on the buffer and would reject arbitrary padding.
const RED_PIXEL_PNG = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP8//8/AwAI/AL+dR8HzwAAAABJRU5ErkJggg==',
	'base64',
)

function writeTempFile(name: string, bytes: Buffer): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maskin-avatar-'))
	const filePath = path.join(dir, name)
	fs.writeFileSync(filePath, bytes)
	return filePath
}

async function createAgent(apiKey: string, workspaceId: string): Promise<{ id: string }> {
	const res = await fetch(`${API_BASE}/actors`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${apiKey}`,
			'X-Workspace-Id': workspaceId,
		},
		body: JSON.stringify({
			type: 'agent',
			name: `E2E Avatar Agent ${Date.now()}`,
		}),
	})
	if (!res.ok) throw new Error(`createAgent failed: ${res.status} ${await res.text()}`)
	return res.json()
}

async function addWorkspaceMember(
	apiKey: string,
	workspaceId: string,
	actorId: string,
	role: string,
): Promise<void> {
	const res = await fetch(`${API_BASE}/workspaces/${workspaceId}/members`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify({ actor_id: actorId, role }),
	})
	if (!res.ok) throw new Error(`addWorkspaceMember failed: ${res.status} ${await res.text()}`)
}

test.describe('AgentAvatarUpload — admin upload widget on the agent page', () => {
	// The endpoint writes to S3/SeaweedFS, which isn't provisioned in the
	// verify-e2e CI job — same constraint as skills-folder-upload.spec.ts and
	// attached-image-render.spec.ts. In CI the specs skip; locally they run
	// against the pnpm-dev stack.
	test.skip(!!process.env.CI, 'S3/SeaweedFS not available in CI')

	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`admin sees the upload affordance on the agent page at ${viewport.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			const agent = await createAgent(account.apiKey, account.workspaceId)

			await page.goto(`/${account.workspaceId}/agents/${agent.id}`)

			const uploadButton = page.getByRole('button', { name: /upload avatar image/i })
			await expect(uploadButton).toBeVisible({ timeout: 15000 })
			await expect(page.getByText(/PNG or JPG, up to 2 MB/i)).toBeVisible()
		})

		test(`non-admin member sees the preview but no upload button at ${viewport.label}`, async ({
			page,
			account,
			browser,
		}) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			const agent = await createAgent(account.apiKey, account.workspaceId)

			// Second human actor invited as a plain member — admin gate should fail
			// and the widget should collapse to the avatar preview only.
			const memberActor = await createTestActor({
				name: `E2E Avatar Member ${Date.now()}`,
			})
			await addWorkspaceMember(account.apiKey, account.workspaceId, memberActor.id, 'member')

			const memberContext = await browser.newContext()
			await memberContext.addInitScript(
				(data: {
					apiKey: string
					actor: { id: string; name: string; type: string; email: string | null }
				}) => {
					localStorage.setItem('maskin-api-key', data.apiKey)
					localStorage.setItem('maskin-actor', JSON.stringify(data.actor))
				},
				{
					apiKey: memberActor.api_key,
					actor: {
						id: memberActor.id,
						name: memberActor.name,
						type: memberActor.type,
						email: memberActor.email,
					},
				},
			)
			const memberPage = await memberContext.newPage()
			await memberPage.setViewportSize({ width: viewport.width, height: viewport.height })
			await memberPage.goto(`/${account.workspaceId}/agents/${agent.id}`)

			// The document header (agent name) is the load-anchor.
			await expect(memberPage.locator('.rounded-full').first()).toBeVisible({ timeout: 15000 })
			await expect(memberPage.getByRole('button', { name: /upload avatar image/i })).toHaveCount(0)
			await memberContext.close()
		})

		test(`uploading a valid PNG refreshes the avatar image at ${viewport.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			const agent = await createAgent(account.apiKey, account.workspaceId)

			await page.goto(`/${account.workspaceId}/agents/${agent.id}`)
			await expect(page.getByRole('button', { name: /upload avatar image/i })).toBeVisible({
				timeout: 15000,
			})

			const pngPath = writeTempFile('valid.png', RED_PIXEL_PNG)
			await page.locator('input[type="file"][accept="image/png,image/jpeg"]').setInputFiles(pngPath)

			// After the upload settles the avatar element should render an <img>
			// (initials-only ActorAvatar has no <img> child).
			await expect(page.locator('.rounded-full img').first()).toBeVisible({ timeout: 20000 })
		})

		test(`uploading a >2MB PNG surfaces the 413 human-readable copy at ${viewport.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			const agent = await createAgent(account.apiKey, account.workspaceId)

			await page.goto(`/${account.workspaceId}/agents/${agent.id}`)
			await expect(page.getByRole('button', { name: /upload avatar image/i })).toBeVisible({
				timeout: 15000,
			})

			// Content-Length middleware fast-rejects at 413 before sharp runs,
			// so the bytes don't have to be a real PNG — only the size + MIME.
			const oversizedBytes = Buffer.alloc(2 * 1024 * 1024 + 1024)
			const bigPath = writeTempFile('big.png', oversizedBytes)
			await page.locator('input[type="file"][accept="image/png,image/jpeg"]').setInputFiles(bigPath)

			await expect(page.getByText(/image is too large/i)).toBeVisible({ timeout: 15000 })
		})

		test(`uploading a .txt file surfaces the client-side PNG/JPG error at ${viewport.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			const agent = await createAgent(account.apiKey, account.workspaceId)

			await page.goto(`/${account.workspaceId}/agents/${agent.id}`)
			await expect(page.getByRole('button', { name: /upload avatar image/i })).toBeVisible({
				timeout: 15000,
			})

			// The file input's `accept` attribute is a hint — Playwright will still
			// set a non-matching file, which lets the widget's MIME guard fire
			// (matches the server's 415 branch client-side).
			const txtPath = writeTempFile('notes.txt', Buffer.from('hello'))
			await page.locator('input[type="file"][accept="image/png,image/jpeg"]').setInputFiles(txtPath)

			await expect(page.getByText(/only png or jpg/i)).toBeVisible({ timeout: 15000 })
		})
	}
})
