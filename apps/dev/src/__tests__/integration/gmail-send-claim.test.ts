import { events, integrations } from '@maskin/db/schema'
import { describe, expect, it } from 'vitest'
import { encrypt } from '../../lib/crypto'
import {
	type ApprovalRef,
	approvalSendState,
	claimApprovalForSend,
	settleApprovalSend,
} from '../../lib/integrations/providers/gmail/send-claim'
import { insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

/**
 * The claim is what stops one approval sending two emails. It has to hold under real
 * concurrency, so it is tested on its own against Postgres with many callers at once: the
 * route's own pre-checks usually answer first and would hide a broken claim.
 */

async function ref(approvalCommentId = 4001): Promise<ApprovalRef> {
	const human = getTestActorId()
	const workspace = await insertWorkspace(db, human)
	const [gmail] = await db
		.insert(integrations)
		.values({
			workspaceId: workspace.id,
			provider: 'gmail',
			status: 'active',
			externalId: 'sender@example.com',
			credentials: encrypt(JSON.stringify({ accessToken: 't' })),
			createdBy: human,
		})
		.returning()
	if (!gmail) throw new Error('seed failed')
	return { workspaceId: workspace.id, integrationId: gmail.id, actorId: human, approvalCommentId }
}

describe('claimApprovalForSend', () => {
	it('gives the claim to exactly one of many simultaneous callers', async () => {
		const r = await ref()

		const results = await Promise.all(Array.from({ length: 12 }, () => claimApprovalForSend(db, r)))

		expect(results.filter(Boolean)).toHaveLength(1)
		expect(await approvalSendState(db, r)).toBe('send_claim')
	})

	it('refuses a second claim while the first is in flight', async () => {
		const r = await ref()

		expect(await claimApprovalForSend(db, r)).toBe(true)
		expect(await claimApprovalForSend(db, r)).toBe(false)
	})

	it('lets the approval be claimed again after Gmail refused it', async () => {
		const r = await ref()
		await claimApprovalForSend(db, r)

		await settleApprovalSend(db, r, 'released')

		expect(await approvalSendState(db, r)).toBe('send_released')
		expect(await claimApprovalForSend(db, r)).toBe(true)
	})

	it('keeps an approval locked when the outcome is unknown', async () => {
		const r = await ref()
		await claimApprovalForSend(db, r)

		await settleApprovalSend(db, r, 'unknown')

		expect(await approvalSendState(db, r)).toBe('send_unknown')
		expect(await claimApprovalForSend(db, r)).toBe(false)
	})

	it('keeps an approval locked once the email was sent', async () => {
		const r = await ref()
		await claimApprovalForSend(db, r)
		await db.insert(events).values({
			workspaceId: r.workspaceId,
			actorId: r.actorId,
			action: 'updated',
			entityType: 'integration',
			entityId: r.integrationId,
			data: { provider: 'gmail', gmail_action: 'sent', approval_comment_id: r.approvalCommentId },
		})

		expect(await approvalSendState(db, r)).toBe('sent')
		expect(await claimApprovalForSend(db, r)).toBe(false)
	})

	it('treats different approvals, and different workspaces, independently', async () => {
		const a = await ref(4001)
		const b = { ...a, approvalCommentId: 4002 }
		const c = await ref(4001)

		expect(await claimApprovalForSend(db, a)).toBe(true)
		expect(await claimApprovalForSend(db, b)).toBe(true)
		expect(await claimApprovalForSend(db, c)).toBe(true)
		expect(await approvalSendState(db, { ...a, approvalCommentId: 9999 })).toBeNull()
	})
})
