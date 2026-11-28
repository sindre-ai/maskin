import type { Database } from '@maskin/db'
import { describe, expect, it } from 'vitest'
import { checkApprovalOwner, normalizeAccount } from '../../lib/approval-owner'

const SEBASTIAN = '11111111-1111-4111-8111-111111111111'
const MAGNUS = '22222222-2222-4222-8222-222222222222'
const OTHER = '33333333-3333-4333-8333-333333333333'

/** A db whose one workspace row carries these settings. */
function dbWith(settings: unknown) {
	const chain = { from: () => chain, where: () => chain, limit: async () => [{ settings }] }
	return { select: () => chain } as unknown as Database
}

const owners = {
	approval_owners: {
		sebk_personal: [SEBASTIAN],
		magnus_personal: [MAGNUS],
		maskin_page: [SEBASTIAN, MAGNUS],
		maskin_app: [SEBASTIAN, MAGNUS],
	},
}

const check = (settings: unknown, actorId: string, metadata: unknown) =>
	checkApprovalOwner(dbWith(settings), { workspaceId: 'w', actorId, metadata })

describe('normalizeAccount', () => {
	it('treats dash and underscore, and case, as the same', () => {
		expect(normalizeAccount(' Sebk-Personal ')).toBe('sebk_personal')
	})
})

describe('checkApprovalOwner', () => {
	it('lets a workspace with no map approve anything, as before', async () => {
		expect(await check({}, OTHER, { kind: 'linkedin_post', account: 'sebk_personal' })).toEqual({
			ok: true,
		})
		expect(await check(null, OTHER, { account: 'anything' })).toEqual({ ok: true })
	})

	it('leaves an object that is not a post for an account alone', async () => {
		expect(await check(owners, OTHER, { kind: 'slack_message', channel: '#x' })).toEqual({
			ok: true,
		})
		expect(await check(owners, OTHER, null)).toEqual({ ok: true })
	})

	it('lets the owner of a personal account approve, with dash or underscore', async () => {
		expect(await check(owners, SEBASTIAN, { account: 'sebk_personal' })).toEqual({ ok: true })
		expect(await check(owners, MAGNUS, { account: 'magnus-personal' })).toEqual({ ok: true })
	})

	it('refuses the other founder on a personal account, with a plain message', async () => {
		const result = await check(owners, MAGNUS, { account: 'sebk_personal' })
		expect(result).toMatchObject({ ok: false })
		expect(result.ok === false && result.message).toContain('sebk_personal')
	})

	it('accepts either founder on the page and the app accounts, and nobody else', async () => {
		for (const account of ['maskin_page', 'maskin_app']) {
			expect(await check(owners, SEBASTIAN, { account })).toEqual({ ok: true })
			expect(await check(owners, MAGNUS, { account })).toEqual({ ok: true })
			expect(await check(owners, OTHER, { account })).toMatchObject({ ok: false })
		}
	})

	it('refuses an empty account, a missing one on a LinkedIn post, and one nobody owns', async () => {
		expect(await check(owners, SEBASTIAN, { account: '  ' })).toMatchObject({ ok: false })
		expect(await check(owners, SEBASTIAN, { kind: 'linkedin_post' })).toMatchObject({ ok: false })
		expect(
			await check(owners, SEBASTIAN, { content_type: 'linkedin_post', account: 'unknown' }),
		).toMatchObject({ ok: false })
	})

	it('ignores a malformed map instead of blocking approvals', async () => {
		expect(await check({ approval_owners: ['x'] }, OTHER, { account: 'a' })).toEqual({ ok: true })
		expect(await check({ approval_owners: {} }, OTHER, { account: 'a' })).toEqual({ ok: true })
	})
})
