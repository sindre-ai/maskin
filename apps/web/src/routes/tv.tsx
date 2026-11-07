import { FormError } from '@/components/shared/form-error'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Spinner } from '@/components/ui/spinner'
import { ApiError, type DeviceAuthPreview, api } from '@/lib/api'
import { clearAuth, getApiKey, getStoredActor, setApiKey, setStoredActor } from '@/lib/auth'
import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'

export const Route = createFileRoute('/tv')({
	validateSearch: (search: Record<string, unknown>) => ({
		code: typeof search.code === 'string' ? search.code : '',
	}),
	head: () => ({ meta: [{ title: 'Sign in a device — Maskin' }] }),
	component: TvSignInPage,
})

// A device (Apple TV, Mac) shows a short code (and a QR link that carries it in ?code=). Whoever
// types or scans it here, signed in as themselves, approves the device: it then receives their
// session. So the page says plainly what is being approved and tells the person to check the code
// is the one on the device's screen. A spent or unknown code ends in an "expired" state that sends
// them back to restart on the device.

type Step =
	| { kind: 'enter' }
	| { kind: 'confirm'; code: string; device: DeviceAuthPreview }
	| { kind: 'done'; approved: boolean }
	| { kind: 'expired' }

/** Group as typed so it reads like the TV: BCDF2345 -> BCDF-2345. */
function groupCode(raw: string): string {
	const cleaned = raw
		.toUpperCase()
		.replace(/[^A-Z0-9]/g, '')
		.slice(0, 8)
	return cleaned.length > 4 ? `${cleaned.slice(0, 4)}-${cleaned.slice(4)}` : cleaned
}

function Shell({ children }: { children: React.ReactNode }) {
	return (
		<div className="flex min-h-screen items-center justify-center px-4">
			<div className="w-full max-w-sm space-y-6">{children}</div>
		</div>
	)
}

function Heading({ title, children }: { title: string; children?: React.ReactNode }) {
	return (
		<div className="text-center">
			<h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
			{children && <p className="mt-1 text-sm text-muted-foreground">{children}</p>}
		</div>
	)
}

function messageFor(err: unknown): string {
	if (err instanceof ApiError && err.status === 404) {
		return "That code isn't valid or has expired. Check the code on your device, or restart sign-in there."
	}
	if (err instanceof ApiError && err.status === 429) {
		return 'Too many attempts. Wait a minute, then try again.'
	}
	return err instanceof Error ? err.message : 'Something went wrong'
}

function TvSignInPage() {
	const { code: initialCode } = Route.useSearch()
	// Bumped after sign-in or sign-out so the signed-in check re-reads storage.
	const [, setAuthVersion] = useState(0)
	const apiKey = getApiKey()
	const actor = getStoredActor()

	if (!apiKey || !actor) {
		return <SignedOut onSignedIn={() => setAuthVersion((v) => v + 1)} />
	}
	return (
		<SignedIn
			initialCode={initialCode}
			who={actor.email ?? actor.name}
			onSignedOut={() => {
				clearAuth()
				setAuthVersion((v) => v + 1)
			}}
		/>
	)
}

function SignedOut({ onSignedIn }: { onSignedIn: () => void }) {
	const [email, setEmail] = useState('')
	const [password, setPassword] = useState('')
	const [error, setError] = useState('')
	const [loading, setLoading] = useState(false)

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault()
		setLoading(true)
		setError('')
		try {
			const result = await api.auth.login({ email, password })
			setApiKey(result.api_key)
			setStoredActor({ id: result.id, name: result.name, type: result.type, email: result.email })
			onSignedIn()
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Could not sign in')
		} finally {
			setLoading(false)
		}
	}

	return (
		<Shell>
			<Heading title="Sign in a device">
				Sign in to Maskin here first, then approve your device.
			</Heading>
			<form onSubmit={handleSubmit} className="space-y-4">
				<div>
					<Label htmlFor="tv-email" className="mb-1 text-muted-foreground">
						Email
					</Label>
					<Input
						id="tv-email"
						type="email"
						value={email}
						onChange={(e) => setEmail(e.target.value)}
						autoComplete="email"
						className="max-md:h-11"
						autoFocus
					/>
				</div>
				<div>
					<Label htmlFor="tv-password" className="mb-1 text-muted-foreground">
						Password
					</Label>
					<Input
						id="tv-password"
						type="password"
						value={password}
						onChange={(e) => setPassword(e.target.value)}
						autoComplete="current-password"
						className="max-md:h-11"
					/>
				</div>
				{error && <FormError error={error} />}
				<Button
					type="submit"
					size="lg"
					disabled={loading || !email || !password}
					className="w-full"
				>
					{loading ? 'Signing in…' : 'Sign in'}
				</Button>
			</form>
		</Shell>
	)
}

function SignedIn({
	initialCode,
	who,
	onSignedOut,
}: {
	initialCode: string
	who: string
	onSignedOut: () => void
}) {
	const [step, setStep] = useState<Step>({ kind: 'enter' })
	const [code, setCode] = useState(groupCode(initialCode))
	const [error, setError] = useState('')
	const [loading, setLoading] = useState(false)

	const lookUp = async (value: string) => {
		setLoading(true)
		setError('')
		try {
			const device = await api.deviceAuth.preview(value)
			setStep({ kind: 'confirm', code: value, device })
		} catch (err) {
			if (err instanceof ApiError && err.status === 401) {
				onSignedOut()
				return
			}
			setError(messageFor(err))
		} finally {
			setLoading(false)
		}
	}

	// A scanned QR link arrives with the code already in the address: go straight to the question.
	// biome-ignore lint/correctness/useExhaustiveDependencies: once, for the code in the link
	useEffect(() => {
		if (initialCode) void lookUp(groupCode(initialCode))
	}, [])

	const decide = async (approve: boolean) => {
		if (step.kind !== 'confirm') return
		setLoading(true)
		setError('')
		try {
			await (approve ? api.deviceAuth.approve(step.code) : api.deviceAuth.deny(step.code))
			setStep({ kind: 'done', approved: approve })
		} catch (err) {
			if (err instanceof ApiError && err.status === 404) {
				setStep({ kind: 'expired' })
				return
			}
			setError(messageFor(err))
		} finally {
			setLoading(false)
		}
	}

	if (step.kind === 'done') {
		return (
			<Shell>
				<output className="block">
					<Heading title={step.approved ? 'Your device is signing in' : 'Sign-in refused'}>
						{step.approved
							? 'You can close this page. It takes a few seconds on the device.'
							: 'Nothing was signed in.'}
					</Heading>
				</output>
				<Button asChild size="lg" className="w-full">
					<a href="/">Done</a>
				</Button>
			</Shell>
		)
	}

	if (step.kind === 'expired') {
		return (
			<Shell>
				<Heading title="This code has expired">
					Nothing was signed in. Restart sign-in on your device to get a new code.
				</Heading>
				<Button
					type="button"
					size="lg"
					className="w-full"
					onClick={() => {
						setCode('')
						setError('')
						setStep({ kind: 'enter' })
					}}
				>
					Enter another code
				</Button>
			</Shell>
		)
	}

	if (step.kind === 'confirm') {
		const name = step.device.device_name ?? 'Apple TV'
		return (
			<Shell>
				<Heading title={`Sign in ${name}?`}>
					It will use your account, <span className="font-medium text-foreground">{who}</span>.
				</Heading>
				<div className="rounded-lg border border-border bg-card p-4 text-center">
					<p className="eyebrow">Code on your device</p>
					<p className="mt-2 font-mono text-2xl font-semibold tracking-widest max-md:h-11">
						{step.code}
					</p>
					<p className="mt-2 text-sm text-muted-foreground">
						Only approve if the code on your device is {step.code}.
					</p>
				</div>
				{error && <FormError error={error} className="text-center" />}
				<div className="space-y-2">
					<Button
						type="button"
						size="lg"
						className="w-full"
						onClick={() => decide(true)}
						disabled={loading}
					>
						{loading ? 'Approving…' : 'Approve'}
					</Button>
					<Button
						type="button"
						variant="ghost"
						size="lg"
						className="w-full"
						onClick={() => decide(false)}
						disabled={loading}
					>
						This isn't me
					</Button>
				</div>
			</Shell>
		)
	}

	return (
		<Shell>
			<Heading title="Sign in a device">
				Type the code shown on your Apple TV or Mac. You're signed in as{' '}
				<span className="font-medium text-foreground">{who}</span>.
			</Heading>
			<form
				onSubmit={(e) => {
					e.preventDefault()
					void lookUp(code)
				}}
				className="space-y-4"
			>
				<div>
					<Label htmlFor="tv-code" className="mb-1 text-muted-foreground">
						Code
					</Label>
					<Input
						id="tv-code"
						value={code}
						onChange={(e) => {
							setCode(groupCode(e.target.value))
							setError('')
						}}
						placeholder="XXXX-XXXX"
						className="text-center font-mono text-lg tracking-widest max-md:h-11"
						autoCapitalize="characters"
						autoComplete="off"
						autoCorrect="off"
						spellCheck={false}
						autoFocus
					/>
				</div>
				{error && <FormError error={error} />}
				<Button type="submit" size="lg" disabled={loading || code.length < 9} className="w-full">
					{loading ? <Spinner /> : 'Continue'}
				</Button>
			</form>
		</Shell>
	)
}
