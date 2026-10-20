import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useState } from 'react'

interface SecretInputProps {
	id: string
	value: string
	onChange: (value: string) => void
	disabled?: boolean
	/** Passed through so a browser's password manager can tell a login from a key. */
	autoComplete?: 'new-password' | 'off'
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
}: SecretInputProps) {
	const [reveal, setReveal] = useState(false)
	return (
		<div className="relative">
			<Input
				id={id}
				type={reveal ? 'text' : 'password'}
				value={value}
				onChange={(e) => onChange(e.target.value)}
				className="pr-16 font-mono"
				autoComplete={autoComplete}
				spellCheck={false}
				disabled={disabled}
				required
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
