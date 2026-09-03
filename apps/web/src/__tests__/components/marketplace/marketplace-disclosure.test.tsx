import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../mocks/router')
	return mockTanStackRouter()
})

import {
	AsksSection,
	FlowSection,
	PermissionsSection,
} from '@/components/marketplace/marketplace-disclosure'

describe('FlowSection', () => {
	const step = {
		num: 1,
		agentName: 'Relay',
		agentType: 'agent',
		agentId: 'a-1',
		when: 'When signal is created',
		what: 'Acknowledge the customer.',
		ask: { ask: 'your explicit sign-off', reason: 'never auto-applies' },
	}

	it('takes its title and subtitle from the caller', () => {
		render(<FlowSection steps={[step]} title="How it works" subtitle="where it stops for you" />)
		expect(screen.getByText('How it works')).toBeInTheDocument()
		expect(screen.getByText('where it stops for you')).toBeInTheDocument()
	})

	it('paints the asks-you pill amber, never on bg-accent', () => {
		render(<FlowSection steps={[step]} />)
		const pill = screen.getByText(/asks you · your explicit sign-off/)
		expect(pill.className).toMatch(/bg-status-processing-bg/)
		expect(pill.className).toMatch(/text-status-processing-text/)
		expect(pill.className).not.toMatch(/bg-accent/)
	})

	it('renders nothing when there are no steps', () => {
		const { container } = render(<FlowSection steps={[]} />)
		expect(container.firstChild).toBeNull()
	})
})

describe('AsksSection', () => {
	const row = {
		id: '1',
		agentName: 'Relay',
		when: 'a risk lands',
		ask: 'a decision from you',
		why: 'asks you to confirm before escalating',
	}

	it('puts the rows on the parchment ask surface and renders the closing note', () => {
		render(<AsksSection rows={[row]} note="Everything else runs without you." />)
		const ask = screen.getByText('a decision from you')
		const surface = ask.closest('div.bg-ask-surface')
		expect(surface).not.toBeNull()
		expect(surface?.className).toMatch(/border-ask-border/)
		expect(screen.getByText('Everything else runs without you.')).toBeInTheDocument()
		expect(screen.getByText('the only places it stops for you')).toBeInTheDocument()
	})

	it('renders nothing when there are no asks', () => {
		const { container } = render(<AsksSection rows={[]} note="unused" />)
		expect(container.firstChild).toBeNull()
	})
})

describe('PermissionsSection', () => {
	it('renders one pill per permission, not key/value rows', () => {
		render(<PermissionsSection pills={['This workspace only', 'github']} />)
		const pill = screen.getByText('This workspace only')
		expect(pill.className).toMatch(/rounded-full/)
		expect(screen.getByText('github')).toBeInTheDocument()
		expect(screen.queryByText('Scope')).not.toBeInTheDocument()
	})

	it('renders nothing when there are no permissions', () => {
		const { container } = render(<PermissionsSection pills={[]} />)
		expect(container.firstChild).toBeNull()
	})
})
