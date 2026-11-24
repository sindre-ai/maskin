import { ReceiptRoutesPanel } from '@/components/loops/receipt-routes-panel'
import type { ReceiptIntakeStatus } from '@/lib/api'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const updateEmail = vi.fn()
const createKey = vi.fn()
const revokeKey = vi.fn()
let status: ReceiptIntakeStatus | undefined

vi.mock('@/hooks/use-receipt-intake', () => ({
	useReceiptIntake: () => ({ data: status }),
	useReceiptIntakeActions: () => ({
		updateEmail: { mutate: updateEmail, isPending: false },
		createKey: { mutate: createKey, isPending: false },
		revokeKey: { mutate: revokeKey, isPending: false },
	}),
}))

function build(over: Partial<ReceiptIntakeStatus['email']> = {}): ReceiptIntakeStatus {
	return {
		email: {
			available: true,
			enabled: false,
			address: null,
			allowed_senders: [],
			default_sender: 'owner@firm.test',
			accepted: 0,
			held: 0,
			...over,
		},
		command: {
			upload_url: 'https://app.test/api/receipt-intake/upload',
			keys: [{ id: 'k1', last4: 'abcd', created_at: '2026-11-24T10:00:00Z', last_used_at: null }],
		},
		limits: { daily_cap: 50, max_file_bytes: 10485760, file_types: ['PDF', 'JPEG'] },
	}
}

beforeEach(() => {
	vi.clearAllMocks()
})

describe('ReceiptRoutesPanel', () => {
	it('renders nothing for a flow that is not an Accounting flow', () => {
		status = undefined
		const { container } = render(<ReceiptRoutesPanel workspaceId="ws" loopId="loop" />)
		expect(container).toBeEmptyDOMElement()
	})

	it('shows email off by default and switches it on', () => {
		status = build()
		render(<ReceiptRoutesPanel workspaceId="ws" loopId="loop" />)
		expect(screen.getByText(/Off\. Switch it on/)).toBeInTheDocument()
		fireEvent.click(screen.getByRole('switch', { name: 'Receive receipts by email' }))
		expect(updateEmail).toHaveBeenCalledWith({ enabled: true })
	})

	it('shows the address, the counts and a switch-off when email is on', () => {
		status = build({ enabled: true, address: 'r-abc@receipts.test', accepted: 3, held: 2 })
		render(<ReceiptRoutesPanel workspaceId="ws" loopId="loop" />)
		expect(screen.getByText('r-abc@receipts.test')).toBeInTheDocument()
		expect(screen.getByText('3 taken in, 2 held back')).toBeInTheDocument()
		fireEvent.click(screen.getByRole('switch', { name: 'Receive receipts by email' }))
		expect(updateEmail).toHaveBeenCalledWith({ enabled: false })
	})

	it('says email is not available yet when the receiving domain is not set up', () => {
		status = build({ available: false })
		render(<ReceiptRoutesPanel workspaceId="ws" loopId="loop" />)
		expect(screen.getByText('Not available yet.')).toBeInTheDocument()
		expect(screen.getByRole('switch', { name: 'Receive receipts by email' })).toBeDisabled()
	})

	it('lists command keys by their last four and revokes one', () => {
		status = build()
		render(<ReceiptRoutesPanel workspaceId="ws" loopId="loop" />)
		expect(screen.getByText(/rck_…abcd/)).toBeInTheDocument()
		fireEvent.click(screen.getByRole('button', { name: 'Revoke' }))
		expect(revokeKey).toHaveBeenCalledWith('k1')
	})
})
