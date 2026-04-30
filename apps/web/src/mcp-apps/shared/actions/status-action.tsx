/**
 * In-card status mutator. Wraps `<SchemaSelect field="status">` with the
 * action layer's optimistic-update + error-rendering pipeline.
 *
 * Reads valid statuses from the workspace schema. The widget shows the
 * optimistic value while the call is in flight, falls back to the server
 * value on rollback, and surfaces any error inline below the dropdown.
 */

import { cn } from '@/lib/cn'
import { useCallback } from 'react'
import { SchemaSelect } from '../schema-select'
import { useObjectMutation } from './use-object-mutation'

export interface StatusActionProps {
	objectId: string
	objectType: string
	currentStatus: string
	workspaceId?: string
	disabled?: boolean
	className?: string
	/** Optional callback fired after the server confirms the change. */
	onSuccess?: (next: string) => void
}

export function StatusAction({
	objectId,
	objectType,
	currentStatus,
	workspaceId,
	disabled,
	className,
	onSuccess,
}: StatusActionProps) {
	const mutation = useObjectMutation<string>({
		objectId,
		field: 'status',
		workspaceId,
		onSuccess,
	})
	const value = mutation.optimisticValue ?? currentStatus

	const onChange = useCallback(
		(next: string) => {
			if (next === value) return
			void mutation.run(next)
		},
		[mutation, value],
	)

	return (
		<div className={cn('inline-flex flex-col items-start gap-1', className)}>
			<SchemaSelect
				objectType={objectType}
				field="status"
				value={value}
				onChange={onChange}
				workspaceId={workspaceId}
				disabled={disabled || mutation.isPending}
				aria-label="Update status"
			/>
			{mutation.error && (
				<span className="text-[11px] text-destructive" role="alert">
					{mutation.error}
				</span>
			)}
		</div>
	)
}
