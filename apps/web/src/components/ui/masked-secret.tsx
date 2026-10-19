import { cn } from '@/lib/cn'

const DOTS = '••••••••'

/**
 * Masks a token as first 6 characters, dot fill, last 4 (for example
 * ff_key••••••••ab3f). Values too short to hide anything behind a prefix and
 * suffix are shown as dots only.
 */
export function maskSecret(value: string): string {
	if (value.length < 16) return DOTS
	return `${value.slice(0, 6)}${DOTS}${value.slice(-4)}`
}

/**
 * Read-only box for a secret the page must not show in full. Pass `value`
 * when the page holds the secret (just-created, still in memory) and
 * the first and last characters are kept; omit it when the server never
 * returns the secret, and a fixed mask is drawn.
 */
export function MaskedSecret({
	value,
	className,
	'aria-label': ariaLabel,
}: { value?: string; className?: string; 'aria-label'?: string }) {
	return (
		<output
			aria-label={ariaLabel}
			className={cn(
				'block truncate rounded-md border border-border bg-muted px-3 py-2 font-mono text-xs text-foreground',
				className,
			)}
		>
			{value ? maskSecret(value) : `${DOTS}${DOTS}`}
		</output>
	)
}
