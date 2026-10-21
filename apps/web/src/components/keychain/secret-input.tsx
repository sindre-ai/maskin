import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/cn'
import { useState } from 'react'

interface SecretInputProps {
	id: string
	value: string
	onChange: (value: string) => void
	disabled?: boolean
	/** Passed through so a browser's password manager can tell a login from a key. */
	autoComplete?: 'new-password' | 'off'
	/** False when leaving it blank is allowed, as when editing a saved credential. */
	required?: boolean
	placeholder?: string
}

/**
 * The input every Keychain form types a secret into: masked, with a Show/Hide switch,
 * and with browser autofill and spellcheck off. One component so the settings form and
 * the chat card cannot drift apart on how a secret is entered.
 */
export function SecretInput({
	id,
	value,
	onChange,
	disabled,
	autoComplete = 'new-password',
	required = true,
	placeholder,
}: SecretInputProps) {
	const [reveal, setReveal] = useState(false)
	return (
		<div className="relative">
			<Input
				id={id}
				type={reveal ? 'text' : 'password'}
				value={value}
				onChange={(e) => onChange(e.target.value)}
				// Monospace for the secret itself; the placeholder stays in the normal font like every other field.
				className={cn('pr-16', value && 'font-mono')}
				autoComplete={autoComplete}
				spellCheck={false}
				disabled={disabled}
				required={required}
				placeholder={placeholder}
			/>
			<Button
				type="button"
				variant="ghost"
				size="sm"
				className="absolute top-1/2 right-1 h-7 -translate-y-1/2 px-2"
				aria-pressed={reveal}
				onClick={() => setReveal((r) => !r)}
			>
				{reveal ? 'Hide' : 'Show'}
			</Button>
		</div>
	)
}
