import { Input } from '@/components/ui/input'
import { useEffect, useRef, useState } from 'react'

interface AgentCreateFormProps {
	onAutoCreate: (data: { name: string }) => void
	isPending?: boolean
	error?: Error | null
}

export function AgentCreateForm({ onAutoCreate, isPending = false, error }: AgentCreateFormProps) {
	const [name, setName] = useState('')
	const hasAutoCreatedRef = useRef(false)

	const isValid = name.trim().length > 0

	// Auto-create when form first becomes valid
	useEffect(() => {
		if (!isValid || hasAutoCreatedRef.current) return
		hasAutoCreatedRef.current = true
		onAutoCreate({ name: name.trim() })
	}, [isValid, name, onAutoCreate])

	return (
		<div className="space-y-6">
			{/* Name */}
			<Input
				type="text"
				value={name}
				onChange={(e) => setName(e.target.value)}
				placeholder="Agent name"
				autoFocus
				className="w-fit text-2xl font-semibold tracking-tight bg-transparent border-none outline-none text-foreground mb-2 h-auto p-0 focus:outline-none"
			/>

			{isPending && <p className="text-xs text-muted-foreground">Creating...</p>}

			{error && (
				<div className="rounded bg-error/10 px-3 py-2 text-sm text-error">
					{error.message || 'Failed to create agent'}
				</div>
			)}
		</div>
	)
}
