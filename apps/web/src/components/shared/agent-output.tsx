import type { ComponentProps } from 'react'
import { MarkdownContent } from './markdown-content'

export function AgentOutput(props: ComponentProps<typeof MarkdownContent>) {
	return (
		<div className="agent-output">
			<MarkdownContent {...props} />
		</div>
	)
}
