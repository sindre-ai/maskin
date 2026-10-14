import { expect, test } from '../fixtures/auth.fixture'
import { createTestActor } from '../helpers/api.helper'
import { clearSentEmails, waitForInviteLink } from '../helpers/mock-resend.helper'
import { grantPlanHeadroom } from '../helpers/plan.helper'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

/**
 * Email invite, sub-branch 2: the invitee already has a Maskin account but is
 * signed out.
 *
 * Inviting an email that already belongs to an actor links them straight away
 * and sends no mail, so this path only arises when the account is created
 * AFTER the invite went out. The accept page can't tell the two apart up
 * front (the preview would leak whether an account exists), so it opens on
 * sign-up and flips to sign-in when accept answers 409.
 */

const INVITEE_PASSWORD = 'invitee-password-123'

for (const viewport of SHIP_GATE_VIEWPORTS) {
	test(`an invitee who already has an account signs in from the email link and joins at ${viewport.label}`, async ({
		page,
		browser,
		account,
	}) => {
		// Two browser contexts, a signup and several cold route loads: past the 30s default.
		test.slow()
		await grantPlanHeadroom(account.apiKey, account.workspaceId)
		await clearSentEmails()
		const inviteeEmail = `existing-${Date.now()}-${Math.floor(Math.random() * 1e6)}@test.com`

		await page.setViewportSize({ width: viewport.width, height: viewport.height })
		await page.goto(`/${account.workspaceId}/settings/members`)
		await page.getByRole('button', { name: /Add member/ }).click()
		await page.getByRole('menuitem', { name: 'Invite member' }).click()
		await page.getByRole('dialog').getByLabel('Email address').fill(inviteeEmail)
		await page.getByRole('dialog').getByRole('button', { name: 'Send invite' }).click()
		await expect(page.getByText(`Invite sent to ${inviteeEmail}.`)).toBeVisible()
		const acceptUrl = await waitForInviteLink(inviteeEmail)

		// The invitee signs up on their own before opening the link.
		const invitee = await createTestActor({
			name: 'Existing Invitee',
			email: inviteeEmail,
			password: INVITEE_PASSWORD,
		})

		const inviteeContext = await browser.newContext({
			viewport: { width: viewport.width, height: viewport.height },
		})
		const inviteePage = await inviteeContext.newPage()
		await inviteePage.goto(acceptUrl)

		// Opens on sign-up; submitting it finds the account and flips to sign-in.
		await inviteePage.getByLabel('Password').fill(INVITEE_PASSWORD)
		await inviteePage.getByRole('button', { name: 'Create account & join' }).click()
		await expect(inviteePage.getByRole('heading', { name: 'Sign in to accept' })).toBeVisible()
		await expect(inviteePage.getByText(/You already have a Maskin account/)).toBeVisible()
		await expect(inviteePage.getByLabel('Email')).toHaveValue(inviteeEmail)

		await inviteePage.getByLabel('Password').fill(INVITEE_PASSWORD)
		await inviteePage.getByRole('button', { name: 'Sign in & join workspace' }).click()

		await expect(inviteePage).toHaveURL(new RegExp(`/${account.workspaceId}`), { timeout: 15000 })
		const members = await account.api.listWorkspaceMembers(account.workspaceId)
		expect(members).toContainEqual(expect.objectContaining({ actorId: invitee.id, role: 'member' }))

		await inviteeContext.close()
	})
}
