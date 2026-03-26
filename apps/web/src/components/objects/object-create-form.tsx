import { EmptyState } from '@/components/shared/empty-state'
import { Button } from '@/components/ui/button'
import { ButtonGroup } from '@/components/ui/button-group'
import { Input } from '@/components/ui/input'
import { useEnabledModules } from '@/hooks/use-enabled-modules'
import { getEnabledObjectTypeTabs } from '@ai-native/module-sdk'
import { useEffect, useMemo, useRef, useState } from 'react'
import { MarkdownContent } from '../shared/markdown-content'
import { LinkedObjects } from './linked-objects'
import { MetadataProperties } from './metadata-properties'

interface ObjectCreateFormProps {
	objectId: string
	object?: import('@/lib/api').ObjectResponse
	onAutoCreate: (data: { type: string; title: string }) => void
	onUpdate?: (data: { title?: string; content?: string; status?: string }) => void
	isPending?: boolean
	error?: Error | null
}

export function ObjectCreateForm({
	objectId,
	object,
	onAutoCreate,
	onUpdate,
	isPending = false,
	error,
}: ObjectCreateFormProps) {
	const enabledModules = useEnabledModules()

	const availableTypes = useMemo(() => getEnabledObjectTypeTabs(enabledModules), [enabledModules])

	const [type, setType] = useState(availableTypes[0]?.value ?? '')
	const [title, setTitle] = useState('')
	const hasAutoCreatedRef = useRef(false)
	const isValid = title.trim().length > 0

	// Auto-create when form first becomes valid
	useEffect(() => {
		if (availableTypes.length === 0) return
		if (!isValid || hasAutoCreatedRef.current) return
		hasAutoCreatedRef.current = true
		onAutoCreate({ type, title: title.trim() })
	}, [isValid, type, title, onAutoCreate, availableTypes.length])

	if (availableTypes.length === 0) {
		return (
			<div className="max-w-3xl mx-auto">
				<EmptyState
					title="No object types available"
					description="Enable an extension in workspace settings to create objects."
				/>
			</div>
		)
	}

	// Once created, sync title updates on blur
	const handleTitleBlur = () => {
		if (object && title.trim() !== object.title && onUpdate) {
			onUpdate({ title: title.trim() })
		}
	}

	const handleContentChange = (content: string) => {
		if (object && onUpdate) {
			onUpdate({ content })
		}
	}

	return (
		<div className="max-w-3xl mx-auto">
			{/* Title */}
			<Input
				type="text"
				value={title}
				onChange={(e) => setTitle(e.target.value)}
				onBlur={handleTitleBlur}
				onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
				placeholder="Untitled"
				autoFocus
				className="w-fit text-2xl font-semibold tracking-tight bg-transparent border-none outline-none text-foreground mb-2 h-auto p-0 focus:outline-none"
			/>

			{/* Type selector */}
			<div className="mb-6">
				<ButtonGroup>
					{availableTypes.map((t) => (
						<Button
							key={t.value}
							type="button"
							variant={type === t.value ? 'secondary' : 'ghost'}
							size="sm"
							onClick={() => setType(t.value)}
							disabled={hasAutoCreatedRef.current}
						>
							{t.label}
						</Button>
					))}
				</ButtonGroup>
			</div>

			{/* Properties */}
			<div className="mb-6 w-fit">
				{object ? (
					<MetadataProperties object={object} />
				) : (
					<Button variant="ghost" size="sm" disabled>
						+ Add property
					</Button>
				)}
			</div>

			{/* Content editor */}
			<div className="mb-8">
				<MarkdownContent content={object?.content ?? ''} onChange={handleContentChange} editable />
			</div>

			{/* Linked objects */}
			<div className="border-t border-border pt-6 mb-8">
				<LinkedObjects
					objectId={objectId}
					objectType={object?.type ?? type}
					asSource={[]}
					asTarget={[]}
				/>
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
