import { logger } from '../logger'
import {
	type MailAuthentication,
	RECEIPT_DAILY_CAP,
	RECEIPT_MAX_BYTES,
	RECEIPT_MAX_FILES_PER_MAIL,
	type ReceiptType,
	authenticationPasses,
	parseAddress,
	senderAllowed,
	sniffReceiptType,
	tokenFromRecipients,
} from './policy'

// What happens to one email or one command upload, in the order the rules run. Everything that
// touches the outside (the database, Resend, storage, the event that wakes the agent) sits behind
// PipelineDeps, so each rule is tested without any of it. The order is the safety argument:
//
//   unknown or switched-off address  -> dropped at once, nothing fetched
//   sender not on the owner's list   -> held, nothing fetched
//   same mail seen before            -> ignored
//   failed sender checks (DMARC)     -> held, no file read
//   over the daily cap               -> held
//   each file: type and size         -> saved, or counted as held
//   a saved file                     -> one event, which is the only thing that wakes an agent
//
// A dropped mail records no event, so no agent session starts for it. Nothing in the mail text,
// subject or file name is passed on as instructions: a saved file carries a sanitised name and the
// event carries ids only.

export type IntakeRow = {
	id: string
	workspaceId: string
	loopObjectId: string
	createdBy: string
	emailEnabled: boolean
	allowedSenders: string[]
	/** The login email of createdBy, the default allowed sender. */
	ownerEmail: string | null
}

export type ReceivedAttachment = {
	id: string
	filename?: string
	size?: number
}

export type ReceivedEmail = {
	from?: string
	to?: string[]
	authentication?: MailAuthentication
	attachments?: ReceivedAttachment[]
}

export type ReceiptFile = {
	name: string
	bytes: Buffer
	type: ReceiptType
}

export type Source = 'email' | 'command'

export interface PipelineDeps {
	now(): Date
	findIntakeByEmailToken(token: string): Promise<IntakeRow | null>
	/** True when this email id is new for this flow; false when it was seen before. */
	claimDelivery(intake: IntakeRow, emailId: string): Promise<boolean>
	releaseDelivery(intake: IntakeRow, emailId: string): Promise<void>
	fetchReceivedEmail(emailId: string): Promise<ReceivedEmail>
	downloadAttachment(emailId: string, attachmentId: string): Promise<Buffer>
	/** Atomically take n slots of today's cap; false when that would pass it. */
	takeDailySlots(intake: IntakeRow, n: number, today: Date): Promise<boolean>
	countHeld(intake: IntakeRow, n: number): Promise<void>
	/** Store the files and record one event per file. Returns how many were saved. */
	saveReceipts(
		intake: IntakeRow,
		input: { source: Source; sender: string | null; files: ReceiptFile[]; at: Date },
	): Promise<number>
}

export type EmailOutcome =
	| { result: 'ignored'; reason: 'unknown_address' | 'switched_off' | 'duplicate' | 'no_files' }
	| { result: 'held'; reason: 'sender_not_allowed' | 'failed_sender_check' | 'daily_cap' }
	| { result: 'saved'; saved: number; held: number }

export type EmailConfig = { domain: string }

export async function processInboundEmail(
	deps: PipelineDeps,
	config: EmailConfig,
	webhook: { emailId: string; from?: string; to?: string[]; cc?: string[] },
): Promise<EmailOutcome> {
	const token = tokenFromRecipients([...(webhook.to ?? []), ...(webhook.cc ?? [])], config.domain)
	if (!token) return { result: 'ignored', reason: 'unknown_address' }
	const intake = await deps.findIntakeByEmailToken(token)
	if (!intake) return { result: 'ignored', reason: 'unknown_address' }
	// A switched-off address still answers the webhook with success and drops the mail, so the
	// sender of the webhook does not retry. Nothing is counted: nobody asked to hear about it.
	if (!intake.emailEnabled) return { result: 'ignored', reason: 'switched_off' }

	if (!senderAllowed(webhook.from, intake.allowedSenders, intake.ownerEmail)) {
		await deps.countHeld(intake, 1)
		return { result: 'held', reason: 'sender_not_allowed' }
	}

	if (!(await deps.claimDelivery(intake, webhook.emailId))) {
		return { result: 'ignored', reason: 'duplicate' }
	}

	try {
		const mail = await deps.fetchReceivedEmail(webhook.emailId)
		// The From the owner's list was checked against comes from the webhook; the full record
		// must agree with it, and must pass the sender checks. Missing results fail closed.
		if (parseAddress(mail.from) !== parseAddress(webhook.from)) {
			await deps.countHeld(intake, 1)
			return { result: 'held', reason: 'failed_sender_check' }
		}
		if (!authenticationPasses(mail.authentication)) {
			await deps.countHeld(intake, 1)
			return { result: 'held', reason: 'failed_sender_check' }
		}

		const attachments = mail.attachments ?? []
		if (attachments.length === 0) return { result: 'ignored', reason: 'no_files' }
		const wanted = attachments.slice(0, RECEIPT_MAX_FILES_PER_MAIL)
		let held = attachments.length - wanted.length

		const now = deps.now()
		if (!(await deps.takeDailySlots(intake, wanted.length, now))) {
			await deps.countHeld(intake, attachments.length)
			return { result: 'held', reason: 'daily_cap' }
		}

		const files: ReceiptFile[] = []
		for (const att of wanted) {
			// The size Resend reports is checked before the download, and the bytes after it.
			if (typeof att.size === 'number' && att.size > RECEIPT_MAX_BYTES) {
				held++
				continue
			}
			const bytes = await deps.downloadAttachment(webhook.emailId, att.id)
			const type =
				bytes.length > 0 && bytes.length <= RECEIPT_MAX_BYTES ? sniffReceiptType(bytes) : null
			if (!type) {
				held++
				continue
			}
			files.push({ name: att.filename ?? 'receipt', bytes, type })
		}

		const saved =
			files.length > 0
				? await deps.saveReceipts(intake, {
						source: 'email',
						sender: parseAddress(webhook.from),
						files,
						at: now,
					})
				: 0
		if (held > 0) await deps.countHeld(intake, held)
		return { result: 'saved', saved, held }
	} catch (err) {
		// Let the sender of the webhook try again: free the claim so the retry is not "seen before".
		await deps.releaseDelivery(intake, webhook.emailId).catch((releaseErr) => {
			logger.error('receipt_intake.release_failed', {
				intake_id: intake.id,
				error: releaseErr instanceof Error ? releaseErr.message : String(releaseErr),
			})
		})
		throw err
	}
}

export type CommandOutcome =
	| { result: 'saved'; saved: 1 }
	| { result: 'refused'; reason: 'empty' | 'too_large' | 'bad_type' | 'daily_cap' }

/** One file sent with the command. Same type, size and cap rules as email; no sender to check. */
export async function processCommandUpload(
	deps: PipelineDeps,
	intake: IntakeRow,
	file: { name: string; bytes: Buffer },
): Promise<CommandOutcome> {
	if (file.bytes.length === 0) return { result: 'refused', reason: 'empty' }
	if (file.bytes.length > RECEIPT_MAX_BYTES) return { result: 'refused', reason: 'too_large' }
	const type = sniffReceiptType(file.bytes)
	if (!type) return { result: 'refused', reason: 'bad_type' }
	const now = deps.now()
	if (!(await deps.takeDailySlots(intake, 1, now)))
		return { result: 'refused', reason: 'daily_cap' }
	await deps.saveReceipts(intake, {
		source: 'command',
		sender: null,
		files: [{ name: file.name, bytes: file.bytes, type }],
		at: now,
	})
	return { result: 'saved', saved: 1 }
}

export { RECEIPT_DAILY_CAP }
