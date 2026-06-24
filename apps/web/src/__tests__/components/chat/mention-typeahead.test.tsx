import { MentionTypeahead } from '@/components/chat/mention-typeahead'
import type { ActorListItem } from '@/lib/api'
import { fireEvent, render, screen } from '@testing-library/react'

function buildActor(overrides: Partial<ActorListItem>): ActorListItem {
	return {
		id: 'actor-1',
		type: 'human',
		name: 'Alice',
		email: null,
		description: null,
		isSystem: false,
		agentState: 'idle',
		...overrides,
	} as ActorListItem
}

describe('MentionTypeahead', () => {
	it('surfaces both humans and agents', () => {
		const actors = [
			buildActor({ id: 'h1', type: 'human', name: 'Alice' }),
			buildActor({ id: 'a1', type: 'agent', name: 'Codex' }),
		]
		render(<MentionTypeahead actors={actors} filter="" selectedIndex={0} onSelect={() => {}} />)
		expect(screen.getByText('Alice')).toBeDefined()
		expect(screen.getByText('Codex')).toBeDefined()
	})

	it('filters by the typed needle (case-insensitive)', () => {
		const actors = [buildActor({ id: 'h1', name: 'Alice' }), buildActor({ id: 'h2', name: 'Bob' })]
		render(<MentionTypeahead actors={actors} filter="bo" selectedIndex={0} onSelect={() => {}} />)
		expect(screen.queryByText('Alice')).toBeNull()
		expect(screen.getByText('Bob')).toBeDefined()
	})

	it('hides system actors and excluded ids', () => {
		const actors = [
			buildActor({ id: 'h1', name: 'Alice' }),
			buildActor({ id: 'h2', name: 'Bob' }),
			buildActor({ id: 'sys', name: 'System', isSystem: true }),
		]
		render(
			<MentionTypeahead
				actors={actors}
				filter=""
				excludeActorIds={['h1']}
				selectedIndex={0}
				onSelect={() => {}}
			/>,
		)
		expect(screen.queryByText('Alice')).toBeNull()
		expect(screen.queryByText('System')).toBeNull()
		expect(screen.getAllByTestId('mention-option')).toHaveLength(1)
		expect(screen.getByText('Bob')).toBeDefined()
	})

	it('returns nothing when the filtered list is empty', () => {
		const actors = [buildActor({ id: 'h1', name: 'Alice' })]
		const { container } = render(
			<MentionTypeahead actors={actors} filter="zzz" selectedIndex={0} onSelect={() => {}} />,
		)
		expect(container.firstChild).toBeNull()
	})

	it('emits a pick on mouse down with the actor id, name, and type', () => {
		const actors = [buildActor({ id: 'h1', type: 'human', name: 'Alice' })]
		const onSelect = vi.fn()
		render(<MentionTypeahead actors={actors} filter="" selectedIndex={0} onSelect={onSelect} />)
		fireEvent.mouseDown(screen.getByText('Alice'))
		expect(onSelect).toHaveBeenCalledWith({ id: 'h1', name: 'Alice', type: 'human' })
	})

	it('marks the highlighted row with aria-pressed', () => {
		const actors = [buildActor({ id: 'h1', name: 'Alice' }), buildActor({ id: 'h2', name: 'Bob' })]
		render(<MentionTypeahead actors={actors} filter="" selectedIndex={1} onSelect={() => {}} />)
		const opts = screen.getAllByTestId('mention-option')
		expect(opts[0].getAttribute('aria-pressed')).toBe('false')
		expect(opts[1].getAttribute('aria-pressed')).toBe('true')
	})
})
