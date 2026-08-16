import { CapabilityCard, CapabilityLevelPill } from '@/components/agents/capability-card'
import type { Capability } from '@/lib/api'
import { render, screen } from '@testing-library/react'

function buildCapability(overrides: Partial<Capability> = {}): Capability {
	return {
		version: 1,
		overall: { score: 12, level: 'novice' },
		dimensions: [
			{ key: 'expertise', label: 'Expertise', score: 1, weight: 35, reasons: ['Prompt is thin'] },
			{ key: 'skills', label: 'Skills', score: 0, weight: 20, reasons: ['No skills attached'] },
			{
				key: 'connectors',
				label: 'Connectors',
				score: 0,
				weight: 20,
				reasons: ['No external connectors'],
			},
			{ key: 'context', label: 'Context', score: 1, weight: 10, reasons: ['Model set'] },
			{ key: 'autonomy', label: 'Autonomy', score: 0, weight: 15, reasons: ['No triggers'] },
		],
		unresolvedPlaceholders: [],
		topGaps: [
			{
				action: 'Write a fuller system prompt',
				detail: 'Add role, decision framework, and examples',
				dimension: 'expertise',
				toolHint: 'update_actor',
			},
			{
				action: 'Attach a skill',
				detail: 'Skills teach the agent a repeatable procedure',
				dimension: 'skills',
				toolHint: 'create_workspace_skill',
			},
		],
		...overrides,
	}
}

describe('CapabilityLevelPill', () => {
	it('renders the level label and score', () => {
		render(<CapabilityLevelPill level="practitioner" score={42} />)
		const pill = screen.getByLabelText(/Capability: Practitioner, score 42/)
		expect(pill).toBeInTheDocument()
		expect(pill.textContent).toContain('Practitioner')
		expect(pill.textContent).toContain('42')
	})

	it('renders without a score when omitted', () => {
		render(<CapabilityLevelPill level="master" />)
		expect(screen.getByLabelText('Capability: Master')).toBeInTheDocument()
	})
})

describe('CapabilityCard', () => {
	it('renders the overall level pill, five dimension tiles, and level-up items', () => {
		render(<CapabilityCard capability={buildCapability()} />)

		expect(screen.getByLabelText(/Capability: Novice, score 12/)).toBeInTheDocument()
		expect(screen.getByTestId('capability-tile-expertise')).toBeInTheDocument()
		expect(screen.getByTestId('capability-tile-skills')).toBeInTheDocument()
		expect(screen.getByTestId('capability-tile-connectors')).toBeInTheDocument()
		expect(screen.getByTestId('capability-tile-context')).toBeInTheDocument()
		expect(screen.getByTestId('capability-tile-autonomy')).toBeInTheDocument()

		expect(screen.getByText('Write a fuller system prompt')).toBeInTheDocument()
		expect(screen.getByText('update_actor')).toBeInTheDocument()
		expect(screen.getByText('Attach a skill')).toBeInTheDocument()
	})

	it('encodes each tile as an image with a "N of 5" aria-label so the score is machine-readable', () => {
		render(<CapabilityCard capability={buildCapability()} />)
		const expertiseTile = screen.getByTestId('capability-tile-expertise')
		expect(expertiseTile.querySelector('[role="img"]')).toHaveAttribute(
			'aria-label',
			'Expertise score: 1 of 5',
		)
	})

	it('hides the Level up section when topGaps is empty', () => {
		render(
			<CapabilityCard
				capability={buildCapability({
					overall: { score: 92, level: 'master' },
					topGaps: [],
				})}
			/>,
		)
		expect(screen.queryByTestId('capability-level-up')).not.toBeInTheDocument()
	})
})
