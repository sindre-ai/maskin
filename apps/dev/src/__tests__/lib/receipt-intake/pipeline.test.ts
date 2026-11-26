import { describe, expect, it, vi } from 'vitest'
import {
	type IntakeRow,
	type PipelineDeps,
	type ReceivedEmail,
	processCommandUpload,
	processInboundEmail,
} from '../../../lib/receipt-intake/pipeline'
import {
	RECEIPT_DAILY_CAP,
	RECEIPT_MAX_BYTES,
	RECEIPT_MAX_FILES_PER_MAIL,
	emailAddressFor,
	mintEmailToken,
} from '../../../lib/receipt-intake/policy'

// One test per condition the CTO set for the receipt routes. The pipeline is run against fakes, so
// what is proved is the order of the rules: what is read, what is saved, and above all what wakes
// an agent. An agent wakes only when saveReceipts runs (it records the one event), so "no session
// starts" is "saveReceipts and the fetches were never called".

const DOMAIN = 'receipts.example.test'
const PDF = Buffer.from('%PDF-1.4\nreceipt')
const GOOD_AUTH = { spf: 'pass', dkim: 'pass', dmarc: 'pass' }

function setup(
	opts: {
		intake?: Partial<IntakeRow> | null
		mail?: Partial<ReceivedEmail>
		claim?: boolean
		capLeft?: number
	} = {},
) {
	const token = mintEmailToken()
	const intake: IntakeRow = {
		id: 'intake-1',
		workspaceId: 'ws-1',
		loopObjectId: 'loop-1',
		createdBy: 'owner-1',
		emailEnabled: true,
		allowedSenders: [],
		ownerEmail: 'owner@firm.test',
		...opts.intake,
	}
	let slotsLeft = opts.capLeft ?? RECEIPT_DAILY_CAP
	const deps = {
		now: () => new Date('2026-11-24T10:00:00Z'),
		findIntakeByEmailToken: vi.fn(async (t: string) =>
			opts.intake === null ? null : t === token ? intake : null,
		),
		claimDelivery: vi.fn(async () => opts.claim ?? true),
		releaseDelivery: vi.fn(async () => {}),
		fetchReceivedEmail: vi.fn(
			async (): Promise<ReceivedEmail> => ({
				from: 'owner@firm.test',
				authentication: GOOD_AUTH,
				attachments: [{ id: 'att-1', filename: 'receipt.pdf', size: PDF.length }],
				...opts.mail,
			}),
		),
		downloadAttachment: vi.fn(async () => PDF),
		takeDailySlots: vi.fn(async (_i: IntakeRow, n: number) => {
			if (n > slotsLeft) return false
			slotsLeft -= n
			return true
		}),
		countHeld: vi.fn(async () => {}),
		saveReceipts: vi.fn(async (_i: IntakeRow, input: { files: unknown[] }) => input.files.length),
	} satisfies PipelineDeps
	const webhook = (over: { from?: string; to?: string[] } = {}) => ({
		emailId: 'email-1',
		from: 'Owner <owner@firm.test>',
		to: [emailAddressFor(token, DOMAIN)],
		...over,
	})
	return { deps, intake, token, webhook }
}

const run = (
	s: ReturnType<typeof setup>,
	over?: Parameters<ReturnType<typeof setup>['webhook']>[0],
) => processInboundEmail(s.deps, { domain: DOMAIN }, s.webhook(over))

describe('email route', () => {
	it('saves an attachment from the owner, with sender and day, and wakes an agent once', async () => {
		const s = setup()
		const out = await run(s)
		expect(out).toEqual({ result: 'saved', saved: 1, held: 0 })
		expect(s.deps.saveReceipts).toHaveBeenCalledTimes(1)
		const input = s.deps.saveReceipts.mock.calls[0]?.[1] as {
			source: string
			sender: string
			at: Date
		}
		expect(input.source).toBe('email')
		expect(input.sender).toBe('owner@firm.test')
		expect(input.at.toISOString()).toBe('2026-11-24T10:00:00.000Z')
	})

	it('drops mail from a stranger before anything is fetched and starts no agent', async () => {
		const s = setup()
		const out = await run(s, { from: 'Eve <eve@evil.test>' })
		expect(out).toEqual({ result: 'held', reason: 'sender_not_allowed' })
		expect(s.deps.fetchReceivedEmail).not.toHaveBeenCalled()
		expect(s.deps.downloadAttachment).not.toHaveBeenCalled()
		expect(s.deps.saveReceipts).not.toHaveBeenCalled()
		expect(s.deps.countHeld).toHaveBeenCalledWith(s.intake, 1)
	})

	it('drops a spoofed sender whose DMARC does not pass, without reading a file', async () => {
		for (const authentication of [
			{ spf: 'pass', dkim: 'pass', dmarc: 'fail' },
			{ spf: 'pass', dkim: 'pass' },
			null,
		]) {
			const s = setup({ mail: { authentication } })
			const out = await run(s)
			expect(out).toEqual({ result: 'held', reason: 'failed_sender_check' })
			expect(s.deps.downloadAttachment).not.toHaveBeenCalled()
			expect(s.deps.saveReceipts).not.toHaveBeenCalled()
			expect(s.deps.countHeld).toHaveBeenCalledWith(s.intake, 1)
		}
	})

	it('drops mail whose full record shows a different sender than the webhook', async () => {
		const s = setup({ mail: { from: 'eve@evil.test' } })
		expect(await run(s)).toEqual({ result: 'held', reason: 'failed_sender_check' })
		expect(s.deps.saveReceipts).not.toHaveBeenCalled()
	})

	it("uses the owner's list once the owner has one", async () => {
		const own = { intake: { allowedSenders: ['bookkeeper@firm.test'] } }
		const refused = setup(own)
		expect(await run(refused)).toEqual({ result: 'held', reason: 'sender_not_allowed' })
		const allowed = setup({ ...own, mail: { from: 'bookkeeper@firm.test' } })
		expect(await run(allowed, { from: 'bookkeeper@firm.test' })).toMatchObject({ result: 'saved' })
	})

	it('stops a flood at the daily cap and saves nothing past it', async () => {
		const s = setup({ capLeft: 0 })
		const out = await run(s)
		expect(out).toEqual({ result: 'held', reason: 'daily_cap' })
		expect(s.deps.downloadAttachment).not.toHaveBeenCalled()
		expect(s.deps.saveReceipts).not.toHaveBeenCalled()
	})

	it('takes the cap in one step across many mails until it is used up', async () => {
		const s = setup({ capLeft: 3 })
		const results: string[] = []
		for (let i = 0; i < 5; i++) {
			const out = await run(s)
			results.push(out.result)
		}
		expect(results).toEqual(['saved', 'saved', 'saved', 'held', 'held'])
		expect(s.deps.saveReceipts).toHaveBeenCalledTimes(3)
	})

	it('answers a switched-off address with success and reads nothing', async () => {
		const s = setup({ intake: { emailEnabled: false } })
		expect(await run(s)).toEqual({ result: 'ignored', reason: 'switched_off' })
		expect(s.deps.claimDelivery).not.toHaveBeenCalled()
		expect(s.deps.fetchReceivedEmail).not.toHaveBeenCalled()
		expect(s.deps.saveReceipts).not.toHaveBeenCalled()
	})

	it("ignores an address that is not any flow's, such as one made dead by a new address", async () => {
		const s = setup({ intake: null })
		expect(await run(s)).toEqual({ result: 'ignored', reason: 'unknown_address' })
		expect(await run(s, { to: ['someone@else.test'] })).toEqual({
			result: 'ignored',
			reason: 'unknown_address',
		})
		expect(s.deps.fetchReceivedEmail).not.toHaveBeenCalled()
	})

	it('does nothing the second time the same mail is delivered', async () => {
		const s = setup({ claim: false })
		expect(await run(s)).toEqual({ result: 'ignored', reason: 'duplicate' })
		expect(s.deps.fetchReceivedEmail).not.toHaveBeenCalled()
		expect(s.deps.saveReceipts).not.toHaveBeenCalled()
	})

	it('holds files of the wrong type or too large and saves the rest', async () => {
		const s = setup({
			mail: {
				attachments: [
					{ id: 'a', filename: 'receipt.pdf', size: PDF.length },
					{ id: 'b', filename: 'virus.exe', size: 10 },
					{ id: 'c', filename: 'huge.pdf', size: RECEIPT_MAX_BYTES + 1 },
				],
			},
		})
		s.deps.downloadAttachment.mockImplementation(async (_e: string, id: string) =>
			id === 'b' ? Buffer.from('MZ\x90\x00binary') : PDF,
		)
		const out = await run(s)
		expect(out).toEqual({ result: 'saved', saved: 1, held: 2 })
		expect(s.deps.downloadAttachment).toHaveBeenCalledTimes(2)
		expect(s.deps.countHeld).toHaveBeenCalledWith(s.intake, 2)
	})

	it('reads at most a few files from one mail', async () => {
		const attachments = Array.from({ length: RECEIPT_MAX_FILES_PER_MAIL + 3 }, (_, i) => ({
			id: `a${i}`,
			filename: `r${i}.pdf`,
			size: PDF.length,
		}))
		const s = setup({ mail: { attachments } })
		const out = await run(s)
		expect(out).toEqual({ result: 'saved', saved: RECEIPT_MAX_FILES_PER_MAIL, held: 3 })
	})

	it('does not wake an agent for mail with no attachment', async () => {
		const s = setup({ mail: { attachments: [] } })
		expect(await run(s)).toEqual({ result: 'ignored', reason: 'no_files' })
		expect(s.deps.saveReceipts).not.toHaveBeenCalled()
	})

	it('frees the claim and fails when Resend is down, so the delivery is retried', async () => {
		const s = setup()
		s.deps.fetchReceivedEmail.mockRejectedValueOnce(new Error('resend down'))
		await expect(run(s)).rejects.toThrow('resend down')
		expect(s.deps.releaseDelivery).toHaveBeenCalledTimes(1)
		expect(s.deps.saveReceipts).not.toHaveBeenCalled()
	})
})

describe('command route', () => {
	const intake = setup().intake

	it('saves one receipt as a file and wakes an agent once', async () => {
		const s = setup()
		const out = await processCommandUpload(s.deps, intake, { name: 'r.pdf', bytes: PDF })
		expect(out).toEqual({ result: 'saved', saved: 1 })
		const input = s.deps.saveReceipts.mock.calls[0]?.[1] as { source: string; sender: unknown }
		expect(input.source).toBe('command')
		expect(input.sender).toBeNull()
	})

	it('refuses the wrong type, an empty file and a file that is too large', async () => {
		const s = setup()
		expect(
			await processCommandUpload(s.deps, intake, { name: 'a.html', bytes: Buffer.from('<html>') }),
		).toEqual({ result: 'refused', reason: 'bad_type' })
		expect(
			await processCommandUpload(s.deps, intake, { name: 'a.pdf', bytes: Buffer.alloc(0) }),
		).toEqual({
			result: 'refused',
			reason: 'empty',
		})
		expect(
			await processCommandUpload(s.deps, intake, {
				name: 'a.pdf',
				bytes: Buffer.alloc(RECEIPT_MAX_BYTES + 1, 0x25),
			}),
		).toEqual({ result: 'refused', reason: 'too_large' })
		expect(s.deps.saveReceipts).not.toHaveBeenCalled()
	})

	it('shares the daily cap with email', async () => {
		const s = setup({ capLeft: 0 })
		expect(await processCommandUpload(s.deps, intake, { name: 'a.pdf', bytes: PDF })).toEqual({
			result: 'refused',
			reason: 'daily_cap',
		})
		expect(s.deps.saveReceipts).not.toHaveBeenCalled()
	})
})
