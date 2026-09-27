import {
	ResendConnectDialog,
	type ResendConnectPrefill,
} from '@/components/integrations/resend/resend-connect-dialog'
import type { ResendDnsRecord } from '@/lib/api'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TestWrapper } from '../../../setup'

// Task 2 owns the endpoints; the dialog just drives them. Mocking the API
// module keeps this a pure component test — the shape below matches what
// Task 2's spec says /connect and /dns-precheck return.
vi.mock('@/lib/api', () => ({
	api: {
		integrations: {
			connect: vi.fn(),
			complete: vi.fn(),
			resendDnsPrecheck: vi.fn(),
		},
	},
}))

import { api } from '@/lib/api'

const DNS_RECORDS_PENDING: ResendDnsRecord[] = [
	{
		record: 'SPF',
		type: 'TXT',
		name: 'send.mail.example.com',
		value: 'v=spf1 include:amazonses.com ~all',
		status: 'pending',
	},
	{
		record: 'DKIM',
		type: 'CNAME',
		name: 'resend._domainkey.mail.example.com',
		value: 'resend._domainkey.us-east-1.amazonses.com',
		status: 'pending',
	},
	{
		record: 'MX',
		type: 'MX',
		name: 'mail.example.com',
		value: 'feedback-smtp.us-east-1.amazonses.com',
		priority: 10,
		status: 'pending',
	},
]

const CONNECT_SUCCESS = {
	integration_id: 'int-1',
	webhook_url: 'https://maskin.example/api/webhooks/resend/tok',
	dns_records: DNS_RECORDS_PENDING,
	verification_status: 'pending' as const,
}

const PRECHECK_SAFE = { existing_mx: [], is_subdomain: true, warn: false }
const PRECHECK_WARN = {
	existing_mx: ['aspmx.l.google.com'],
	is_subdomain: false,
	warn: true,
}

function renderDialog(prefill: ResendConnectPrefill | null = null) {
	const onClose = vi.fn()
	const result = render(
		<TestWrapper>
			<ResendConnectDialog workspaceId="ws-1" open={true} onClose={onClose} prefill={prefill} />
		</TestWrapper>,
	)
	return { ...result, onClose }
}

describe('ResendConnectDialog', () => {
	beforeEach(() => {
		vi.mocked(api.integrations.connect).mockReset()
		vi.mocked(api.integrations.complete).mockReset()
		vi.mocked(api.integrations.resendDnsPrecheck).mockReset()
	})

	describe('Step 1 → Step 2 transition', () => {
		it('lands focus on the API key input and disables Next until non-empty', async () => {
			renderDialog()
			const input = await screen.findByLabelText(/Resend API key/i)
			await waitFor(() => expect(input).toHaveFocus())

			const nextButton = screen.getByRole('button', { name: /^Next/i })
			expect(nextButton).toBeDisabled()

			await userEvent.type(input, 're_test_key')
			expect(nextButton).toBeEnabled()
		})

		it('advances to Step 2 on Next with a non-empty key', async () => {
			renderDialog()
			await userEvent.type(await screen.findByLabelText(/Resend API key/i), 're_test_key')
			await userEvent.click(screen.getByRole('button', { name: /^Next/i }))
			expect(
				await screen.findByRole('heading', { name: /which domain will your agents send from/i }),
			).toBeInTheDocument()
		})
	})

	describe('Step 2 → Step 3 pending (happy path)', () => {
		it('fires dns-precheck then /connect and renders Step 3 pending records', async () => {
			vi.mocked(api.integrations.resendDnsPrecheck).mockResolvedValue(PRECHECK_SAFE)
			vi.mocked(api.integrations.connect).mockResolvedValue(CONNECT_SUCCESS)
			renderDialog()

			await userEvent.type(await screen.findByLabelText(/Resend API key/i), 're_test_key')
			await userEvent.click(screen.getByRole('button', { name: /^Next/i }))
			await userEvent.type(await screen.findByLabelText(/receiving domain/i), 'mail.example.com')
			await userEvent.click(screen.getByRole('button', { name: /register domain/i }))

			await waitFor(() =>
				expect(vi.mocked(api.integrations.resendDnsPrecheck)).toHaveBeenCalledWith(
					'ws-1',
					'mail.example.com',
				),
			)
			await waitFor(() =>
				expect(vi.mocked(api.integrations.connect)).toHaveBeenCalledWith('ws-1', 'resend', {
					api_key: 're_test_key',
					receive_subdomain: 'mail.example.com',
				}),
			)

			// All three records + the webhook URL + poll strip should be visible.
			expect(await screen.findByText(/v=spf1 include:amazonses/i)).toBeInTheDocument()
			expect(screen.getByText(/feedback-smtp\.us-east-1/i)).toBeInTheDocument()
			expect(screen.getByText(/Waiting on 3 records/i)).toBeInTheDocument()
			expect(screen.getByLabelText(/webhook signing secret/i)).toBeInTheDocument()
		})
	})

	describe('root-MX branching after dns-precheck warn', () => {
		it('renders s3-root-mx instead of the records list when precheck warns', async () => {
			vi.mocked(api.integrations.resendDnsPrecheck).mockResolvedValue(PRECHECK_WARN)
			vi.mocked(api.integrations.connect).mockResolvedValue(CONNECT_SUCCESS)
			renderDialog()

			await userEvent.type(await screen.findByLabelText(/Resend API key/i), 're_test_key')
			await userEvent.click(screen.getByRole('button', { name: /^Next/i }))
			await userEvent.type(await screen.findByLabelText(/receiving domain/i), 'example.com')
			await userEvent.click(screen.getByRole('button', { name: /register domain/i }))

			expect(
				await screen.findByRole('heading', {
					name: /looks like your human inbox/i,
				}),
			).toBeInTheDocument()
			expect(screen.getByText(/already routes mail via aspmx\.l\.google\.com/i)).toBeInTheDocument()

			// Because we branched into root-mx, /connect must not have fired yet.
			expect(vi.mocked(api.integrations.connect)).not.toHaveBeenCalled()

			// "Pick a subdomain" returns to Step 2 with the domain preserved.
			await userEvent.click(screen.getByRole('button', { name: /pick a subdomain/i }))
			const domainInput = (await screen.findByLabelText(/receiving domain/i)) as HTMLInputElement
			expect(domainInput.value).toBe('example.com')
		})

		it('advances to Step 3b without pre-check when the user picks "Continue anyway"', async () => {
			vi.mocked(api.integrations.resendDnsPrecheck).mockResolvedValue(PRECHECK_WARN)
			vi.mocked(api.integrations.connect).mockResolvedValue(CONNECT_SUCCESS)
			renderDialog()

			await userEvent.type(await screen.findByLabelText(/Resend API key/i), 're_test_key')
			await userEvent.click(screen.getByRole('button', { name: /^Next/i }))
			await userEvent.type(await screen.findByLabelText(/receiving domain/i), 'example.com')
			await userEvent.click(screen.getByRole('button', { name: /register domain/i }))
			await userEvent.click(await screen.findByRole('button', { name: /continue anyway/i }))

			await waitFor(() =>
				expect(vi.mocked(api.integrations.connect)).toHaveBeenCalledWith('ws-1', 'resend', {
					api_key: 're_test_key',
					receive_subdomain: 'example.com',
				}),
			)
		})
	})

	describe('Save and come back later', () => {
		it('fires onClose from Step 3 without hitting /complete', async () => {
			vi.mocked(api.integrations.resendDnsPrecheck).mockResolvedValue(PRECHECK_SAFE)
			vi.mocked(api.integrations.connect).mockResolvedValue(CONNECT_SUCCESS)
			const { onClose } = renderDialog()

			await userEvent.type(await screen.findByLabelText(/Resend API key/i), 're_test_key')
			await userEvent.click(screen.getByRole('button', { name: /^Next/i }))
			await userEvent.type(await screen.findByLabelText(/receiving domain/i), 'mail.example.com')
			await userEvent.click(screen.getByRole('button', { name: /register domain/i }))

			await userEvent.click(
				await screen.findByRole('button', { name: /save and come back later/i }),
			)
			expect(onClose).toHaveBeenCalled()
			expect(vi.mocked(api.integrations.complete)).not.toHaveBeenCalled()
		})
	})

	describe('Resume affordance', () => {
		it('opens directly at Step 3 pending with the row config rehydrated', async () => {
			renderDialog({
				integrationId: 'int-resume',
				webhookUrl: 'https://maskin.example/api/webhooks/resend/tok-resume',
				dnsRecords: DNS_RECORDS_PENDING,
				verificationStatus: 'pending',
				receiveSubdomain: 'mail.example.com',
			})

			expect(
				await screen.findByRole('heading', { name: /verify dns \+ finish the webhook/i }),
			).toBeInTheDocument()
			expect(
				screen.getByText(/https:\/\/maskin\.example\/api\/webhooks\/resend\/tok-resume/i),
			).toBeInTheDocument()
			// Step 1 input must NOT be present — we skipped it entirely.
			expect(screen.queryByLabelText(/Resend API key/i)).not.toBeInTheDocument()
		})

		it('lands on the partial-verified scene when capabilities.sending is verified but receiving is not', async () => {
			renderDialog({
				integrationId: 'int-partial',
				webhookUrl: 'https://maskin.example/api/webhooks/resend/tok',
				dnsRecords: DNS_RECORDS_PENDING,
				verificationStatus: 'pending',
				receiveSubdomain: 'mail.example.com',
				capabilities: { sending: 'verified', receiving: 'pending' },
			})
			expect(await screen.findByRole('heading', { name: /mx still missing/i })).toBeInTheDocument()
		})
	})

	describe('Step 3 → Step 4 finish', () => {
		it('fires /complete with the pasted secret when records verified', async () => {
			vi.mocked(api.integrations.complete).mockResolvedValue({ activated: true })
			const verified = DNS_RECORDS_PENDING.map((r) => ({ ...r, status: 'verified' as const }))
			renderDialog({
				integrationId: 'int-verify',
				webhookUrl: 'https://maskin.example/api/webhooks/resend/tok',
				dnsRecords: verified,
				verificationStatus: 'pending',
				receiveSubdomain: 'mail.example.com',
			})

			await userEvent.type(await screen.findByLabelText(/webhook signing secret/i), 'whsec_abc123')
			await userEvent.click(screen.getByRole('button', { name: /finish connecting/i }))
			await waitFor(() =>
				expect(vi.mocked(api.integrations.complete)).toHaveBeenCalledWith(
					'int-verify',
					'ws-1',
					'whsec_abc123',
				),
			)
			expect(
				await screen.findByRole('heading', { name: /resend is connected/i }),
			).toBeInTheDocument()
		})
	})
})
