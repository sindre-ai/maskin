import { afterEach, describe, expect, it, vi } from 'vitest'
import {
	CADENCE_MID_MS,
	CADENCE_SLOW_MS,
	CADENCE_TIGHT_MS,
	type ResendDnsRecord,
	type ResendDnsRecordConfig,
	type ResendDomainGetResponse,
	type ResendIntegrationConfig,
	buildNotFoundFieldUpdate,
	buildPollFieldUpdate,
	buildTimeoutFieldUpdate,
	defaultPoll,
	isTimedOut,
	mapTopStatus,
	mergeDnsRecords,
	selectCadenceMs,
} from '../../services/resend-domain-verifier'

describe('resend-domain-verifier — pure functions', () => {
	describe('selectCadenceMs', () => {
		it('returns 15s while age < 5min', () => {
			expect(selectCadenceMs(0)).toBe(CADENCE_TIGHT_MS)
			expect(selectCadenceMs(60_000)).toBe(CADENCE_TIGHT_MS)
			expect(selectCadenceMs(5 * 60 * 1000 - 1)).toBe(CADENCE_TIGHT_MS)
		})
		it('returns 60s while age is 5-20min', () => {
			expect(selectCadenceMs(5 * 60 * 1000)).toBe(CADENCE_MID_MS)
			expect(selectCadenceMs(15 * 60 * 1000)).toBe(CADENCE_MID_MS)
			expect(selectCadenceMs(20 * 60 * 1000 - 1)).toBe(CADENCE_MID_MS)
		})
		it('returns 120s while age is 20-30min', () => {
			expect(selectCadenceMs(20 * 60 * 1000)).toBe(CADENCE_SLOW_MS)
			expect(selectCadenceMs(29 * 60 * 1000)).toBe(CADENCE_SLOW_MS)
		})
	})

	describe('isTimedOut', () => {
		it('is false below 30 minutes', () => {
			expect(isTimedOut(29 * 60 * 1000 + 59_000)).toBe(false)
		})
		it('is true at and past 30 minutes', () => {
			expect(isTimedOut(30 * 60 * 1000)).toBe(true)
			expect(isTimedOut(60 * 60 * 1000)).toBe(true)
		})
	})

	describe('mapTopStatus', () => {
		it("maps Resend 'not_started' and 'pending' to 'pending'", () => {
			expect(mapTopStatus('not_started')).toBe('pending')
			expect(mapTopStatus('pending')).toBe('pending')
		})
		it("maps Resend 'verified' to 'verified'", () => {
			expect(mapTopStatus('verified')).toBe('verified')
		})
		it("maps Resend 'failure' to 'failed'", () => {
			expect(mapTopStatus('failure')).toBe('failed')
		})
	})

	describe('mergeDnsRecords', () => {
		const stored: ResendDnsRecordConfig[] = [
			{
				record: 'SPF',
				type: 'TXT',
				name: 'send.example.com',
				value: '"v=spf1 include:_spf.resend.com ~all"',
				status: 'pending',
			},
			{
				record: 'DKIM',
				type: 'TXT',
				name: 'resend._domainkey.send.example.com',
				value: 'p=MIGfMA0GCSq...',
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
		]

		it('copies status per-record and preserves name/value/priority from the stored row', () => {
			const incoming: ResendDnsRecord[] = [
				{ record: 'SPF', type: 'TXT', name: 'CHURN', value: 'CHURN', status: 'verified' },
				{ record: 'DKIM', type: 'TXT', name: 'CHURN', value: 'CHURN', status: 'verified' },
				{
					record: 'MX',
					type: 'MX',
					name: 'CHURN',
					value: 'CHURN',
					priority: 999,
					status: 'pending',
				},
			]
			const merged = mergeDnsRecords(stored, incoming)
			expect(merged).toEqual([
				{ ...stored[0], status: 'verified' },
				{ ...stored[1], status: 'verified' },
				{ ...stored[2], status: 'pending' },
			])
		})

		it('keeps the stored status when Resend does not report on a record', () => {
			const merged = mergeDnsRecords(stored, [
				{ record: 'SPF', type: 'TXT', name: 'x', value: 'x', status: 'verified' },
			])
			expect(merged.find((r) => r.record === 'MX')?.status).toBe('pending')
			expect(merged.find((r) => r.record === 'SPF')?.status).toBe('verified')
		})

		it('falls back to Resend when the stored blob is missing', () => {
			const incoming: ResendDnsRecord[] = [
				{ record: 'SPF', type: 'TXT', name: 'a', value: 'b', status: 'verified' },
			]
			expect(mergeDnsRecords(undefined, incoming)).toEqual([
				{
					record: 'SPF',
					type: 'TXT',
					name: 'a',
					value: 'b',
					priority: undefined,
					status: 'verified',
				},
			])
		})
	})

	describe('buildPollFieldUpdate', () => {
		const stored: ResendIntegrationConfig = {
			system_actor_id: 'actor-1',
			resend: {
				receive_subdomain: 'send.example.com',
				resend_domain_id: 'dom_123',
				verification_status: 'pending',
				verification_error: null,
				last_polled_at: null,
				dns_records: [
					{
						record: 'SPF',
						type: 'TXT',
						name: 'send.example.com',
						value: 'v=spf1...',
						status: 'pending',
					},
					{
						record: 'DKIM',
						type: 'TXT',
						name: 'resend._domainkey.send.example.com',
						value: 'p=...',
						status: 'pending',
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
				capabilities: { sending: 'pending', receiving: 'pending' },
			},
		}
		const now = new Date('2026-09-27T12:00:00.000Z')

		it('writes per-record statuses and capabilities and stamps last_polled_at', () => {
			const response: ResendDomainGetResponse = {
				id: 'dom_123',
				status: 'pending',
				records: [
					{ record: 'SPF', type: 'TXT', name: 'x', value: 'y', status: 'verified' },
					{ record: 'DKIM', type: 'TXT', name: 'x', value: 'y', status: 'verified' },
					{ record: 'MX', type: 'MX', name: 'x', value: 'y', priority: 10, status: 'pending' },
				],
				capabilities: { sending: 'verified', receiving: 'pending' },
			}
			const next = buildPollFieldUpdate({ stored, response, now })
			expect(next.resend?.verification_status).toBe('pending')
			expect(next.resend?.dns_records).toEqual([
				{ ...stored.resend?.dns_records?.[0], status: 'verified' },
				{ ...stored.resend?.dns_records?.[1], status: 'verified' },
				{ ...stored.resend?.dns_records?.[2], status: 'pending' },
			])
			expect(next.resend?.capabilities).toEqual({ sending: 'verified', receiving: 'pending' })
			expect(next.resend?.last_polled_at).toBe(now.toISOString())
			expect(next.system_actor_id).toBe('actor-1')
		})

		it("flips verification_status to 'verified' and clears verification_error on top-level verified", () => {
			const priorErr: ResendIntegrationConfig = {
				...stored,
				resend: { ...stored.resend, verification_error: 'was previously wrong' },
			}
			const response: ResendDomainGetResponse = {
				id: 'dom_123',
				status: 'verified',
				records: [],
				capabilities: { sending: 'verified', receiving: 'verified' },
			}
			const next = buildPollFieldUpdate({ stored: priorErr, response, now })
			expect(next.resend?.verification_status).toBe('verified')
			expect(next.resend?.verification_error).toBeNull()
		})

		it("flips verification_status to 'failed' on top-level failure without clearing existing verification_error", () => {
			const response: ResendDomainGetResponse = {
				id: 'dom_123',
				status: 'failure',
				records: [],
				capabilities: { sending: 'failed', receiving: 'failed' },
			}
			const next = buildPollFieldUpdate({ stored, response, now })
			expect(next.resend?.verification_status).toBe('failed')
		})
	})

	describe('buildTimeoutFieldUpdate', () => {
		it("writes 'failed' + verification_error: 'timeout' + last_polled_at", () => {
			const stored: ResendIntegrationConfig = {
				resend: {
					resend_domain_id: 'dom_x',
					verification_status: 'pending',
					verification_error: null,
					last_polled_at: null,
					receive_subdomain: 'send.example.com',
				},
			}
			const now = new Date('2026-09-27T12:00:00.000Z')
			const next = buildTimeoutFieldUpdate(stored, now)
			expect(next.resend?.verification_status).toBe('failed')
			expect(next.resend?.verification_error).toBe('timeout')
			expect(next.resend?.last_polled_at).toBe(now.toISOString())
			// Preserves other fields.
			expect(next.resend?.resend_domain_id).toBe('dom_x')
			expect(next.resend?.receive_subdomain).toBe('send.example.com')
		})
	})

	describe('buildNotFoundFieldUpdate', () => {
		it("writes 'failed' + verification_error: 'domain_not_found' + last_polled_at", () => {
			const stored: ResendIntegrationConfig = {
				resend: {
					resend_domain_id: 'dom_x',
					verification_status: 'pending',
					verification_error: null,
					last_polled_at: null,
					receive_subdomain: 'send.example.com',
				},
			}
			const now = new Date('2026-09-27T12:00:00.000Z')
			const next = buildNotFoundFieldUpdate(stored, now)
			expect(next.resend?.verification_status).toBe('failed')
			expect(next.resend?.verification_error).toBe('domain_not_found')
			expect(next.resend?.last_polled_at).toBe(now.toISOString())
			expect(next.resend?.resend_domain_id).toBe('dom_x')
		})
	})

	describe('defaultPoll', () => {
		afterEach(() => {
			vi.restoreAllMocks()
		})

		it("maps a 404 from Resend to 'not_found' rather than retry", async () => {
			vi.spyOn(globalThis, 'fetch').mockResolvedValue(
				new Response(JSON.stringify({ name: 'not_found' }), { status: 404 }),
			)
			await expect(defaultPoll('dom_gone', 're_key')).resolves.toEqual({ kind: 'not_found' })
		})

		it("still maps other non-ok statuses to 'retry'", async () => {
			vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 422 }))
			await expect(defaultPoll('dom_x', 're_key')).resolves.toEqual({
				kind: 'retry',
				statusOrErr: '422',
			})
		})
	})
})
