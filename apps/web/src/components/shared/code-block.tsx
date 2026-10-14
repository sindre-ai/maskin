import { Button } from '@/components/ui/button'
import { cn } from '@/lib/cn'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'

const COPIED_MS = 1800

/** Clipboard write with a hidden-textarea fallback for when navigator.clipboard is blocked. */
async function writeToClipboard(text: string) {
	try {
		await navigator.clipboard.writeText(text)
		return
	} catch {
		const textarea = document.createElement('textarea')
		textarea.value = text
		textarea.setAttribute('readonly', '')
		textarea.style.position = 'fixed'
		textarea.style.opacity = '0'
		document.body.appendChild(textarea)
		textarea.select()
		try {
			document.execCommand('copy')
		} finally {
			document.body.removeChild(textarea)
		}
	}
}

interface CodeBlockProps {
	/** Eyebrow label above the code. */
	label: string
	/** Set when the label is a file name or path, so it renders as written instead of uppercased. */
	fileName?: boolean
	text: string
	/** Shown in the toast after a copy. */
	toastMessage: string
	/** Disables the Copy button, e.g. when the text holds a placeholder instead of a real key. */
	copyDisabled?: boolean
	/** Called after a successful copy. */
	onCopy?: () => void
	className?: string
}

/** A labelled, wrapping mono block with a Copy button: the one shape for every copyable snippet. */
export function CodeBlock({
	label,
	fileName,
	text,
	toastMessage,
	copyDisabled,
	onCopy,
	className,
}: CodeBlockProps) {
	const [copied, setCopied] = useState(false)
	const timer = useRef<ReturnType<typeof setTimeout>>(undefined)

	useEffect(() => () => clearTimeout(timer.current), [])

	const handleCopy = async () => {
		await writeToClipboard(text)
		setCopied(true)
		toast.success(toastMessage)
		onCopy?.()
		clearTimeout(timer.current)
		timer.current = setTimeout(() => setCopied(false), COPIED_MS)
	}

	return (
		<div className={cn('overflow-hidden rounded-lg border border-border', className)}>
			<div className="flex h-9 items-center justify-between gap-2 border-b border-border-subtle bg-surface-sunken pl-3 pr-1.5">
				<span className={cn('eyebrow min-w-0 truncate', fileName && 'normal-case')}>{label}</span>
				<Button
					type="button"
					variant="outline"
					size="xs"
					className="shrink-0 border-border font-semibold hover:border-border-strong hover:bg-background hover:text-foreground"
					disabled={copyDisabled}
					onClick={handleCopy}
				>
					{copied ? 'Copied' : 'Copy'}
				</Button>
			</div>
			<pre className="bg-surface-sunken px-3 py-2.5 font-mono text-xs leading-[1.6] text-foreground whitespace-pre-wrap [overflow-wrap:anywhere]">
				{text}
			</pre>
		</div>
	)
}
