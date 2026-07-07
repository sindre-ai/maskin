import {
	FailureCard,
	SessionDetailPanel,
	parseFailureReason,
} from '@/components/agents/session-detail-panel'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildSessionResponse } from '../../factories'
import { createWorkspaceWrapper } from '../../setup'

const createSessionMutate = vi.fn()
let createSessionIsPending = false

vi.mock('@/hooks/use-sessions', () => ({
	useSessionLogs: () => ({ data: [], isLoading: false }),
	useCreateSession: () => ({ mutate: createSessionMutate, isPending: createSessionIsPending }),
}))

vi.mock('@/hooks/use-events', () => ({
	useSessionAffectedObjects: () => ({ affectedObjects: [], isLoading: false }),
}))

vi.mock('@tanstack/react-router', () => ({
	Link: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}))

vi.mock('@/components/shared/relative-time', () => ({
	RelativeTime: () => <span>some time ago</span>,
}))

vi.mock('@/components/shared/markdown-content', () => ({
	MarkdownContent: ({ content }: { content: string }) => <div>{content}</div>,
}))

function renderPanel(session: ReturnType<typeof buildSessionResponse>) {
	const Wrapper = createWorkspaceWrapper()
	return render(
		<Wrapper>
			<SessionDetailPanel
				session={session}
				workspaceId="ws-1"
				open={true}
				onOpenChange={() => {}}
			/>
		</Wrapper>,
	)
}

beforeEach(() => {
	createSessionMutate.mockReset()
	createSessionIsPending = false
	vi.spyOn(console, 'info').mockImplementation(() => {})
})

afterEach(() => {
	vi.restoreAllMocks()
})

describe('parseFailureReason', () => {
	it('returns null for null result', () => {
		expect(parseFailureReason(null)).toBeNull()
	})

	it('returns null when failure_reason is absent', () => {
		expect(parseFailureReason({ exit_code: 1 })).toBeNull()
	})

	it('returns null when failure_reason is missing required fields', () => {
		expect(parseFailureReason({ failure_reason: { provider: 'anthropic' } })).toBeNull()
	})

	it('parses a complete failure_reason', () => {
		const result = parseFailureReason({
			failure_reason: {
				provider: 'anthropic',
				reason_code: 'billing_error',
				human_message: 'Credit limit reached',
				http_status: 402,
				reset_at: '2026-07-01T00:00:00Z',
				verbatim_output: 'Billing error',
			},
		})
		expect(result).toEqual({
			provider: 'anthropic',
			reason_code: 'billing_error',
			human_message: 'Credit limit reached',
			http_status: 402,
			reset_at: '2026-07-01T00:00:00Z',
			verbatim_output: 'Billing error',
		})
	})

	it('handles null optional fields', () => {
		const result = parseFailureReason({
			failure_reason: {
				provider: 'openrouter',
				reason_code: 'billing_error',
				human_message: 'Out of credits',
				http_status: null,
				reset_at: null,
				verbatim_output: null,
			},
		})
		expect(result?.http_status).toBeNull()
		expect(result?.reset_at).toBeNull()
		expect(result?.verbatim_output).toBeNull()
	})
})

function renderCard(
	failureReason: Parameters<typeof FailureCard>[0]['failureReason'],
	workspaceId = 'ws-1',
) {
	const Wrapper = createWorkspaceWrapper()
	return render(
		<Wrapper>
			<FailureCard failureReason={failureReason} workspaceId={workspaceId} />
		</Wrapper>,
	)
}

describe('FailureCard', () => {
	it('shows provider label and human_message as title', () => {
		renderCard({
			provider: 'anthropic',
			reason_code: 'billing_error',
			human_message: 'Credit limit reached',
			http_status: 402,
			reset_at: null,
			verbatim_output: null,
		})
		expect(screen.getByText('Anthropic — Credit limit reached')).toBeInTheDocument()
	})

	it('shows provider, reason_code, and http_status chips', () => {
		renderCard({
			provider: 'anthropic',
			reason_code: 'billing_error',
			human_message: 'Credit limit reached',
			http_status: 402,
			reset_at: null,
			verbatim_output: null,
		})
		expect(screen.getByText('anthropic')).toBeInTheDocument()
		expect(screen.getByText('billing_error')).toBeInTheDocument()
		expect(screen.getByText('HTTP 402')).toBeInTheDocument()
	})

	it('omits http_status chip when null', () => {
		renderCard({
			provider: 'anthropic',
			reason_code: 'billing_error',
			human_message: 'Credit limit reached',
			http_status: null,
			reset_at: null,
			verbatim_output: null,
		})
		expect(screen.queryByText(/HTTP/)).not.toBeInTheDocument()
	})

	it('shows reset countdown chip when reset_at is set', () => {
		renderCard({
			provider: 'anthropic',
			reason_code: 'billing_error',
			human_message: 'Credit limit reached',
			http_status: null,
			reset_at: '2026-07-01T00:00:00Z',
			verbatim_output: null,
		})
		expect(screen.getByText(/resets/)).toBeInTheDocument()
	})

	it('shows Top up and Switch to OpenRouter buttons for billing_error on non-openrouter provider', () => {
		renderCard({
			provider: 'anthropic',
			reason_code: 'billing_error',
			human_message: 'Credit limit reached',
			http_status: null,
			reset_at: null,
			verbatim_output: null,
		})
		expect(screen.getByRole('link', { name: /Top up Anthropic credits/ })).toBeInTheDocument()
		expect(screen.getByText('Switch to OpenRouter key')).toBeInTheDocument()
		expect(screen.getByText('Wait')).toBeInTheDocument()
	})

	it('hides Switch to OpenRouter button when provider is openrouter', () => {
		renderCard({
			provider: 'openrouter',
			reason_code: 'insufficient_credits',
			human_message: 'Out of credits',
			http_status: 402,
			reset_at: null,
			verbatim_output: null,
		})
		expect(screen.queryByText('Switch to OpenRouter key')).not.toBeInTheDocument()
		expect(screen.getByRole('link', { name: /Top up OpenRouter credits/ })).toBeInTheDocument()
	})

	it('shows only Wait chip for max_plan_rate_limit (no Top up or Switch button)', () => {
		renderCard({
			provider: 'anthropic',
			reason_code: 'max_plan_rate_limit',
			human_message: 'Claude Max plan rate limit reached — try again later',
			http_status: 402,
			reset_at: null,
			verbatim_output: null,
		})
		expect(screen.getByText('Wait')).toBeInTheDocument()
		expect(screen.queryByRole('link', { name: /Top up/ })).not.toBeInTheDocument()
		expect(screen.queryByText('Switch to OpenRouter key')).not.toBeInTheDocument()
	})

	it('shows Connect Claude subscription button for not_logged_in', () => {
		renderCard({
			provider: 'anthropic',
			reason_code: 'not_logged_in',
			human_message: 'Claude credentials not connected — please import your Claude subscription',
			http_status: null,
			reset_at: null,
			verbatim_output: 'Not logged in',
		})
		expect(screen.getByText('Connect Claude subscription')).toBeInTheDocument()
		expect(screen.queryByText('Wait')).not.toBeInTheDocument()
		expect(screen.queryByRole('link', { name: /Top up/ })).not.toBeInTheDocument()
	})

	it('shows only Wait chip for server_rate_limit (no Top up or Switch button)', () => {
		renderCard({
			provider: 'anthropic',
			reason_code: 'server_rate_limit',
			human_message: 'Claude server is temporarily limiting requests',
			http_status: null,
			reset_at: null,
			verbatim_output: 'Server is temporarily limiting requests',
		})
		expect(screen.getByText('Wait')).toBeInTheDocument()
		expect(screen.queryByRole('link', { name: /Top up/ })).not.toBeInTheDocument()
		expect(screen.queryByText('Switch to OpenRouter key')).not.toBeInTheDocument()
	})

	it('shows only Wait chip for request_rejected_429 (no Top up or Switch button)', () => {
		renderCard({
			provider: 'anthropic',
			reason_code: 'request_rejected_429',
			human_message: 'Claude request rejected — rate limit',
			http_status: null,
			reset_at: null,
			verbatim_output: 'Request rejected (429)',
		})
		expect(screen.getByText('Wait')).toBeInTheDocument()
		expect(screen.queryByRole('link', { name: /Top up/ })).not.toBeInTheDocument()
		expect(screen.queryByText('Switch to OpenRouter key')).not.toBeInTheDocument()
	})

	it('hides recovery row for non-credit reason codes', () => {
		renderCard({
			provider: 'anthropic',
			reason_code: 'rate_limit_error',
			human_message: 'Too many requests',
			http_status: 429,
			reset_at: null,
			verbatim_output: null,
		})
		expect(screen.queryByRole('link', { name: /Top up/ })).not.toBeInTheDocument()
		expect(screen.queryByText('Wait')).not.toBeInTheDocument()
	})

	it('does not show verbatim section when verbatim_output is null', () => {
		renderCard({
			provider: 'anthropic',
			reason_code: 'billing_error',
			human_message: 'Credit limit reached',
			http_status: null,
			reset_at: null,
			verbatim_output: null,
		})
		expect(screen.queryByText('Provider output')).not.toBeInTheDocument()
	})

	it('toggles verbatim provider output on click', async () => {
		const user = userEvent.setup()
		renderCard({
			provider: 'anthropic',
			reason_code: 'billing_error',
			human_message: 'Credit limit reached',
			http_status: null,
			reset_at: null,
			verbatim_output: 'Billing limit exceeded. Please add credits.',
		})
		expect(
			screen.queryByText('Billing limit exceeded. Please add credits.'),
		).not.toBeInTheDocument()
		await user.click(screen.getByText('Provider output'))
		expect(screen.getByText('Billing limit exceeded. Please add credits.')).toBeInTheDocument()
		await user.click(screen.getByText('Provider output'))
		expect(
			screen.queryByText('Billing limit exceeded. Please add credits.'),
		).not.toBeInTheDocument()
	})
})

// These are the exact failure_reason objects that classifyCreditExhaustion emits
// for each of the seven reason codes that should produce a recovery row in FailureCard.
// Each case exercises the pipeline: classifier output -> parseFailureReason -> FailureCard.
const CLASSIFIER_OUTPUTS: Array<{
	code: string
	failureReason: Parameters<typeof FailureCard>[0]['failureReason']
}> = [
	{
		code: 'billing_error',
		// triggered by: tail.includes('billing_error') without Max plan markers
		failureReason: {
			provider: 'anthropic',
			reason_code: 'billing_error',
			human_message: 'Anthropic billing error — credit balance may be exhausted',
			http_status: 402,
			reset_at: null,
			verbatim_output: null,
		},
	},
	{
		code: 'credit_balance_low',
		// triggered by: 'Credit balance is too low' CLI banner
		failureReason: {
			provider: 'anthropic',
			reason_code: 'credit_balance_low',
			human_message: 'Claude credit balance is too low',
			http_status: null,
			reset_at: null,
			verbatim_output: 'Credit balance is too low',
		},
	},
	{
		code: 'insufficient_credits',
		// triggered by: 'insufficient credits' (OpenRouter 402)
		failureReason: {
			provider: 'openrouter',
			reason_code: 'insufficient_credits',
			human_message: 'OpenRouter: insufficient credits',
			http_status: 402,
			reset_at: null,
			verbatim_output: null,
		},
	},
	{
		code: 'session_limit',
		// triggered by: "You've hit your session limit" CLI banner
		failureReason: {
			provider: 'anthropic',
			reason_code: 'session_limit',
			human_message: 'Claude session limit reached',
			http_status: null,
			reset_at: null,
			verbatim_output: "You've hit your session limit",
		},
	},
	{
		code: 'weekly_limit',
		// triggered by: "You've hit your weekly limit" CLI banner
		failureReason: {
			provider: 'anthropic',
			reason_code: 'weekly_limit',
			human_message: 'Claude weekly limit reached',
			http_status: null,
			reset_at: null,
			verbatim_output: "You've hit your weekly limit",
		},
	},
	{
		code: 'opus_limit',
		// triggered by: "You've hit your Opus limit" CLI banner
		failureReason: {
			provider: 'anthropic',
			reason_code: 'opus_limit',
			human_message: 'Claude Opus limit reached',
			http_status: null,
			reset_at: null,
			verbatim_output: "You've hit your Opus limit",
		},
	},
	{
		code: 'max_plan_rate_limit',
		// triggered by: tail.includes('billing_error') with 'try again' or 'usage/rate limit'
		failureReason: {
			provider: 'anthropic',
			reason_code: 'max_plan_rate_limit',
			human_message: 'Claude Max plan rate limit reached — try again later',
			http_status: 402,
			reset_at: null,
			verbatim_output: null,
		},
	},
	{
		code: 'server_rate_limit',
		// triggered by: 'Server is temporarily limiting requests' CLI banner
		failureReason: {
			provider: 'anthropic',
			reason_code: 'server_rate_limit',
			human_message: 'Claude server is temporarily limiting requests',
			http_status: null,
			reset_at: null,
			verbatim_output: 'Server is temporarily limiting requests',
		},
	},
	{
		code: 'request_rejected_429',
		// triggered by: 'Request rejected (429)' CLI banner
		failureReason: {
			provider: 'anthropic',
			reason_code: 'request_rejected_429',
			human_message: 'Claude request rejected — rate limit',
			http_status: null,
			reset_at: null,
			verbatim_output: 'Request rejected (429)',
		},
	},
]

describe('classifier codes -> FailureCard recovery row', () => {
	it.each(CLASSIFIER_OUTPUTS)(
		'$code: parseFailureReason round-trips and FailureCard shows recovery row',
		({ failureReason }) => {
			const sessionResult = { exit_code: 1, failure_reason: failureReason }
			const parsed = parseFailureReason(sessionResult)
			expect(parsed).not.toBeNull()
			if (!parsed) return
			expect(parsed.reason_code).toBe(failureReason.reason_code)
			renderCard(parsed)
			expect(screen.getByText('Wait')).toBeInTheDocument()
		},
	)
})

describe('SessionDetailPanel failure display', () => {
	it('shows FailureCard when session result has classified failure_reason', () => {
		const session = buildSessionResponse({
			status: 'failed',
			result: {
				exit_code: 1,
				failure_reason: {
					provider: 'anthropic',
					reason_code: 'billing_error',
					human_message: 'Credit limit reached',
					http_status: 402,
					reset_at: null,
					verbatim_output: null,
				},
			},
		})
		renderPanel(session)
		expect(screen.getByText('Anthropic — Credit limit reached')).toBeInTheDocument()
		expect(screen.queryByText(/Process exited/)).not.toBeInTheDocument()
	})

	it('falls back to thin red banner when failure_reason is absent', () => {
		const session = buildSessionResponse({
			status: 'failed',
			result: { exit_code: 1 },
		})
		renderPanel(session)
		expect(screen.getByText('Process exited with code 1')).toBeInTheDocument()
		expect(screen.queryByText(/Credit limit/)).not.toBeInTheDocument()
	})

	it('shows killed message when exit_code is null (OOM kill)', () => {
		const session = buildSessionResponse({
			status: 'failed',
			result: { exit_code: null },
		})
		renderPanel(session)
		expect(screen.getByText('Container process was killed')).toBeInTheDocument()
	})
})

describe('SessionDetailPanel Restart button', () => {
	it.each(['failed', 'timeout', 'completed'])('renders Restart on terminal status %s', (status) => {
		renderPanel(buildSessionResponse({ status }))
		expect(screen.getByRole('button', { name: 'Restart' })).toBeInTheDocument()
	})

	it.each(['running', 'starting', 'paused', 'snapshotting', 'idle'])(
		'does not render Restart on non-terminal status %s',
		(status) => {
			renderPanel(buildSessionResponse({ status }))
			expect(screen.queryByRole('button', { name: 'Restart' })).not.toBeInTheDocument()
		},
	)

	it('on click, fires createSession with actor_id + action_prompt and emits a tracked event', async () => {
		const user = userEvent.setup()
		const session = buildSessionResponse({
			id: 'sess-1',
			status: 'failed',
			actorId: 'actor-xyz',
			actionPrompt: 'Re-run the agent',
		})
		renderPanel(session)

		await user.click(screen.getByRole('button', { name: 'Restart' }))

		expect(createSessionMutate).toHaveBeenCalledTimes(1)
		expect(createSessionMutate).toHaveBeenCalledWith({
			actor_id: 'actor-xyz',
			action_prompt: 'Re-run the agent',
		})

		const analyticsCalls = vi
			.mocked(console.info)
			.mock.calls.filter(([tag]) => tag === '[analytics]')
		expect(analyticsCalls).toHaveLength(1)
		const payload = analyticsCalls[0][1] as Record<string, unknown>
		expect(payload).toMatchObject({
			name: 'session_restart_clicked',
			source: 'session-detail-panel',
			session_id: 'sess-1',
			actor_id: 'actor-xyz',
			prior_status: 'failed',
		})
	})

	it('shows pending label while the mutation is in flight and ignores clicks', async () => {
		const user = userEvent.setup()
		createSessionIsPending = true
		renderPanel(buildSessionResponse({ status: 'failed' }))

		const button = screen.getByRole('button', { name: 'Restarting…' })
		expect(button).toBeDisabled()

		await user.click(button)
		expect(createSessionMutate).not.toHaveBeenCalled()
	})
})
