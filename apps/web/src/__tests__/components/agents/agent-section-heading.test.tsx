import { AgentSectionHeading } from '@/components/agents/agent-section-heading'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

describe('AgentSectionHeading', () => {
	it('renders the title as a level-2 heading', () => {
		render(<AgentSectionHeading title="Sessions" />)
		expect(screen.getByRole('heading', { name: 'Sessions', level: 2 })).toBeInTheDocument()
	})

	it('renders the note and the action slot', () => {
		render(
			<AgentSectionHeading
				title="Skills"
				note="3"
				action={
					<button type="button" onClick={() => {}}>
						Manage
					</button>
				}
			/>,
		)
		expect(screen.getByText('3')).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Manage' })).toBeInTheDocument()
	})

	it('applies a caller-supplied note class so the note can carry a status tone', () => {
		render(
			<AgentSectionHeading
				title="Sessions"
				note="held where they stopped"
				noteClassName="text-warning"
			/>,
		)
		expect(screen.getByText('held where they stopped').className).toContain('text-warning')
	})

	it('links the heading to its section when given an id', () => {
		render(
			<section aria-labelledby="tools-heading">
				<AgentSectionHeading id="tools-heading" title="Tools" />
			</section>,
		)
		expect(screen.getByRole('region', { name: 'Tools' })).toBeInTheDocument()
	})
})
