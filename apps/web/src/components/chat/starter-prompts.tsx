import { Button } from '@/components/ui/button'
import { cn } from '@/lib/cn'

interface StarterPromptsProps {
	prompts: readonly string[]
	/** Puts the prompt in the message box and focuses it. Nothing is sent until the person sends. */
	onPick: (prompt: string) => void
	className?: string
}

/**
 * The agent's own one-tap openers, as chips above the message box. A tap fills the box, so the
 * person can still change the words before sending. Renders nothing for an agent with none.
 */
export function StarterPrompts({ prompts, onPick, className }: StarterPromptsProps) {
	if (prompts.length === 0) return null
	return (
		<fieldset
			className={cn('m-0 flex min-w-0 flex-wrap gap-2 border-0 p-0', className)}
			data-testid="starter-prompts"
		>
			<legend className="sr-only">Starter prompts</legend>
			{prompts.map((prompt) => (
				<Button
					key={prompt}
					type="button"
					variant="outline"
					size="sm"
					className="h-auto min-h-11 max-w-full rounded-full whitespace-normal px-4 py-2 text-left"
					onClick={() => onPick(prompt)}
				>
					{prompt}
				</Button>
			))}
		</fieldset>
	)
}
