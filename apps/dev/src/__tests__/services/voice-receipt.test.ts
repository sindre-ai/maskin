import type { Database } from '@maskin/db'
import { tools } from '@maskin/mcp'
import { describe, expect, it } from 'vitest'
import {
	type ReceiptRow,
	VOICE_SUMMARY_MAX_CHARS,
	buildReceiptNumbers,
	describeToolCall,
	notDoneDraft,
	numbersInWords,
	targetIdsOf,
} from '../../services/voice-receipt'

const A = '6cae4b5d-ce70-4254-9f91-8d3a0e24b775'
const B = '7dbf5c6e-df81-4365-8fa2-9e4b1f35c886'
const WORKSPACE = 'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f'

function fakeDb(rows: Array<{ id: string; title: string; type: string }>) {
	return {
		select: () => ({ from: () => ({ where: async () => rows }) }),
	} as unknown as Database
}

const describe_ = (
	rows: Array<{ id: string; title: string; type: string }>,
	tool: string,
	args: unknown,
	opts: { resultText?: string; startCards?: never } = {},
) =>
	describeToolCall({
		db: fakeDb(rows),
		workspaceId: WORKSPACE,
		tool,
		args,
		resultText: opts.resultText ?? null,
		state: { startCards: opts.startCards ?? null },
	})

const row = (over: Partial<ReceiptRow>): ReceiptRow => ({
	id: 1,
	event: 'other',
	outcome: 'ran',
	text: '',
	objectId: null,
	objectType: null,
	objectTitle: null,
	tool: null,
	held: false,
	yesCount: null,
	readBackMatches: null,
	cardId: null,
	more: 0,
	...over,
})

describe('targetIdsOf', () => {
	it('collects ids from the usual argument names, once each, in lower case', () => {
		expect(
			targetIdsOf({
				object_id: A.toUpperCase(),
				entity_id: A,
				updates: [{ id: B }, { id: 'not-a-uuid' }],
				ids: [B],
			}),
		).toEqual([A, B])
	})

	it('returns nothing for arguments that point at nothing', () => {
		expect(targetIdsOf(null)).toEqual([])
		expect(targetIdsOf({ q: 'loops' })).toEqual([])
	})
})

describe('describeToolCall', () => {
	it('maps create_objects to created_bet and created_task, with the new id from the result', async () => {
		// The arguments and the result are the real shapes: nodes in, { nodes, edges } out.
		const args = {
			workspace_id: WORKSPACE,
			nodes: [
				{ $id: 'n1', type: 'bet', status: 'signal', title: 'Live receipts' },
				{ $id: 'n2', type: 'task', status: 'todo', title: 'Reply to Anna' },
				{ $id: 'n3', type: 'insight', status: 'new', title: 'A gap' },
			],
		}
		expect(tools.create_objects.inputSchema.safeParse(args).success).toBe(true)
		const drafts = await describe_([], 'create_objects', args, {
			resultText: JSON.stringify({
				// Returned out of order on purpose: ids are matched on $id.
				nodes: [
					{ id: B, $id: 'n2', type: 'task', title: 'Reply to Anna' },
					{ id: A, $id: 'n1', type: 'bet', title: 'Live receipts' },
				],
				edges: [],
			}),
		})
		expect(drafts.map((d) => [d.event, d.objectType, d.objectTitle, d.objectId])).toEqual([
			['created_bet', 'bet', 'Live receipts', A],
			['created_task', 'task', 'Reply to Anna', B],
			['other', 'insight', 'A gap', null],
		])
		expect(drafts[0]?.template).toBe('Created bet {title}')
	})

	it('gives every object of a call a line, up to what create_objects takes', async () => {
		const nodes = Array.from({ length: 50 }, (_, i) => ({
			$id: `n${i}`,
			type: 'task',
			status: 'todo',
			title: `T${i}`,
		}))
		expect(await describe_([], 'create_objects', { nodes })).toHaveLength(50)
	})

	it('ends a very big update with one line that says how many more there were', async () => {
		const updates = Array.from({ length: 53 }, () => ({ id: A, content: 'x' }))
		const drafts = await describe_([], 'update_objects', { updates })
		expect(drafts).toHaveLength(51)
		expect(drafts[50]).toMatchObject({ template: 'Another 3 changes', more: 3 })
	})

	it('marks the one item that failed inside an update that otherwise ran', async () => {
		const args = {
			updates: [
				{ id: A, status: 'in_review' },
				{ id: B, status: 'nope' },
			],
		}
		expect(tools.update_objects.inputSchema.safeParse(args).success).toBe(true)
		const drafts = await describe_(
			[
				{ id: A, title: 'Reply to Anna', type: 'task' },
				{ id: B, title: 'Live receipts', type: 'bet' },
			],
			'update_objects',
			args,
			{
				resultText: JSON.stringify({
					results: [
						{ type: 'object', id: A, success: true, result: {} },
						{ type: 'object', id: B, success: false, error: 'Error: status is not allowed' },
					],
					setup: {},
				}),
			},
		)
		expect(drafts[0]?.outcome).toBeUndefined()
		expect(drafts[1]).toMatchObject({ outcome: 'failed', reason: 'Error: status is not allowed' })
	})

	it('maps a task moved to in_review to moved_to_review, and other updates to other', async () => {
		const drafts = await describe_(
			[
				{ id: A, title: 'Reply to Anna', type: 'task' },
				{ id: B, title: 'Live receipts', type: 'bet' },
			],
			'update_objects',
			{
				updates: [
					{ id: A, status: 'in_review' },
					{ id: B, status: 'in_review' },
					{ id: A, content: 'new' },
				],
			},
		)
		expect(drafts.map((d) => [d.event, d.template, d.objectTitle])).toEqual([
			['moved_to_review', 'Moved task {title} to review', 'Reply to Anna'],
			['other', 'Set {title} to in review', 'Live receipts'],
			['other', 'Edited {title}', 'Reply to Anna'],
		])
	})

	it('maps get_objects to opened_task only for one task', async () => {
		const rows = [
			{ id: A, title: 'Reply to Anna', type: 'task' },
			{ id: B, title: 'Live receipts', type: 'bet' },
		]
		expect((await describe_(rows, 'get_objects', { ids: [A] }))[0]).toMatchObject({
			event: 'opened_task',
			objectId: A,
		})
		expect(await describe_(rows, 'get_objects', { ids: [A, B] })).toEqual([])
		expect(await describe_(rows, 'get_objects', { ids: [B] })).toEqual([])
	})

	it('maps a comment on a decision card to decided, and any other comment to other', async () => {
		const rows = [{ id: A, title: 'Pricing call', type: 'task' }]
		const startCards = [{ objectId: A, notificationId: null, source: 'decision', rank: 1 }] as never
		expect(
			(await describe_(rows, 'create_comment', { entity_id: A }, { startCards }))[0],
		).toMatchObject({
			event: 'decided',
			template: 'Answered {title}',
		})
		expect((await describe_(rows, 'create_comment', { entity_id: A }))[0]).toMatchObject({
			event: 'other',
			template: 'Commented on {title}',
		})
	})

	it('names any other write by its tool, and by its target when it has one', async () => {
		expect((await describe_([], 'create_trigger', { name: 'x' }))[0]).toMatchObject({
			event: 'other',
			template: 'Ran create trigger',
		})
		expect(
			(
				await describe_([{ id: A, title: 'Reply', type: 'task' }], 'gmail_send_email', {
					object_id: A,
				})
			)[0],
		).toMatchObject({
			event: 'other',
			template: 'Ran gmail send email on {title}',
			objectTitle: 'Reply',
		})
	})

	it('builds a not-done line from a hold summary only', () => {
		expect(notDoneDraft('Send this email')).toMatchObject({
			event: 'other',
			objectId: null,
			template: 'Send this email',
		})
	})
})

describe('receipt numbers', () => {
	const state = (over: Record<string, unknown>) =>
		({
			startCards: null,
			firstCardNamed: null,
			pendingHold: null,
			inflight: new Set(),
			...over,
		}) as never

	it('writes unknown for the card numbers when the call lost its memory', () => {
		const n = buildReceiptNumbers([], undefined, 'user_hangup')
		expect(n).toMatchObject({
			rank_1_card_at_start: 'unknown',
			first_card_named: 'unknown',
			first_card_is_rank_1: null,
			cards_cleared: 0,
			sends: [],
			end_reason: 'user_hangup',
		})
	})

	it('compares the first card named with the top card', () => {
		const cards = [
			{ objectId: A, notificationId: null, source: 'curated', rank: 1 },
			{ objectId: B, notificationId: null, source: 'curated', rank: 2 },
		]
		expect(
			buildReceiptNumbers([], state({ startCards: cards, firstCardNamed: A }), 'user_hangup'),
		).toMatchObject({
			rank_1_card_at_start: A,
			first_card_named: A,
			first_card_is_rank_1: true,
		})
		expect(
			buildReceiptNumbers([], state({ startCards: cards, firstCardNamed: B }), 'user_hangup'),
		).toMatchObject({
			first_card_is_rank_1: false,
		})
		expect(buildReceiptNumbers([], state({ startCards: cards }), 'user_hangup')).toMatchObject({
			first_card_named: 'none',
			first_card_is_rank_1: null,
		})
	})

	it('counts distinct cards cleared by actions that ran', () => {
		const rows = [
			row({ cardId: A }),
			row({ cardId: A }),
			row({ cardId: B, outcome: 'failed' }),
			row({ cardId: null }),
		]
		expect(buildReceiptNumbers(rows, state({ startCards: [] }), 'user_hangup').cards_cleared).toBe(
			1,
		)
	})

	it('lists each send with its yes count and read-back', () => {
		const rows = [
			row({ held: true, tool: 'gmail_send_email', yesCount: 1, readBackMatches: true }),
			row({ held: true, tool: 'gmail_send_email', yesCount: 2, readBackMatches: true }),
			row({ held: true, tool: 'create_session', outcome: 'not_done', yesCount: 0 }),
			row({ held: false, tool: 'update_objects' }),
		]
		const n = buildReceiptNumbers(rows, undefined, 'network_error')
		expect(n.sends).toEqual([
			{ tool: 'gmail_send_email', outcome: 'ran', read_back_matches: true, yes_count: 1 },
			{ tool: 'gmail_send_email', outcome: 'ran', read_back_matches: true, yes_count: 2 },
			{ tool: 'create_session', outcome: 'not_done', read_back_matches: null, yes_count: 0 },
		])
		const words = numbersInWords(n)
		expect(words).toContain('Send 1: read-back matched, 1 yes.')
		expect(words).toContain('Send 2: read-back matched, 2 yeses.')
		expect(words).toContain('Send 3: no preview to compare, 0 yeses, not sent.')
		expect(words).toContain('Call ended by socket drop.')
	})

	it('holds ids and counts only, never an object title or a line of text', () => {
		const rows = [
			row({
				held: true,
				tool: 'gmail_send_email',
				yesCount: 1,
				readBackMatches: true,
				objectTitle: 'Confidential pricing draft',
				text: 'Ran gmail send email on "Confidential pricing draft"',
				cardId: A,
			}),
		]
		const n = buildReceiptNumbers(rows, undefined, 'user_hangup')
		expect(JSON.stringify(n)).not.toContain('Confidential')
		expect(numbersInWords(n)).not.toContain('Confidential')
	})

	it('keeps the size limit above what a summary can need', () => {
		expect(VOICE_SUMMARY_MAX_CHARS).toBe(2_000)
	})
})
