import { Button } from '@/components/ui/button'
import { Check, Copy } from 'lucide-react'
import { useCallback, useState } from 'react'

/**
 * Copies `text` to the clipboard and shows a check for 2s. Promoted from
 * settings/mcp-connection.tsx so the MCP page and the extension webhook UI
 * share one copy contract.
 */
export function CopyButton({
	text,
	label,
	className,
	ariaLabel,
}: {
	text: string
	/** true shows "Copy", a string shows that text while idle. */
	label?: boolean | string
	className?: string
	ariaLabel?: string
}) {
	const [copied, setCopied] = useState(false)

	const handleCopy = useCallback(async () => {
		await navigator.clipboard.writeText(text)
		setCopied(true)
		setTimeout(() => setCopied(false), 2000)
	}, [text])

	return (
		<Button
			type="button"
			variant="secondary"
			size="sm"
			className={className}
			onClick={handleCopy}
			aria-label={ariaLabel}
		>
			{copied ? (
				<>
					<Check size={14} />
					{label && <span className="ml-1">Copied!</span>}
				</>
			) : (
				<>
					<Copy size={14} />
					{label && <span className="ml-1">{typeof label === 'string' ? label : 'Copy'}</span>}
				</>
			)}
			<output className="sr-only" aria-live="polite">
				{copied ? 'Copied' : ''}
			</output>
		</Button>
	)
}
