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
 * shows a thin progress bar driven by `progress`. On success the bar is replaced
 * by a green check that fades out after a few seconds; on failure by short red
 * error text.
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

	const pct = Math.max(0, Math.min(1, progress)) * 100
	return (
		<span
			aria-label={`Uploading: ${Math.round(pct)}%`}
			className={cn('block h-1 w-16 overflow-hidden rounded-full bg-bg-hover', className)}
		>
			<span
				className="block h-full bg-accent transition-[width] duration-200"
				style={{ width: `${pct}%` }}
			/>
		</span>
	)
}
