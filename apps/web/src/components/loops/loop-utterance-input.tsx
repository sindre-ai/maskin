import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { LoopSummary } from '@/lib/api'
import { useWorkspace } from '@/lib/workspace-context'
import { useNavigate } from '@tanstack/react-router'
import { Send } from 'lucide-react'
import { useState } from 'react'

/**
 * "Change by talking" utterance bar on loop detail. Submitting a plain-language
 * utterance opens a new chat with this loop attached, so the operator edits
 * the loop by describing what should change rather than filling in a builder.
 */
export function LoopUtteranceInput({ loop }: { loop: LoopSummary }) {
	const { workspaceId } = useWorkspace()
	const navigate = useNavigate()
	const [value, setValue] = useState('')

	const submit = () => {
		const utterance = value.trim()
		if (!utterance) return
		setValue('')
		navigate({
			to: '/$workspaceId/chats/new',
			params: { workspaceId },
			search: { objectId: loop.id, objectTitle: loop.name ?? undefined, objectType: 'loop' },
		})
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
