import { expect, test } from '../fixtures/auth.fixture'
import { clearSentEmails, waitForInviteLink } from '../helpers/mock-resend.helper'
import { grantPlanHeadroom } from '../helpers/plan.helper'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

/**
 * Email invite, sub-branch 1: the invitee has no Maskin account.
 *
 * Admin sends the invite from Settings → Members, the invite mail is read back
 * from the mock Resend sink (see scripts/mock-resend.mjs), and the accept link
 * is opened in a signed-out browser context. The invitee creates an account on
 * the /invite page and ends up a member of the admin's workspace.
 */

for (const viewport of SHIP_GATE_VIEWPORTS) {
	test(`an invited stranger can sign up from the email link and join at ${viewport.label}`, async ({
		page,
		browser,
		account,
	}) => {
		// Two browser contexts, a signup and several cold route loads: past the 30s default.
		test.slow()
		// A trial workspace caps humans at one seat, so accepting would 403.
		await grantPlanHeadroom(account.apiKey, account.workspaceId)
		await clearSentEmails()
		const inviteeEmail = `invitee-${Date.now()}-${Math.floor(Math.random() * 1e6)}@test.com`

		await page.setViewportSize({ width: viewport.width, height: viewport.height })
		await page.goto(`/${account.workspaceId}/settings/members`)

		// The actor-ID input is gone; the email dialog replaces it.
		await page.getByRole('button', { name: /Add member/ }).click()
		await page.getByRole('menuitem', { name: 'Invite member' }).click()
		const dialog = page.getByRole('dialog')
		await expect(dialog.getByLabel('Email address')).toBeVisible()
		await expect(dialog.getByPlaceholder(/Actor ID/i)).toHaveCount(0)

		await dialog.getByLabel('Email address').fill(inviteeEmail)
		await dialog.getByRole('button', { name: 'Send invite' }).click()

		await expect(page.getByText(`Invite sent to ${inviteeEmail}.`)).toBeVisible()
		const pendingRow = page.getByRole('button', { name: `Resend invite to ${inviteeEmail}` })
		await expect(pendingRow).toBeVisible()
		await expect(
			page.getByRole('button', { name: `Revoke invite to ${inviteeEmail}` }),
		).toBeVisible()

		const acceptUrl = await waitForInviteLink(inviteeEmail)

		// Signed-out invitee in a clean browser context.
		const inviteeContext = await browser.newContext({
			viewport: { width: viewport.width, height: viewport.height },
		})
		const inviteePage = await inviteeContext.newPage()
		await inviteePage.goto(acceptUrl)

		await expect(
			inviteePage.getByRole('heading', { name: `Join ${account.workspaceName} on Maskin` }),
		).toBeVisible()
		const emailField = inviteePage.getByLabel('Email')
		await expect(emailField).toHaveValue(inviteeEmail)
		await expect(emailField).toBeDisabled()

		await inviteePage.getByLabel('Your name').fill('Invited Newcomer')
		await inviteePage.getByLabel('Password').fill('invitee-password-123')
		await inviteePage.getByRole('button', { name: 'Create account & join' }).click()

		await expect(inviteePage).toHaveURL(new RegExp(`/${account.workspaceId}`), { timeout: 15000 })

		const members = await account.api.listWorkspaceMembers(account.workspaceId)
		expect(members).toContainEqual(
			expect.objectContaining({ name: 'Invited Newcomer', type: 'human', role: 'member' }),
		)

		// The accepted invite is no longer pending for the admin.
		await page.reload()
		await expect(
			page.getByRole('button', { name: `Resend invite to ${inviteeEmail}` }),
		).toHaveCount(0)

		await inviteeContext.close()
	})
}

test('the accept page shows the expired message for a token that matches no invite', async ({
	browser,
}) => {
	const context = await browser.newContext()
	const page = await context.newPage()
	await page.goto('/invite?token=not-a-real-token')

	await expect(page.getByRole('heading', { name: 'This invite has expired' })).toBeVisible()
	await context.close()
})

test('a revoked invite link renders the expired message', async ({ page, browser, account }) => {
	await grantPlanHeadroom(account.apiKey, account.workspaceId)
	await clearSentEmails()
	const inviteeEmail = `revoked-${Date.now()}-${Math.floor(Math.random() * 1e6)}@test.com`

	await page.goto(`/${account.workspaceId}/settings/members`)
	await page.getByRole('button', { name: /Add member/ }).click()
	await page.getByRole('menuitem', { name: 'Invite member' }).click()
	await page.getByRole('dialog').getByLabel('Email address').fill(inviteeEmail)
	await page.getByRole('dialog').getByRole('button', { name: 'Send invite' }).click()
	const acceptUrl = await waitForInviteLink(inviteeEmail)

	await page.getByRole('button', { name: `Revoke invite to ${inviteeEmail}` }).click()
	await page.getByRole('dialog').getByRole('button', { name: 'Revoke' }).click()
	await expect(page.getByRole('button', { name: `Revoke invite to ${inviteeEmail}` })).toHaveCount(
		0,
	)

	const context = await browser.newContext()
	const inviteePage = await context.newPage()
	await inviteePage.goto(acceptUrl)
	await expect(inviteePage.getByRole('heading', { name: 'This invite has expired' })).toBeVisible()
	await expect(inviteePage.getByText(account.workspaceName)).toHaveCount(0)
	await context.close()
})
