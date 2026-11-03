import { randomBytes } from 'node:crypto'
import { integrations } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { encrypt } from '../../lib/crypto'
import {
	CADENCE_MID_MS,
	CADENCE_SLOW_MS,
	CADENCE_TIGHT_MS,
	type PollFn,
	type ResendDomainGetResponse,
	ResendDomainVerifier,
	type ResendIntegrationConfig,
} from '../../services/resend-domain-verifier'
import { insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

const TEST_ENCRYPTION_KEY = randomBytes(32).toString('hex')
let originalEncryptionKey: string | undefined

beforeAll(() => {
	originalEncryptionKey = process.env.INTEGRATION_ENCRYPTION_KEY
	process.env.INTEGRATION_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY
})

afterAll(() => {
	if (originalEncryptionKey === undefined) {
		Reflect.deleteProperty(process.env, 'INTEGRATION_ENCRYPTION_KEY')
	} else {
		process.env.INTEGRATION_ENCRYPTION_KEY = originalEncryptionKey
	}
})

afterEach(() => {
	vi.restoreAllMocks()
})

interface LogEntry {
	level: 'info' | 'warn' | 'error' | 'debug'
	msg: string
	ctx: Record<string, unknown> | undefined
}

function buildLoggerCapture() {
	const entries: LogEntry[] = []
	const capture = (level: LogEntry['level']) => (msg: string, ctx?: Record<string, unknown>) => {
		entries.push({ level, msg, ctx })
	}
	const logger = {
		debug: capture('debug'),
		info: capture('info'),
		warn: capture('warn'),
		error: capture('error'),
	}
	return { entries, logger }
}

async function seedResendRow(args: {
	workspaceId: string
	accessToken?: string
	resendDomainId?: string
	createdAtMinutesAgo: number
	lastPolledAt?: Date | null
	verificationStatus?: 'pending' | 'verified' | 'failed'
	integrationStatus?: 'awaiting_secret' | 'active'
	dnsRecords?: ResendIntegrationConfig['resend'] extends infer T
		? T extends { dns_records?: infer R }
			? R
			: never
		: never
	capabilities?: { sending?: string; receiving?: string }
}) {
	const domainId = args.resendDomainId ?? `dom_${randomBytes(6).toString('hex')}`
	const createdAt = new Date(Date.now() - args.createdAtMinutesAgo * 60 * 1000)
	const config: ResendIntegrationConfig = {
		system_actor_id: getTestActorId(),
		resend: {
			receive_subdomain: 'send.example.com',
			resend_domain_id: domainId,
			verification_status: args.verificationStatus ?? 'pending',
			verification_error: null,
			last_polled_at:
				args.lastPolledAt === undefined ? null : (args.lastPolledAt?.toISOString() ?? null),
			webhook_url: 'https://x.example.com/api/webhooks/resend/token',
			dns_records: args.dnsRecords ?? [
				{
					record: 'SPF',
					type: 'TXT',
					name: 'send.example.com',
					value: 'v=spf1 include:_spf.resend.com ~all',
					status: 'pending',
				},
				{
					record: 'DKIM',
					type: 'TXT',
					name: 'resend._domainkey.send.example.com',
					value: 'p=MIGf...',
					status: 'pending',
				},
				{
					record: 'MX',
					type: 'MX',
					name: 'send.example.com',
					value: 'feedback-smtp.us-east-1.amazonses.com',
					priority: 10,
					status: 'pending',
				},
			],
			capabilities: args.capabilities ?? { sending: 'pending', receiving: 'pending' },
		},
	}
	const [row] = await db
		.insert(integrations)
		.values({
			workspaceId: args.workspaceId,
			provider: 'resend',
			status: args.integrationStatus ?? 'awaiting_secret',
			externalId: `resend-${randomBytes(6).toString('hex')}`,
			credentials: encrypt(
				JSON.stringify({ accessToken: args.accessToken ?? `re_${randomBytes(8).toString('hex')}` }),
			),
			config,
			createdBy: getTestActorId(),
			createdAt,
			updatedAt: createdAt,
		})
		.returning()
	return { row, domainId, createdAt }
}

async function readConfig(id: string): Promise<ResendIntegrationConfig> {
	const [row] = await db
		.select({ config: integrations.config })
		.from(integrations)
		.where(eq(integrations.id, id))
	return (row.config as ResendIntegrationConfig) ?? {}
}

async function truncateIntegrations() {
	await db.delete(integrations)
}

describe('ResendDomainVerifier — cadence + status transitions (real Postgres)', () => {
	let workspaceId: string

	beforeEach(async () => {
		await truncateIntegrations()
		const ws = await insertWorkspace(db, getTestActorId())
		workspaceId = ws.id
	})

	it('polls a fresh pending row on the first tick and stamps last_polled_at', async () => {
		const { row, domainId } = await seedResendRow({
			workspaceId,
			createdAtMinutesAgo: 0,
			lastPolledAt: null,
		})
		const poll: PollFn = vi.fn(async () => ({
			kind: 'ok',
			body: {
				id: domainId,
				status: 'pending',
				records: [],
				capabilities: { sending: 'pending', receiving: 'pending' },
			},
		}))
		const { entries, logger } = buildLoggerCapture()
		const verifier = new ResendDomainVerifier(db, { poll, logger })

		await verifier.tick()

		expect(poll).toHaveBeenCalledTimes(1)
		expect(poll).toHaveBeenCalledWith(domainId, expect.stringMatching(/^re_/))
		const cfg = await readConfig(row.id)
		expect(cfg.resend?.last_polled_at).toBeTruthy()
		expect(cfg.resend?.verification_status).toBe('pending')
		expect(entries.find((e) => e.msg === 'resend.domain.poll')).toBeDefined()
	})

	it('respects the 15s cadence in the first 5 minutes', async () => {
		const now = new Date()
		const { row, domainId } = await seedResendRow({
			workspaceId,
			createdAtMinutesAgo: 1, // age = 1 min, cadence 15s
			lastPolledAt: new Date(now.getTime() - 5_000), // 5s ago — inside cadence window
		})
		const poll: PollFn = vi.fn(async () => ({
			kind: 'ok',
			body: { id: domainId, status: 'pending' },
		}))
		const verifier = new ResendDomainVerifier(db, { poll })
		await verifier.tick()
		expect(poll).toHaveBeenCalledTimes(0)

		// Now bump last_polled_at back to 20s ago — should poll.
		await db
			.update(integrations)
			.set({
				config: {
					...((await readConfig(row.id)) as object),
					resend: {
						...((await readConfig(row.id)).resend ?? {}),
						last_polled_at: new Date(now.getTime() - 20_000).toISOString(),
					},
				},
			})
			.where(eq(integrations.id, row.id))

		await verifier.tick()
		expect(poll).toHaveBeenCalledTimes(1)
	})

	it('respects the 60s cadence at 5-20 minutes and the 120s cadence at 20-30 minutes', async () => {
		const now = new Date()
		// Row A: age 10 min, polled 45s ago → NOT eligible (60s cadence).
		const rowA = await seedResendRow({
			workspaceId,
			createdAtMinutesAgo: 10,
			lastPolledAt: new Date(now.getTime() - 45_000),
		})
		// Row B: age 25 min, polled 60s ago → NOT eligible (120s cadence).
		const rowB = await seedResendRow({
			workspaceId,
			createdAtMinutesAgo: 25,
			lastPolledAt: new Date(now.getTime() - 60_000),
		})
		// Row C: age 10 min, polled 90s ago → eligible under 60s cadence.
		const rowC = await seedResendRow({
			workspaceId,
			createdAtMinutesAgo: 10,
			lastPolledAt: new Date(now.getTime() - 90_000),
		})
		// Row D: age 25 min, polled 150s ago → eligible under 120s cadence.
		const rowD = await seedResendRow({
			workspaceId,
			createdAtMinutesAgo: 25,
			lastPolledAt: new Date(now.getTime() - 150_000),
		})

		const polledDomains: string[] = []
		const poll: PollFn = vi.fn(async (id: string) => {
			polledDomains.push(id)
			return { kind: 'ok', body: { id, status: 'pending' } }
		})
		const { entries, logger } = buildLoggerCapture()
		const verifier = new ResendDomainVerifier(db, { poll, logger })
		await verifier.tick()

		expect(polledDomains.sort()).toEqual([rowC.domainId, rowD.domainId].sort())
		const cadences = entries
			.filter((e) => e.msg === 'resend.domain.poll')
			.map((e) => (e.ctx as { cadence_ms: number }).cadence_ms)
			.sort()
		expect(cadences).toEqual([CADENCE_MID_MS, CADENCE_SLOW_MS].sort())
		// Sanity: sizes match constants.
		expect(CADENCE_TIGHT_MS).toBe(15_000)
	})

	it('flips to failed+timeout at 30 minutes and stops polling', async () => {
		const { row } = await seedResendRow({
			workspaceId,
			createdAtMinutesAgo: 31,
			lastPolledAt: null,
		})
		const poll: PollFn = vi.fn(async () => ({
			kind: 'ok',
			body: { id: 'x', status: 'pending' },
		}))
		const { entries, logger } = buildLoggerCapture()
		const verifier = new ResendDomainVerifier(db, { poll, logger })
		await verifier.tick()

		expect(poll).toHaveBeenCalledTimes(0)
		const cfg = await readConfig(row.id)
		expect(cfg.resend?.verification_status).toBe('failed')
		expect(cfg.resend?.verification_error).toBe('timeout')
		expect(entries.find((e) => e.msg === 'resend.domain.poll.timeout')).toBeDefined()

		// A second tick must not re-write or re-log — the WHERE-pending filter
		// stops picking up the row.
		await verifier.tick()
		expect(entries.filter((e) => e.msg === 'resend.domain.poll.timeout')).toHaveLength(1)
	})

	// Regression: /complete flips the row to 'active' before DNS verifies, and the
	// verifier used to select only 'awaiting_secret', so such rows froze at pending.
	it('flips an active row to verified when DNS verifies after /complete', async () => {
		// Row was completed (status active) while DNS was still pending.
		const { row, domainId, createdAt } = await seedResendRow({
			workspaceId,
			integrationStatus: 'active',
			createdAtMinutesAgo: 2,
			lastPolledAt: null,
		})
		const responses: ResendDomainGetResponse[] = [
			{
				id: domainId,
				status: 'pending',
				capabilities: { sending: 'pending', receiving: 'pending' },
			},
			{
				id: domainId,
				status: 'verified',
				capabilities: { sending: 'verified', receiving: 'verified' },
			},
		]
		let call = 0
		const poll: PollFn = vi.fn(async () => ({ kind: 'ok', body: responses[call++] }))
		let clock = new Date(createdAt.getTime() + 2 * 60 * 1000)
		const { entries, logger } = buildLoggerCapture()
		const verifier = new ResendDomainVerifier(db, { poll, logger, now: () => clock })

		await verifier.tick()
		expect((await readConfig(row.id)).resend?.verification_status).toBe('pending')

		// Advance past the 60s cadence band; DNS has now verified.
		clock = new Date(clock.getTime() + 2 * 60 * 1000)
		await verifier.tick()

		expect(poll).toHaveBeenCalledTimes(2)
		const cfg = await readConfig(row.id)
		expect(cfg.resend?.verification_status).toBe('verified')
		expect(cfg.resend?.capabilities).toEqual({ sending: 'verified', receiving: 'verified' })
		const [stored] = await db
			.select({ status: integrations.status })
			.from(integrations)
			.where(eq(integrations.id, row.id))
		expect(stored.status).toBe('active')
		expect(entries.find((e) => e.msg === 'resend.domain.verified')).toBeDefined()
	})

	it('flips an active row that stays pending past 30 minutes to failed+timeout', async () => {
		const { row } = await seedResendRow({
			workspaceId,
			integrationStatus: 'active',
			createdAtMinutesAgo: 31,
			lastPolledAt: null,
		})
		const poll: PollFn = vi.fn(async () => ({
			kind: 'ok',
			body: { id: 'x', status: 'pending' },
		}))
		const { entries, logger } = buildLoggerCapture()
		const verifier = new ResendDomainVerifier(db, { poll, logger })

		await verifier.tick()

		expect(poll).toHaveBeenCalledTimes(0)
		const cfg = await readConfig(row.id)
		expect(cfg.resend?.verification_status).toBe('failed')
		expect(cfg.resend?.verification_error).toBe('timeout')
		expect(entries.find((e) => e.msg === 'resend.domain.poll.timeout')).toBeDefined()
	})

	it('marks the row failed with domain_not_found on a 404 and stops polling', async () => {
		const { row, domainId } = await seedResendRow({
			workspaceId,
			createdAtMinutesAgo: 2,
			lastPolledAt: null,
		})
		const poll: PollFn = vi.fn(async () => ({ kind: 'not_found' }))
		const { entries, logger } = buildLoggerCapture()
		const verifier = new ResendDomainVerifier(db, { poll, logger })

		await verifier.tick()

		expect(poll).toHaveBeenCalledTimes(1)
		const cfg = await readConfig(row.id)
		expect(cfg.resend?.verification_status).toBe('failed')
		expect(cfg.resend?.verification_error).toBe('domain_not_found')
		expect(cfg.resend?.last_polled_at).toBeTruthy()
		const logged = entries.filter((e) => e.msg === 'resend.domain.poll.not_found')
		expect(logged).toHaveLength(1)
		expect((logged[0].ctx as { resend_domain_id: string }).resend_domain_id).toBe(domainId)

		// Terminal: the WHERE-pending filter no longer picks the row up.
		await verifier.tick()
		expect(poll).toHaveBeenCalledTimes(1)
	})

	it('writes per-record statuses + capabilities on partial verify and top-level verified on full verify', async () => {
		const { row, domainId } = await seedResendRow({
			workspaceId,
			createdAtMinutesAgo: 2,
			lastPolledAt: null,
		})
		const partial: ResendDomainGetResponse = {
			id: domainId,
			status: 'pending',
			records: [
				{
					record: 'SPF',
					type: 'TXT',
					name: 'send.example.com',
					value: 'v=spf1...',
					status: 'verified',
				},
				{
					record: 'DKIM',
					type: 'TXT',
					name: 'resend._domainkey.send.example.com',
					value: 'p=...',
					status: 'verified',
				},
				{
					record: 'MX',
					type: 'MX',
					name: 'send.example.com',
					value: 'feedback-smtp...',
					priority: 10,
					status: 'pending',
				},
			],
			capabilities: { sending: 'verified', receiving: 'pending' },
		}
		const responses: ResendDomainGetResponse[] = [
			partial,
			{
				...partial,
				status: 'verified',
				records: partial.records?.map((r) => ({ ...r, status: 'verified' as const })),
				capabilities: { sending: 'verified', receiving: 'verified' },
			},
		]
		let call = 0
		const poll: PollFn = async (id: string) => ({ kind: 'ok', body: { ...responses[call++], id } })

		const { entries, logger } = buildLoggerCapture()
		const verifier = new ResendDomainVerifier(db, { poll, logger })

		await verifier.tick()
		const partialCfg = await readConfig(row.id)
		expect(partialCfg.resend?.verification_status).toBe('pending')
		expect(partialCfg.resend?.dns_records?.find((r) => r.record === 'SPF')?.status).toBe('verified')
		expect(partialCfg.resend?.dns_records?.find((r) => r.record === 'DKIM')?.status).toBe(
			'verified',
		)
		expect(partialCfg.resend?.dns_records?.find((r) => r.record === 'MX')?.status).toBe('pending')
		expect(partialCfg.resend?.capabilities).toEqual({ sending: 'verified', receiving: 'pending' })
		expect(entries.filter((e) => e.msg === 'resend.domain.verified')).toHaveLength(0)

		// Second tick: bump last_polled_at back so cadence lets us poll again.
		await db
			.update(integrations)
			.set({
				config: {
					...((await readConfig(row.id)) as object),
					resend: {
						...(await readConfig(row.id)).resend,
						last_polled_at: new Date(Date.now() - 60_000).toISOString(),
					},
				},
			})
			.where(eq(integrations.id, row.id))

		await verifier.tick()
		const finalCfg = await readConfig(row.id)
		expect(finalCfg.resend?.verification_status).toBe('verified')
		expect(finalCfg.resend?.verification_error).toBeNull()
		expect(entries.find((e) => e.msg === 'resend.domain.verified')?.ctx?.workspace_id).toBe(
			workspaceId,
		)
	})

	it('logs auth_failed at WARN on 401 without crashing the tick, then continues to sibling rows', async () => {
		// Two rows: A returns 401, B returns 2xx. Both fresh → both eligible.
		const a = await seedResendRow({ workspaceId, createdAtMinutesAgo: 0, lastPolledAt: null })
		const b = await seedResendRow({ workspaceId, createdAtMinutesAgo: 0, lastPolledAt: null })
		const poll: PollFn = async (id: string) => {
			if (id === a.domainId) return { kind: 'auth_failed' }
			return { kind: 'ok', body: { id, status: 'pending' } }
		}
		const { entries, logger } = buildLoggerCapture()
		const verifier = new ResendDomainVerifier(db, { poll, logger })
		await verifier.tick()

		const warns = entries.filter((e) => e.msg === 'resend.domain.poll.auth_failed')
		expect(warns).toHaveLength(1)
		expect((warns[0].ctx as { integration_id: string }).integration_id).toBe(a.row.id)

		const aCfg = await readConfig(a.row.id)
		expect(aCfg.resend?.last_polled_at).toBeNull()
		const bCfg = await readConfig(b.row.id)
		expect(bCfg.resend?.last_polled_at).toBeTruthy()
	})

	it('logs retry at WARN on 5xx/429 without writing config or immediately retrying', async () => {
		const { row, domainId } = await seedResendRow({
			workspaceId,
			createdAtMinutesAgo: 0,
			lastPolledAt: null,
		})
		let calls = 0
		const poll: PollFn = async () => {
			calls++
			return { kind: 'retry', statusOrErr: '503' }
		}
		const { entries, logger } = buildLoggerCapture()
		const verifier = new ResendDomainVerifier(db, { poll, logger })

		await verifier.tick()
		expect(calls).toBe(1)
		const retries = entries.filter((e) => e.msg === 'resend.domain.poll.retry')
		expect(retries).toHaveLength(1)
		expect((retries[0].ctx as { resend_domain_id: string }).resend_domain_id).toBe(domainId)
		const cfg = await readConfig(row.id)
		expect(cfg.resend?.last_polled_at).toBeNull()
	})

	it('is idempotent under restart — a second bootstrap does not re-write already-verified rows', async () => {
		const seed = await seedResendRow({ workspaceId, createdAtMinutesAgo: 2, lastPolledAt: null })
		const poll: PollFn = async (id: string) => ({
			kind: 'ok',
			body: {
				id,
				status: 'verified',
				records: [],
				capabilities: { sending: 'verified', receiving: 'verified' },
			},
		})
		const first = buildLoggerCapture()
		let verifier = new ResendDomainVerifier(db, { poll, logger: first.logger })
		await verifier.tick()
		expect(first.entries.filter((e) => e.msg === 'resend.domain.verified')).toHaveLength(1)

		// Restart: fresh verifier, fresh log capture. Should scan, find the row
		// no longer at verification_status='pending', and emit nothing.
		const second = buildLoggerCapture()
		verifier = new ResendDomainVerifier(db, { poll, logger: second.logger })
		await verifier.tick()
		expect(second.entries).toHaveLength(0)

		const cfg = await readConfig(seed.row.id)
		expect(cfg.resend?.verification_status).toBe('verified')
	})
})
