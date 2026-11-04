import { cn } from '@/lib/cn'
import { Check } from 'lucide-react'
import { useEffect, useState } from 'react'

interface UploadProgressProps {
	/** 0..1 fractional progress. Ignored when status is 'uploaded' or 'failed'. */
	progress: number
	status: 'uploading' | 'uploaded' | 'failed'
	error?: string
	className?: string
}

// How long the success check stays visible after an upload completes before
// fading away — short enough to feel ephemeral, long enough to register.
const CHECK_VISIBLE_MS = 4000

/**
 * Visual indicator for an in-flight or completed file upload. While uploading,
 * shows "Preparing…" until bytes move, then a progress bar with a percentage
 * driven by `progress`. On success the bar is replaced by a green check that
 * fades out after a few seconds; on failure by short red error text.
 */
export function UploadProgress({ progress, status, error, className }: UploadProgressProps) {
	const [checkVisible, setCheckVisible] = useState(true)

	useEffect(() => {
		if (status !== 'uploaded') {
			setCheckVisible(true)
			return
		}
		setCheckVisible(true)
		const t = setTimeout(() => setCheckVisible(false), CHECK_VISIBLE_MS)
		return () => clearTimeout(t)
	}, [status])

	if (status === 'uploaded') {
		if (!checkVisible) return null
		return (
			<span
				aria-label="Uploaded"
				className={cn(
					'inline-flex items-center text-success transition-opacity duration-300',
					className,
				)}
			>
				<Check size={14} />
			</span>
		)
	}

	if (status === 'failed') {
		return (
			<span className={cn('text-xs text-error truncate', className)} title={error}>
				{error ?? 'Upload failed'}
			</span>
		)
	}

	const fraction = Math.max(0, Math.min(1, progress))
	const pct = Math.round(fraction * 100)
	// Nothing has gone over the wire yet: the file is still being read or the upload
	// is being set up. A bare empty bar looks like nothing is happening.
	if (fraction === 0) {
		return (
			<span
				aria-label="Preparing upload"
				className={cn('text-xs text-muted-foreground', className)}
			>
				Preparing…
			</span>
		)
	}
	return (
		<span
			aria-label={`Uploading: ${pct}%`}
			className={cn('inline-flex items-center gap-1.5', className)}
		>
			<span className="block h-1.5 w-24 overflow-hidden rounded-full bg-muted">
				<span
					className="block h-full bg-accent transition-[width] duration-200"
					style={{ width: `${pct}%` }}
				/>
			</span>
			<span aria-hidden className="w-8 text-right text-xs tabular-nums text-muted-foreground">
				{pct}%
			</span>
		</span>
	)
}
