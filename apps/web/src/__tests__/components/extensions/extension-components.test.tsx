import { SetupProgressCard } from '@/components/extensions/setup-progress-card'
import { WebhookRevealDialog } from '@/components/extensions/webhook-reveal-dialog'
import { MaskedSecret, maskSecret } from '@/components/ui/masked-secret'
import type { ExtensionResponse } from '@/lib/api'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

function buildExtension(overrides: Partial<ExtensionResponse> = {}): ExtensionResponse {
	return {
		id: 'ext-1',
		workspaceId: 'ws-1',
		slug: 'fireflies',
		name: 'Fireflies',
		status: 'active',
		mcpConfig: null,
		webhookConfig: {
			signatureScheme: 'hmac-sha256',
			signatureHeader: 'X-Hub-Signature',
			eventMap: {
				externalIdPath: '$.meeting_id',
				entityType: { literal: 'fireflies.transcript' },
				action: { literal: 'ready' },
			},
		},
		webhookToken: 'tok',
		webhookUrl: 'http://localhost:3000/api/webhooks/x/tok',
		hasSigningSecret: true,
		hasMcpKey: false,
		toolGrants: {},
		mcpLastError: null,
		createdBy: null,
		createdAt: '2026-10-17T10:00:00.000Z',
		updatedAt: '2026-10-17T10:00:00.000Z',
		lastDeliveryAt: null,
		committedDeliveries: 0,
		...overrides,
	}
}

describe('maskSecret / MaskedSecret', () => {
	it('keeps the first 6 and last 4 characters of a long value', () => {
		expect(maskSecret('ff_key_abcdefghij1234')).toBe('ff_key••••••••1234')
	})

	it('shows dots only for a short value', () => {
		expect(maskSecret('short')).toBe('••••••••')
	})

	it('draws a fixed mask when no value is given', () => {
		render(<MaskedSecret aria-label="Signing secret (hidden)" />)
		expect(screen.getByLabelText('Signing secret (hidden)').textContent).toBe('••••••••••••••••')
	})
})

describe('SetupProgressCard', () => {
	it('waits for the first delivery when the webhook is wired', () => {
		render(<SetupProgressCard ext={buildExtension()} />)
		expect(screen.getByText('Waiting for first delivery')).toBeInTheDocument()
		expect(screen.getByText('Ready. Waiting for Fireflies to fire an event.')).toBeInTheDocument()
	})

	it('flips to Receiving once a delivery has been committed', () => {
		render(<SetupProgressCard ext={buildExtension({ committedDeliveries: 2 })} />)
		expect(screen.getByText('Receiving')).toBeInTheDocument()
		expect(screen.queryByText('Waiting for first delivery')).not.toBeInTheDocument()
	})

	it('asks to finish the webhook when no secret is stored', () => {
		render(<SetupProgressCard ext={buildExtension({ hasSigningSecret: false })} />)
		expect(
			screen.getByText('Finish the webhook and mapping to start receiving.'),
		).toBeInTheDocument()
	})
})

describe('WebhookRevealDialog', () => {
	const baseProps = {
		open: true,
		vendorName: 'Fireflies',
		webhookUrl: 'http://localhost:3000/api/webhooks/x/tok',
	}

	it('shows the URL and secret and warns about the secret only', () => {
		render(<WebhookRevealDialog {...baseProps} secret={'s'.repeat(64)} onDone={() => {}} />)
		expect(screen.getByText(baseProps.webhookUrl)).toBeInTheDocument()
		expect(screen.getByText('s'.repeat(64))).toBeInTheDocument()
		expect(screen.getByText(/You won't see the secret again/)).toBeInTheDocument()
		expect(screen.queryByText(/token again/i)).not.toBeInTheDocument()
	})

	it('leaves the secret row and warning out when no secret is held', () => {
		render(<WebhookRevealDialog {...baseProps} onDone={() => {}} />)
		expect(screen.queryByText('Signing secret')).not.toBeInTheDocument()
		expect(screen.queryByText(/You won't see the secret again/)).not.toBeInTheDocument()
	})

	it('only closes through the primary button, not Escape', () => {
		const onDone = vi.fn()
		render(<WebhookRevealDialog {...baseProps} secret={'s'.repeat(64)} onDone={onDone} />)
		fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
		expect(onDone).not.toHaveBeenCalled()
		fireEvent.click(screen.getByRole('button', { name: "I've saved them in Fireflies" }))
		expect(onDone).toHaveBeenCalledTimes(1)
	})
})
