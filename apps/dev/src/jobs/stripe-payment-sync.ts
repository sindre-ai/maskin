import { randomUUID } from 'node:crypto'
import type { Database } from '@maskin/db'
import { integrations, objects } from '@maskin/db/schema'
import { Cron } from 'croner'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { getCredential } from '../lib/integrations/lookup'
import { logger } from '../lib/logger'
import { recordReading } from '../lib/readings'
import {
	type StripePayment,
	checkStripeKeyAccess,
	listCompletedCheckouts,
	listPaidInvoices,
} from '../lib/stripe-payments'

/**
 * Writes a payment reading on the person who paid. No model in the path.
 *
 * Every half hour it lists the paid invoices and completed checkouts in our own Stripe account
 * since its last run. A payment whose customer email is exactly the email on one person gets a
 * `stripe.paid` reading on that person: the amount in minor units as the value, the currency in
 * the detail. The match is on the full address (compared without case), never on the domain: a
 * gmail.com payment must not win every lead who uses gmail.com.
 *
 * A payment with no person, or with an email that two people share, writes no `stripe.paid`
 * reading. It adds one `stripe.unmatched` reading on the configured loop instead (value 1, the
 * reason and the amount in the detail, never the email), so the count of payments nobody could
 * be told apart on is a number a person can look at.
 *
 * Idempotent by Stripe's own id (in_... or cs_...): the readings table refuses a second row with
 * the same subject, measure, source and source reference, so a repeat run, an overlapping window
 * or a restart adds nothing. A payment that fails to record is logged and left for the next run.
 *
 * First step of every run: the key is read through the Keychain's own choke point
 * (getCredential) as `actorId`, so the grant check and the audit row apply, and it is tried on
 * invoices and checkout sessions. If it cannot read them the run stops there and says why, once
 * until the key works again. Off unless the workspace, actor and loop are configured.
 */
const CRON_EXPRESSION = '*/30 * * * *'
/** Overlap kept behind the point everything is known to be recorded, for late-settling payments. */
const WATERMARK_OVERLAP_MS = 24 * 60 * 60 * 1000
const EMAIL_CHUNK = 200

export const PAID_MEASURE = 'stripe.paid'
export const UNMATCHED_MEASURE = 'stripe.unmatched'
const SOURCE = 'stripe'

export interface StripePaymentSyncConfig {
	workspaceId: string
	/** Agent that holds the Keychain grant for the Stripe key. */
	actorId: string
	/** Loop the count of unmatched payments is written on. */
	loopId: string
	/** Display name of the Stripe key in the Keychain. */
	keyName: string
	/** Earliest payment to read. Older ones are ignored. */
	backfillFrom: Date
}

export interface StripePaymentSyncDeps {
	/** The Stripe key, or null (logged) when it cannot be had. */
	readKey: (db: Database, config: StripePaymentSyncConfig) => Promise<string | null>
	checkKeyAccess: typeof checkStripeKeyAccess
	listPaidInvoices: typeof listPaidInvoices
	listCompletedCheckouts: typeof listCompletedCheckouts
	now: () => Date
}

async function readKey(db: Database, config: StripePaymentSyncConfig): Promise<string | null> {
	const { workspaceId, actorId, keyName } = config
	const [row] = await db
		.select({ id: integrations.id })
		.from(integrations)
		.where(
			and(
				eq(integrations.workspaceId, workspaceId),
				eq(integrations.providerMode, 'byo_apikey'),
				eq(integrations.displayName, keyName),
				eq(integrations.status, 'active'),
			),
		)
		.limit(1)
	if (!row) return null
	const credential = await getCredential(db, workspaceId, row.id, {
		requestingActorId: actorId,
		outboundTarget: 'api.stripe.com',
		requestId: `stripe-payment-sync:${randomUUID()}`,
	})
	return credential.value
}

const defaultDeps: StripePaymentSyncDeps = {
	readKey,
	checkKeyAccess: checkStripeKeyAccess,
	listPaidInvoices,
	listCompletedCheckouts,
	now: () => new Date(),
}

/** Same form on both sides of the match: trimmed and lowercase. The whole address, nothing less. */
export function normalizeEmail(email: string): string {
	return email.trim().toLowerCase()
}

export class StripePaymentSyncJob {
	private job: Cron | null = null
	private running = false
	/** Payments paid before this are all recorded. In memory: a restart rescans from backfillFrom. */
	private completeThrough: Date
	/** The last reason the run stopped at its first step, so a repeating reason is logged once. */
	private lastStop: string | null = null

	constructor(
		private db: Database,
		private config: StripePaymentSyncConfig,
		private deps: StripePaymentSyncDeps = defaultDeps,
		private cronExpression: string = CRON_EXPRESSION,
	) {
		this.completeThrough = config.backfillFrom
	}

	start(): void {
		if (this.job) return
		this.job = new Cron(this.cronExpression, { timezone: 'UTC' }, async () => {
			await this.tick()
		})
	}

	stop(): void {
		if (this.job) {
			this.job.stop()
			this.job = null
		}
	}

	/** Returns the number of new `stripe.paid` readings written. Never throws. */
	async tick(): Promise<number> {
		if (this.running) return 0
		this.running = true
		try {
			const tickStart = this.deps.now()
			const apiKey = await this.deps.readKey(this.db, this.config)
			if (!apiKey) {
				this.stopRun(
					`No active Keychain key named "${this.config.keyName}" that this agent was granted. Add it, or grant the agent, and the next run will pick it up.`,
				)
				return 0
			}
			const refused = await this.deps.checkKeyAccess(apiKey)
			if (refused) {
				this.stopRun(refused)
				return 0
			}
			this.lastStop = null

			const since = new Date(
				Math.max(this.config.backfillFrom.getTime(), this.completeThrough.getTime()),
			)
			const payments = [
				...(await this.deps.listPaidInvoices(apiKey, since)),
				...(await this.deps.listCompletedCheckouts(apiKey, since)),
			]
			const people = await this.findPeople(payments)

			let paid = 0
			let alreadyRecorded = 0
			let unmatched = 0
			let failed = 0
			for (const payment of payments) {
				try {
					const matches = payment.email ? (people.get(normalizeEmail(payment.email)) ?? []) : []
					const [only] = matches
					if (matches.length === 1 && only) {
						const { inserted } = await recordReading(this.db, {
							workspaceId: this.config.workspaceId,
							subjectId: only,
							measure: PAID_MEASURE,
							value: payment.amount,
							readAt: payment.paidAt,
							source: SOURCE,
							sourceRef: payment.id,
							detail: { currency: payment.currency, kind: payment.kind },
						})
						if (inserted) paid++
						else alreadyRecorded++
					} else {
						const reason = !payment.email
							? 'no_email'
							: matches.length === 0
								? 'no_person'
								: 'several_people'
						const { inserted } = await recordReading(this.db, {
							workspaceId: this.config.workspaceId,
							subjectId: this.config.loopId,
							measure: UNMATCHED_MEASURE,
							value: 1,
							readAt: payment.paidAt,
							source: SOURCE,
							sourceRef: payment.id,
							detail: {
								reason,
								currency: payment.currency,
								amount: payment.amount,
								kind: payment.kind,
							},
						})
						if (inserted) unmatched++
						else alreadyRecorded++
					}
				} catch (err) {
					failed++
					logger.error('Stripe payment not recorded; will retry on the next run', {
						paymentId: payment.id,
						error: String(err),
					})
				}
			}
			if (failed === 0) {
				this.completeThrough = new Date(tickStart.getTime() - WATERMARK_OVERLAP_MS)
			}
			if (paid > 0 || unmatched > 0 || failed > 0) {
				logger.info('Stripe payment sync tick', {
					listed: payments.length,
					paid,
					unmatched,
					alreadyRecorded,
					failed,
				})
			}
			return paid
		} catch (err) {
			logger.error('Stripe payment sync tick failed', {
				error: String(err),
				code: (err as { code?: unknown }).code ?? null,
			})
			return 0
		} finally {
			this.running = false
		}
	}

	/** Log why the run cannot go on, once until the reason changes or the key works again. */
	private stopRun(reason: string): void {
		if (this.lastStop === reason) return
		this.lastStop = reason
		logger.error(`Stripe payment sync stopped: ${reason}`, { keyName: this.config.keyName })
	}

	/**
	 * The people whose stored email is exactly one of these payments' emails, as a map from the
	 * normalised email to the ids of the people who hold it.
	 */
	private async findPeople(payments: StripePayment[]): Promise<Map<string, string[]>> {
		const wanted = Array.from(
			new Set(payments.flatMap((p) => (p.email ? [normalizeEmail(p.email)] : []))),
		)
		const out = new Map<string, string[]>()
		const emailOf = sql<string>`lower(btrim(${objects.metadata}->>'email'))`
		for (let i = 0; i < wanted.length; i += EMAIL_CHUNK) {
			const chunk = wanted.slice(i, i + EMAIL_CHUNK)
			const rows = await this.db
				.select({ id: objects.id, email: emailOf })
				.from(objects)
				.where(
					and(
						eq(objects.workspaceId, this.config.workspaceId),
						eq(objects.type, 'contact'),
						inArray(emailOf, chunk),
					),
				)
			for (const { id, email } of rows) out.set(email, [...(out.get(email) ?? []), id])
		}
		return out
	}
}
