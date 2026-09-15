import { AgentOutput } from '@/components/shared/agent-output'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

describe('AgentOutput', () => {
	it('wraps rendered markdown in an .agent-output container', () => {
		const { container } = render(<AgentOutput content="**bold**" />)
		const wrapper = container.querySelector('.agent-output')
		expect(wrapper).not.toBeNull()
		expect(wrapper?.querySelector('strong')?.textContent).toBe('bold')
	})

	it('forwards props to the underlying MarkdownContent', () => {
		render(
			<AgentOutput
				content={'# Heading text\n\nbody'}
				disallowedElements={['h1', 'h2', 'h3', 'h4', 'h5', 'h6']}
			/>,
		)
		expect(screen.getByText('Heading text')).toBeInTheDocument()
		expect(screen.getByText('body')).toBeInTheDocument()
	})

	it('renders code blocks inside the wrapper so .agent-output pre styling applies', () => {
		const { container } = render(<AgentOutput content={'Line one\n\n```ts\nconst x = 1\n```'} />)
		const pre = container.querySelector('.agent-output pre')
		expect(pre).not.toBeNull()
		expect(pre?.textContent).toContain('const x = 1')
	})

	it('renders list items inside the wrapper so .agent-output li styling applies', () => {
		const { container } = render(<AgentOutput content={'- alpha\n- beta\n- gamma'} />)
		const items = container.querySelectorAll('.agent-output li')
		expect(items).toHaveLength(3)
		expect(items[0].textContent).toBe('alpha')
	})
})
