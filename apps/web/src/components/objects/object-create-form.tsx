import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useEffect, useRef, useState } from 'react'

interface ObjectCreateFormProps {
	onAutoCreate: (data: { type: 'insight' | 'bet' | 'task'; title: string }) => void
	isPending?: boolean
	error?: Error | null
}

export function ObjectCreateForm({
	onAutoCreate,
	isPending = false,
	error,
}: ObjectCreateFormProps) {
	const [type, setType] = useState<'insight' | 'bet' | 'task'>('bet')
	const [title, setTitle] = useState('')
	const hasAutoCreatedRef = useRef(false)

	const isValid = title.trim().length > 0

	// Auto-create when form first becomes valid
	useEffect(() => {
		if (!isValid || hasAutoCreatedRef.current) return
		hasAutoCreatedRef.current = true
		onAutoCreate({ type, title: title.trim() })
	}, [isValid, type, title, onAutoCreate])

	return (
		<div className="space-y-6">
			{/* Title */}
			<Input
				type="text"
				value={title}
				onChange={(e) => setTitle(e.target.value)}
				placeholder="Untitled"
				autoFocus
				className="w-fit text-2xl font-semibold tracking-tight bg-transparent border-none outline-none text-foreground mb-2 h-auto p-0 focus:outline-none"
			/>

			{/* Type selector */}
			<div className="flex gap-2">
				{(['insight', 'bet', 'task'] as const).map((t) => (
					<Button
						key={t}
						type="button"
						variant={type === t ? 'default' : 'secondary'}
						size="sm"
						onClick={() => setType(t)}
						disabled={hasAutoCreatedRef.current}
					>
						{t}
					</Button>
				))}
			</div>

			{isPending && <p className="text-xs text-muted-foreground">Creating...</p>}

			{error && (
				<div className="rounded bg-error/10 px-3 py-2 text-sm text-error">
					{error.message || 'Failed to create object'}
				</div>
			)}
		</div>
	)
}
