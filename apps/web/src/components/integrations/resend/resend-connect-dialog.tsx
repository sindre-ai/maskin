import { ConnectStepper, type ConnectStepperStep } from '@/components/shared/connect-stepper'
import { Button } from '@/components/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
	useCompleteIntegration,
	useConnectIntegration,
	useResendDnsPrecheck,
} from '@/hooks/use-integrations'
import type { ResendDnsRecord } from '@/lib/api'
import { cn } from '@/lib/cn'
import { AlertTriangle, ArrowLeft, ArrowRight, Check, Copy, Info } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

// The 4-step Resend self-serve connect Dialog. Governed at the call site by
// `useFeatureFlag('resend-integration-ui')`. Every user-visible string is
// verbatim from the design spec attached to the parent bet; do not paraphrase.

export type ResendConnectScene =
	| 's1'
	| 's1-err'
	| 's2'
	| 's2-err'
	| 's3-loading'
	| 's3-pending'
	| 's3-root-mx'
	| 's3-partial'
	| 's4-done'

export interface ResendConnectPrefill {
	integrationId: string
	webhookUrl: string
	dnsRecords: ResendDnsRecord[]
	verificationStatus: 'pending' | 'verified' | 'failed'
	receiveSubdomain: string
	capabilities?: { sending?: string; receiving?: string }
	existingMxHost?: string
}

interface Props {
	workspaceId: string
	open: boolean
	onClose: () => void
	/** Populated when the dialog is opened from the Resume-connect affordance on
	 *  an `awaiting_secret` row — jumps straight to Step 3 pre-populated. */
	prefill?: ResendConnectPrefill | null
}

const STEP_LABELS = ['API key', 'Domain', 'DNS + webhook', 'Done']

export function ResendConnectDialog({ workspaceId, open, onClose, prefill }: Props) {
	const [scene, setScene] = useState<ResendConnectScene>('s1')
	const [apiKey, setApiKey] = useState('')
	const [domain, setDomain] = useState('')
	const [webhookUrl, setWebhookUrl] = useState('')
	const [integrationId, setIntegrationId] = useState<string | null>(null)
	const [dnsRecords, setDnsRecords] = useState<ResendDnsRecord[]>([])
	const [existingMxHost, setExistingMxHost] = useState<string | null>(null)
	const [connectError, setConnectError] = useState<{
		code:
			| 'INVALID_API_KEY'
			| 'DOMAIN_ALREADY_CLAIMED'
			| 'BARE_DOMAIN_HAS_MAIL'
			| 'INVALID_DOMAIN'
			| 'UNKNOWN'
		message?: string
	} | null>(null)
	const [signingSecret, setSigningSecret] = useState('')
	const apiKeyInputRef = useRef<HTMLInputElement>(null)

	const connect = useConnectIntegration(workspaceId)
	const dnsPrecheck = useResendDnsPrecheck(workspaceId)
	const complete = useCompleteIntegration(workspaceId)

	// Rehydrate straight into Step 3 when reopened on an `awaiting_secret` row.
	// The prefill is authoritative — the parent settings row's `config.resend`
	// is what the poller (Task 5) freshens, so re-reading it every open beats
	// keeping stale state on close.
	useEffect(() => {
		if (!open) return
		if (prefill) {
			setIntegrationId(prefill.integrationId)
			setWebhookUrl(prefill.webhookUrl)
			setDnsRecords(prefill.dnsRecords)
			setDomain(prefill.receiveSubdomain)
			setExistingMxHost(prefill.existingMxHost ?? null)
			setScene(deriveResumeScene(prefill))
			return
		}
		// Fresh open — clear everything and focus the API key input.
		setScene('s1')
		setApiKey('')
		setDomain('')
		setWebhookUrl('')
		setIntegrationId(null)
		setDnsRecords([])
		setExistingMxHost(null)
		setConnectError(null)
		setSigningSecret('')
	}, [open, prefill])

	// Focus lands on the API key input on open — spec.
	useEffect(() => {
		if (!open || scene !== 's1') return
		apiKeyInputRef.current?.focus()
	}, [open, scene])

	const activeStep = sceneToStep(scene)
	const steps: ConnectStepperStep[] = STEP_LABELS.map((label, i) => ({
		label,
		status: activeStep === i ? 'active' : activeStep > i ? 'done' : 'pending',
	}))

	const closeAndReset = () => {
		onClose()
	}

	const handleApiKeyNext = () => {
		if (!apiKey.trim()) return
		setConnectError(null)
		setScene('s2')
	}

	const handleDomainSubmit = async () => {
		if (!domain.trim()) return
		// Fire the pre-check before we hit /connect. On a root-MX warn we swap
		// scene into `s3-root-mx` instead of dispatching /connect.
		try {
			const precheck = await dnsPrecheck.mutateAsync(domain.trim())
			if (precheck.warn) {
				setExistingMxHost(precheck.existing_mx[0] ?? null)
				setScene('s3-root-mx')
				return
			}
		} catch {
			// Precheck degrades to a passive callout per spec §8.2 — a failure
			// here shouldn't block a good subdomain from registering.
		}
		await handleRegisterDomain()
	}

	const handleRegisterDomain = async () => {
		setConnectError(null)
		setScene('s3-loading')
		try {
			const data = await connect.mutateAsync({
				provider: 'resend',
				apiKey: apiKey.trim(),
				receiveSubdomain: domain.trim(),
			})
			if (data.integration_id && data.webhook_url && data.dns_records) {
				setIntegrationId(data.integration_id)
				setWebhookUrl(data.webhook_url)
				setDnsRecords(data.dns_records)
				setScene(data.verification_status === 'verified' ? 's4-done' : 's3-pending')
			} else {
				setScene('s2-err')
				setConnectError({ code: 'UNKNOWN' })
			}
		} catch (err) {
			const parsed = parseConnectError(err)
			setConnectError(parsed)
			setScene(parsed.code === 'INVALID_API_KEY' ? 's1-err' : 's2-err')
		}
	}

	const handleComplete = async () => {
		if (!integrationId || !signingSecret.trim()) return
		try {
			await complete.mutateAsync({ id: integrationId, secret: signingSecret.trim() })
			setScene('s4-done')
		} catch {
			// Complete failure leaves the row `awaiting_secret`; keep the dialog
			// open so the user can retry rather than swallowing the error.
		}
	}

	const dialogTitleId = 'resend-connect-dialog-title'

	return (
		<Dialog open={open} onOpenChange={(next) => !next && closeAndReset()}>
			<DialogContent aria-labelledby={dialogTitleId} className="sm:max-w-2xl overflow-hidden">
				<DialogHeader>
					<div className="mb-3">
						<span className="text-[8px] font-bold tracking-[0.11em] uppercase text-muted-foreground font-mono">
							CONNECT INTEGRATION · STEP {activeStep + 1} OF 4
						</span>
					</div>
					<DialogTitle id={dialogTitleId}>{titleForScene(scene, domain)}</DialogTitle>
					<DialogDescription>{descriptionForScene(scene, domain)}</DialogDescription>
					<div className="pt-4">
						<ConnectStepper steps={steps} />
					</div>
				</DialogHeader>
				<div className="max-h-[65vh] overflow-y-auto pr-1">
					{(scene === 's1' || scene === 's1-err') && (
						<StepOne
							apiKey={apiKey}
							onApiKeyChange={setApiKey}
							error={scene === 's1-err' ? connectError : null}
							apiKeyInputRef={apiKeyInputRef}
						/>
					)}
					{(scene === 's2' || scene === 's2-err') && (
						<StepTwo
							domain={domain}
							onDomainChange={setDomain}
							error={scene === 's2-err' ? connectError : null}
						/>
					)}
					{scene === 's3-loading' && <StepThreeLoading domain={domain} />}
					{scene === 's3-pending' && (
						<StepThreePending
							dnsRecords={dnsRecords}
							webhookUrl={webhookUrl}
							signingSecret={signingSecret}
							onSigningSecretChange={setSigningSecret}
							capabilities={prefill?.capabilities}
						/>
					)}
					{scene === 's3-root-mx' && (
						<StepThreeRootMx domain={domain} existingMxHost={existingMxHost} />
					)}
					{scene === 's3-partial' && (
						<StepThreePartial dnsRecords={dnsRecords} webhookUrl={webhookUrl} domain={domain} />
					)}
					{scene === 's4-done' && <StepFourDone domain={domain} workspaceId={workspaceId} />}
				</div>
				<div className="mt-4 flex items-center gap-2">
					<div className="flex-1">
						{isStep3Scene(scene) && scene !== 's4-done' && (
							<Button variant="ghost" onClick={closeAndReset}>
								Save and come back later
							</Button>
						)}
					</div>
					<div className="flex items-center gap-2">
						{(scene === 's1' || scene === 's1-err') && (
							<>
								<Button variant="ghost" onClick={closeAndReset}>
									Cancel
								</Button>
								<Button onClick={handleApiKeyNext} disabled={!apiKey.trim() || connect.isPending}>
									{scene === 's1-err' ? 'Try again' : 'Next'}
									<ArrowRight className="ml-1 h-3.5 w-3.5" />
								</Button>
							</>
						)}
						{(scene === 's2' || scene === 's2-err') && (
							<>
								<Button variant="ghost" onClick={() => setScene('s1')}>
									<ArrowLeft className="mr-1 h-3.5 w-3.5" />
									Back
								</Button>
								<Button
									onClick={handleDomainSubmit}
									disabled={!domain.trim() || dnsPrecheck.isPending || connect.isPending}
								>
									{scene === 's2-err' ? 'Try another domain' : 'Register domain'}
								</Button>
							</>
						)}
						{scene === 's3-loading' && <Button disabled>Registering…</Button>}
						{scene === 's3-pending' && (
							<Button
								onClick={handleComplete}
								disabled={!signingSecret.trim() || !isVerified(dnsRecords) || complete.isPending}
							>
								{isVerified(dnsRecords) ? 'Finish connecting' : 'Waiting on DNS…'}
							</Button>
						)}
						{scene === 's3-root-mx' && (
							<Button variant="outline" onClick={() => setScene('s2')}>
								<ArrowLeft className="mr-1 h-3.5 w-3.5" />
								Pick a subdomain
							</Button>
						)}
						{scene === 's4-done' && <Button onClick={closeAndReset}>Done</Button>}
					</div>
				</div>
			</DialogContent>
		</Dialog>
	)
}

function sceneToStep(scene: ResendConnectScene): number {
	if (scene === 's1' || scene === 's1-err') return 0
	if (scene === 's2' || scene === 's2-err') return 1
	if (scene === 's4-done') return 3
	return 2
}

function isStep3Scene(scene: ResendConnectScene): boolean {
	return (
		scene === 's3-loading' ||
		scene === 's3-pending' ||
		scene === 's3-root-mx' ||
		scene === 's3-partial'
	)
}

function isVerified(records: ResendDnsRecord[]): boolean {
	return records.length > 0 && records.every((r) => r.status === 'verified')
}

/** Prefill drives the reopened scene. If the row is already fully verified we
 *  land on Step 4 done; if sending is verified but receiving isn't, Step 3
 *  partial; otherwise Step 3 pending. */
function deriveResumeScene(prefill: ResendConnectPrefill): ResendConnectScene {
	if (prefill.verificationStatus === 'verified') return 's4-done'
	const sendingVerified = prefill.capabilities?.sending === 'verified'
	const receivingVerified = prefill.capabilities?.receiving === 'verified'
	if (sendingVerified && !receivingVerified) return 's3-partial'
	return 's3-pending'
}

function parseConnectError(err: unknown): {
	code:
		| 'INVALID_API_KEY'
		| 'DOMAIN_ALREADY_CLAIMED'
		| 'BARE_DOMAIN_HAS_MAIL'
		| 'INVALID_DOMAIN'
		| 'UNKNOWN'
	message?: string
} {
	if (typeof err === 'object' && err !== null) {
		const anyErr = err as {
			code?: string
			message?: string
			resend_error?: string
			status?: number
			fieldErrors?: Record<string, string[]>
		}
		// The server puts these two codes in error.details; ApiError exposes
		// them as fieldErrors.code while err.code stays the generic BAD_REQUEST.
		const detailCode = anyErr.fieldErrors?.code?.[0]
		if (detailCode === 'BARE_DOMAIN_HAS_MAIL' || detailCode === 'INVALID_DOMAIN') {
			return { code: detailCode }
		}
		if (anyErr.code === 'INVALID_API_KEY') {
			return {
				code: 'INVALID_API_KEY',
				message: anyErr.status
					? `${anyErr.status} ${anyErr.resend_error ?? 'invalid_api_key'}`
					: undefined,
			}
		}
		if (anyErr.code === 'DOMAIN_ALREADY_CLAIMED') {
			return { code: 'DOMAIN_ALREADY_CLAIMED' }
		}
		if (anyErr.message?.toLowerCase().includes('domain')) {
			return { code: 'DOMAIN_ALREADY_CLAIMED' }
		}
	}
	return { code: 'UNKNOWN' }
}

function titleForScene(scene: ResendConnectScene, domain: string): string {
	switch (scene) {
		case 's1':
		case 's1-err':
			return 'Connect Resend'
		case 's2':
		case 's2-err':
			return 'Which domain will your agents send from?'
		case 's3-loading':
			return `Registering ${domain || 'your domain'}…`
		case 's3-root-mx':
			return `Wait — ${domain || 'this domain'} looks like your human inbox`
		case 's3-partial':
			return 'Almost there — MX still missing'
		case 's3-pending':
			return 'Verify DNS + finish the webhook'
		case 's4-done':
			return 'Resend is connected'
	}
}

function descriptionForScene(scene: ResendConnectScene, domain: string): string {
	switch (scene) {
		case 's1':
		case 's1-err':
			return 'Your workspace connects its own Resend account. Send and receive belong to this workspace, not to you.'
		case 's2':
		case 's2-err':
			return 'Pick a subdomain of a domain you own. Your agents will send from *@that-domain and receive there.'
		case 's3-loading':
			return 'Asking Resend to mint sending + receiving keys for this domain.'
		case 's3-root-mx':
			return 'We checked your DNS before you copy anything. Adding these records here would break the mail you and your team read today.'
		case 's3-partial':
			return 'Sending is verified. Agents can send from this domain right now. Receiving needs the MX record.'
		case 's3-pending':
			return 'Add the DNS records to your registrar, add the webhook inside Resend, and paste the signing secret Resend gives you.'
		case 's4-done':
			return `Your workspace can now send from and receive on ${domain || 'your domain'}.`
	}
}

function StepOne({
	apiKey,
	onApiKeyChange,
	error,
	apiKeyInputRef,
}: {
	apiKey: string
	onApiKeyChange: (v: string) => void
	error: { code: string; message?: string } | null
	apiKeyInputRef: React.RefObject<HTMLInputElement | null>
}) {
	return (
		<div className="space-y-4">
			<div className="rounded-md border border-sig/40 bg-sig-tint p-3">
				<div className="flex gap-2">
					<Info className="mt-0.5 h-4 w-4 shrink-0 text-sig-ink" aria-hidden="true" />
					<p className="text-xs text-sig-ink">
						Create a key in your Resend dashboard under <strong>API Keys → Create</strong>. Give it{' '}
						<strong>Full access</strong> — the agent needs to both send mail and fetch inbound
						bodies.{' '}
						<a
							href="https://resend.com/api-keys"
							target="_blank"
							rel="noreferrer"
							className="underline underline-offset-2 hover:text-foreground"
						>
							Where to find it →
						</a>
					</p>
				</div>
			</div>
			<div className="space-y-2">
				<Label htmlFor="resend-api-key">Resend API key</Label>
				<Input
					ref={apiKeyInputRef}
					id="resend-api-key"
					type="password"
					value={apiKey}
					onChange={(e) => onApiKeyChange(e.target.value)}
					placeholder="re_XXXXXXXXXXXXXXXXXXXX"
					aria-invalid={!!error}
					className={cn(error && 'border-error')}
				/>
				<p className="text-xs text-muted-foreground">
					{error
						? 'Resend rejected this key.'
						: 'Encrypted and stored per workspace. Only agents running in this workspace can read it.'}
				</p>
			</div>
			{error && (
				<div
					role="alert"
					className="rounded-md border border-error bg-error/5 p-3 text-xs text-error"
				>
					<p className="font-medium">Resend rejected that key.</p>
					<p className="mt-1">
						The API returned {error.message ?? 'an unknown error'}. Check the key was copied whole
						(they start with re_) and that it has not been revoked.{' '}
						<a
							href="https://resend.com/api-keys"
							target="_blank"
							rel="noreferrer"
							className="underline underline-offset-2"
						>
							Get a fresh key →
						</a>
					</p>
				</div>
			)}
		</div>
	)
}

function StepTwo({
	domain,
	onDomainChange,
	error,
}: {
	domain: string
	onDomainChange: (v: string) => void
	error: { code: string } | null
}) {
	return (
		<div className="space-y-4">
			<div className="space-y-2">
				<Label htmlFor="resend-domain">Receiving domain</Label>
				<Input
					id="resend-domain"
					type="text"
					value={domain}
					onChange={(e) => onDomainChange(e.target.value)}
					placeholder="mail.example.com"
					aria-invalid={!!error}
					className={cn('font-mono', error && 'border-error')}
				/>
				<p className="text-xs text-muted-foreground">
					<strong>Use a subdomain</strong> like mail. or agents., not your bare domain — the MX
					record we ask for takes over inbound mail for whatever you enter here.
				</p>
			</div>
			<div className="rounded-md border border-sig/40 bg-sig-tint p-3">
				<div className="flex gap-2">
					<Info className="mt-0.5 h-4 w-4 shrink-0 text-sig-ink" aria-hidden="true" />
					<div className="text-xs text-sig-ink">
						<p className="font-medium">Why a subdomain.</p>
						<p className="mt-1">
							If your root domain already carries human mail (Gmail, Workspace, iCloud), adding the
							MX record we need there would break it. A subdomain isolates the agents cleanly.
							Maskin runs its own agents on mail.maskin.io the same way — no special case.
						</p>
					</div>
				</div>
			</div>
			{error?.code === 'BARE_DOMAIN_HAS_MAIL' && (
				<div
					role="alert"
					className="rounded-md border border-error bg-error/5 p-3 text-xs text-error"
				>
					<p className="font-medium">That domain already receives mail.</p>
					<p className="mt-1">
						Registering it here would reroute everyone&apos;s mail on it. Use a dedicated subdomain
						instead, such as mail.example.com.
					</p>
				</div>
			)}
			{error?.code === 'INVALID_DOMAIN' && (
				<div
					role="alert"
					className="rounded-md border border-error bg-error/5 p-3 text-xs text-error"
				>
					<p className="font-medium">That doesn&apos;t look like a valid domain.</p>
					<p className="mt-1">Enter a hostname such as mail.example.com.</p>
				</div>
			)}
			{error?.code === 'DOMAIN_ALREADY_CLAIMED' && (
				<div
					role="alert"
					className="rounded-md border border-error bg-error/5 p-3 text-xs text-error"
				>
					<p className="font-medium">That domain is already connected somewhere else.</p>
					<p className="mt-1">
						Resend refuses to add the same domain twice. If it belongs to your organisation but sits
						on a different Resend account, delete it there first and register it here — one Maskin
						workspace, one Resend account.
					</p>
				</div>
			)}
		</div>
	)
}

function StepThreeLoading({ domain }: { domain: string }) {
	return (
		<div className="space-y-4">
			<div className="space-y-2">
				{[0, 1, 2].map((i) => (
					<div
						key={i}
						className="h-11 rounded-md border border-border bg-muted animate-pulse motion-reduce:animate-none"
					/>
				))}
			</div>
			<p className="text-xs text-muted-foreground">
				Usually 2–3 seconds. Do not close this window.
			</p>
			<span className="sr-only">Registering {domain}. Please wait.</span>
		</div>
	)
}

function StepThreePending({
	dnsRecords,
	webhookUrl,
	signingSecret,
	onSigningSecretChange,
	capabilities: _capabilities,
}: {
	dnsRecords: ResendDnsRecord[]
	webhookUrl: string
	signingSecret: string
	onSigningSecretChange: (v: string) => void
	capabilities?: { sending?: string; receiving?: string }
}) {
	const pendingCount = dnsRecords.filter((r) => r.status !== 'verified').length
	return (
		<div className="space-y-5">
			<div className="space-y-3">
				<div className="flex items-start justify-between gap-3">
					<div>
						<p className="text-[8px] font-bold tracking-[0.11em] uppercase text-muted-foreground font-mono">
							1 · ADD THREE RECORDS TO YOUR DNS
						</p>
						<p className="mt-1 text-xs text-muted-foreground">
							SPF + DKIM let agents send from your domain. MX lets them receive.
						</p>
					</div>
					<CopyAllAsZoneFileButton records={dnsRecords} />
				</div>
				<div className="space-y-2" aria-live="polite">
					{dnsRecords.map((record, index) => (
						<DnsRecordRow key={`${record.record}-${index}`} record={record} />
					))}
				</div>
			</div>

			<div className="space-y-3 border-t border-border pt-4">
				<div>
					<p className="text-[8px] font-bold tracking-[0.11em] uppercase text-muted-foreground font-mono">
						2 · ADD THIS WEBHOOK INSIDE RESEND
					</p>
					<p className="mt-1 text-xs text-muted-foreground">
						In your Resend dashboard: <strong>Webhooks → Add Endpoint</strong>. Subscribe to
						email.received.
					</p>
				</div>
				<WebhookUrlTrough url={webhookUrl} />
				<div className="space-y-2">
					<Label htmlFor="resend-signing-secret">Webhook signing secret</Label>
					<Input
						id="resend-signing-secret"
						type="password"
						value={signingSecret}
						onChange={(e) => onSigningSecretChange(e.target.value)}
						placeholder="whsec_XXXXXXXXXXXXXXXXXXXXXXXXXXXX"
					/>
					<p className="text-xs text-muted-foreground">
						Paste the whsec_… secret Resend shows after you create the endpoint. Used to verify
						every inbound message.
					</p>
				</div>
			</div>

			<PollStrip pendingCount={pendingCount} />
		</div>
	)
}

function DnsRecordRow({ record }: { record: ResendDnsRecord }) {
	const [copied, setCopied] = useState(false)
	const label = record.record
	const caption = captionForRecord(label)
	const handleCopy = () => {
		navigator.clipboard.writeText(record.value)
		setCopied(true)
		setTimeout(() => setCopied(false), 2000)
	}
	return (
		<div
			className={cn(
				'grid grid-cols-[22px_60px_1fr_40px] items-center gap-3 rounded-md border p-3',
				record.status === 'failed' ? 'border-error bg-error/5' : 'border-border bg-bg-surface',
			)}
		>
			<StatusDot status={record.status} recordType={label} />
			<span className="text-xs font-mono font-semibold uppercase text-foreground">{label}</span>
			<div className="min-w-0">
				<p className="truncate text-xs font-mono text-foreground" title={record.value}>
					{record.value}
				</p>
				<p className="mt-0.5 text-[11px] text-muted-foreground">
					<strong>{caption.prefix}</strong> {caption.rest}
				</p>
			</div>
			<Button
				variant="secondary"
				size="sm"
				className="h-8 w-8 p-0"
				onClick={handleCopy}
				aria-label={`Copy ${label} value`}
				title={`Copy ${label} value`}
			>
				{copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
			</Button>
			{copied && (
				<span className="sr-only" aria-live="assertive">
					Copied
				</span>
			)}
		</div>
	)
}

function captionForRecord(record: 'SPF' | 'DKIM' | 'MX'): { prefix: string; rest: string } {
	switch (record) {
		case 'SPF':
			return {
				prefix: 'Sending half.',
				rest: 'Tells recipients that mail from your domain via Resend is legitimate.',
			}
		case 'DKIM':
			return {
				prefix: 'Sending half.',
				rest: "Signs each outgoing message so it isn't spoofable.",
			}
		case 'MX':
			return {
				prefix: 'Receiving half.',
				rest: 'Routes inbound mail on this domain to Resend, which forwards it here as an event.',
			}
	}
}

function CopyAllAsZoneFileButton({ records }: { records: ResendDnsRecord[] }) {
	const [copied, setCopied] = useState(false)
	const handleCopy = () => {
		const lines = records.map((r) => {
			const ttl = 3600
			if (r.type === 'MX') {
				return `${r.name}. ${ttl} IN MX ${r.priority ?? 10} ${r.value}.`
			}
			if (r.type === 'CNAME') {
				return `${r.name}. ${ttl} IN CNAME ${r.value}.`
			}
			return `${r.name}. ${ttl} IN TXT "${r.value}"`
		})
		navigator.clipboard.writeText(lines.join('\n'))
		setCopied(true)
		setTimeout(() => setCopied(false), 2000)
	}
	return (
		<Button
			variant="outline"
			size="sm"
			className="shrink-0"
			onClick={handleCopy}
			aria-label="Copy all DNS records as a zone file"
		>
			{copied ? <Check className="mr-1 h-3.5 w-3.5" /> : <Copy className="mr-1 h-3.5 w-3.5" />}
			Copy all as zone file
		</Button>
	)
}

function StatusDot({
	status,
	recordType,
}: {
	status: 'pending' | 'verified' | 'failed'
	recordType: string
}) {
	const label =
		status === 'verified'
			? `${recordType} verified`
			: status === 'failed'
				? `${recordType} verification failed`
				: `${recordType} not verified yet`
	if (status === 'verified') {
		return (
			<span
				className="inline-flex h-3 w-3 items-center justify-center rounded-full bg-success"
				aria-label={label}
				title={label}
			>
				<Check className="h-2 w-2 text-white" aria-hidden="true" />
			</span>
		)
	}
	if (status === 'failed') {
		return (
			<span
				className="inline-block h-3 w-3 rounded-full bg-error"
				aria-label={label}
				title={label}
			/>
		)
	}
	return (
		<span
			className="inline-block h-3 w-3 rounded-full bg-warning animate-pulse motion-reduce:animate-none"
			aria-label={label}
			title={label}
		/>
	)
}

function WebhookUrlTrough({ url }: { url: string }) {
	const [copied, setCopied] = useState(false)
	const [showAmberDot, setShowAmberDot] = useState(false)
	const handleCopy = () => {
		navigator.clipboard.writeText(url)
		setCopied(true)
		setTimeout(() => {
			setCopied(false)
			setShowAmberDot(true)
			setTimeout(() => setShowAmberDot(false), 30000)
		}, 2000)
	}
	return (
		<div className="space-y-1.5">
			<div className="flex gap-2">
				<div className="min-w-0 flex-1 rounded-md border border-border bg-bg-surface px-3 py-2 font-mono text-xs break-all select-all">
					{url}
				</div>
				<Button
					variant="secondary"
					size="sm"
					className="shrink-0 relative"
					onClick={handleCopy}
					aria-label="Copy webhook URL value"
				>
					{copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
					<span>Copy URL</span>
					{showAmberDot && (
						<span
							className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-warning"
							aria-hidden="true"
						/>
					)}
				</Button>
			</div>
			<p className="text-[11px] text-muted-foreground">
				<strong>Webhook URL — treat this like a password.</strong> Anyone who has it can push events
				onto your workspace.
			</p>
		</div>
	)
}

function PollStrip({ pendingCount }: { pendingCount: number }) {
	const [lastCheckedAt] = useState(() => Date.now())
	const [now, setNow] = useState(() => Date.now())
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), 1000)
		return () => clearInterval(timer)
	}, [])
	const elapsed = Math.floor((now - lastCheckedAt) / 1000)
	const mm = String(Math.floor(elapsed / 60)).padStart(2, '0')
	const ss = String(elapsed % 60).padStart(2, '0')
	return (
		<div className="flex items-center gap-2 rounded-md border border-border bg-muted/50 p-2.5 text-xs">
			<span className="h-1.5 w-1.5 shrink-0 rounded-full bg-warning animate-pulse motion-reduce:animate-none" />
			<span className="flex-1 text-muted-foreground">
				<strong className="text-foreground">Checking every 15 seconds.</strong> Waiting on{' '}
				{pendingCount} record{pendingCount === 1 ? '' : 's'}.{' '}
				<span aria-live="polite">
					last checked {mm}:{ss} ago
				</span>
			</span>
			<Button variant="ghost" size="sm" className="h-6 text-xs">
				Check now
			</Button>
		</div>
	)
}

function StepThreeRootMx({
	domain,
	existingMxHost,
}: {
	domain: string
	existingMxHost: string | null
}) {
	const mxHostLabel = existingMxHost ?? 'another provider'
	return (
		<div className="space-y-4">
			<div
				role="alert"
				className="rounded-md border border-warning bg-warning/5 p-4 text-xs text-foreground"
			>
				<div className="flex gap-2">
					<AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
					<div className="space-y-2">
						<p>
							<strong>
								{domain || 'this domain'} already routes mail via {mxHostLabel}.
							</strong>{' '}
							The MX record for the agent inbox will replace that one and inbound to <em>every</em>{' '}
							address on your domain — including yours — will start arriving here instead of{' '}
							{mxHostLabel}. Almost nobody wants that.
						</p>
						<p>
							Use a subdomain like mail.{domain || 'your-domain.com'} or agents.
							{domain || 'your-domain.com'} and only that subdomain&apos;s mail comes here; your
							human mail keeps flowing.
						</p>
					</div>
				</div>
			</div>
		</div>
	)
}

function StepThreePartial({
	dnsRecords,
	webhookUrl,
	domain,
}: {
	dnsRecords: ResendDnsRecord[]
	webhookUrl: string
	domain: string
}) {
	return (
		<div className="space-y-4">
			<div
				role="alert"
				className="rounded-md border border-warning bg-warning/5 p-3 text-xs text-foreground"
			>
				<div className="flex gap-2">
					<AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
					<div>
						<p>
							<strong>MX not visible yet.</strong> DNS says no MX record at{' '}
							<strong>{domain || 'your domain'}</strong>. Double-check the priority is 10 and the
							value has no trailing dot in your registrar&apos;s UI (Cloudflare adds one
							automatically, GoDaddy asks you to add it — either can trip you up).
						</p>
					</div>
				</div>
			</div>
			<div className="space-y-2" aria-live="polite">
				{dnsRecords.map((record, index) => (
					<DnsRecordRow key={`${record.record}-${index}`} record={record} />
				))}
			</div>
			<WebhookUrlTrough url={webhookUrl} />
		</div>
	)
}

function StepFourDone({ domain, workspaceId }: { domain: string; workspaceId: string }) {
	return (
		<div className="space-y-4">
			<div className="rounded-md border border-success bg-success/5 p-4">
				<div className="flex gap-2">
					<Check className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden="true" />
					<div>
						<p className="text-sm font-semibold text-foreground">All records verified</p>
						<p className="mt-1 text-xs text-muted-foreground">
							SPF, DKIM, and MX all resolve. The webhook is signed and receiving.
						</p>
					</div>
				</div>
			</div>
			<div className="rounded-md border border-border bg-bg-surface p-3 text-xs text-foreground">
				<p>
					<strong>What agents can do now:</strong> Send from any *@{domain} address. Receive on any
					*@{domain} address — inbound arrives as an event within seconds.
				</p>
			</div>
			<div className="grid gap-3 md:grid-cols-2">
				<a
					href={`/${workspaceId}/settings/actors`}
					className="rounded-md border border-border bg-card p-3 hover:border-border-strong transition-colors"
				>
					<p className="text-sm font-medium text-foreground">Give your agents email addresses</p>
					<p className="mt-1 text-xs text-muted-foreground">
						Assign an address to each agent in{' '}
						<strong>Actors → &lt;agent&gt; → Email surfaces</strong>. That&apos;s what makes inbound
						mail actually reach one.
					</p>
					<p className="mt-2 text-xs text-foreground underline underline-offset-2">Open Actors →</p>
				</a>
				<a
					href={`/${workspaceId}/triggers`}
					className="rounded-md border border-border bg-card p-3 hover:border-border-strong transition-colors"
				>
					<p className="text-sm font-medium text-foreground">Wire an email trigger</p>
					<p className="mt-1 text-xs text-muted-foreground">
						Point a loop or a trigger at email.received — for example, the outbound-sales loop can
						now wake within seconds of a reply.
					</p>
					<p className="mt-2 text-xs text-foreground underline underline-offset-2">New trigger →</p>
				</a>
			</div>
			<p className="text-[11px] text-muted-foreground">
				Connected 2 minutes ago · Workspace credential
			</p>
		</div>
	)
}
