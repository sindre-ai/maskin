import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { LoopSummary } from '@/lib/api'
import { useChat } from '@/lib/chat-context'
import { Send } from 'lucide-react'
import { useState } from 'react'

/**
 * "Change by talking" utterance bar on loop detail. Submitting a plain-language
 * utterance opens the chat panel with this loop attached and forwards the text
 * as the first message, so the operator edits the loop by describing what
 * should change rather than filling in a builder.
 */
export function LoopUtteranceInput({ loop }: { loop: LoopSummary }) {
	const { openWithContext } = useChat()
	const [value, setValue] = useState('')

	const submit = () => {
		const utterance = value.trim()
		if (!utterance) return
		openWithContext([{ kind: 'object', id: loop.id, title: loop.name, type: 'loop' }], utterance)
		setValue('')
	}

	return (
		<form
			className="flex items-center gap-2"
			onSubmit={(e) => {
				e.preventDefault()
				submit()
			}}
		>
			<Input
				value={value}
				onChange={(e) => setValue(e.target.value)}
				placeholder="Listening — speak in plain words"
				aria-label="Say what should change about this loop"
				className="flex-1"
			/>
			<Button
				type="submit"
				size="icon"
				className="h-10 w-10 shrink-0"
				aria-label="Send"
				disabled={!value.trim()}
			>
				<Send size={15} />
			</Button>
		</form>
	)
}
