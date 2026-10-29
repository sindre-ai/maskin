import { InlineScopePicker, type ScopeAgent } from '@/components/chat/inline-scope-picker'
import { VaultedCard, type VaultedPhase } from '@/components/chat/secret-detected-card'
import { TranscriptRedactedRow } from '@/components/chat/transcript-redacted-row'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useActors } from '@/hooks/use-actors'
import { type RelaunchWatch, useRelaunchProgress } from '@/hooks/use-relaunch-progress'
import { useActiveSessionsForConversation } from '@/hooks/use-sessions'
import { ApiError, api } from '@/lib/api'
import { pauseClientErrorLogging } from '@/lib/client-logging-pause'
import { queryKeys } from '@/lib/query-keys'
import {
	byoApiKeyEnvVar,
	checkCredentialName,
	credentialNameMessage,
	findHighConfidenceSecret,
	manualRedactionMarker,
} from '@maskin/shared'
import { useQueryClient } from '@tanstack/react-query'
import { Lock } from 'lucide-react'
import {
	type KeyboardEvent,
	type MutableRefObject,
	useCallback,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from 'react'

/** The character that opens vault mode when it is the first thing in an empty composer. */
export const VAULT_PREFIX = '!'

/**
 * What the composer does with text arriving in an empty composer: a string that
 * starts with the prefix and has no whitespace opens vault mode, and the rest is the
 * secret. A trailing newline from a copied terminal line is dropped; whitespace
 * anywhere else, or a leading space, means ordinary text.
 */
export function vaultSeedFrom(text: string): string | null {
	const trimmed = text.trimEnd()
	if (!trimmed.startsWith(VAULT_PREFIX) || /\s/.test(trimmed)) return null
	return trimmed.slice(VAULT_PREFIX.length)
}

type Stage = 'field' | 'scope'

interface VaultRecord {
	integrationId: string
	name: string
	agentCount: number
	marker: string
	undoExpiresAt: number
	phase: VaultedPhase
	/** False when the session that held the key could not be stopped on undo. */
	sessionEnded: boolean
}

export interface VaultPrefixFlowProps {
	workspaceId: string
	/**
	 * What came after the prefix when it arrived with a paste. Read once on mount and
	 * emptied, so the composer never holds the secret in state.
	 */
	seedRef: MutableRefObject<string>
	/** The live session to vault into. Null when this composer has none. */
	capture: { sessionId: string; conversationId?: string; agent: ScopeAgent } | null
	/** The conversation has no running session, or one that is still coming up. */
	unavailable: boolean
	agentName: string
	/** Sends the transcript marker. */
	onSend: (content: string) => Promise<void>
	/** Leave vault mode with nothing vaulted. The field is already cleared. */
	onLeave: () => void
	/** The decision is made. keepReceipts: the vaulted card (with Undo) stays on screen. */
	onDone: (keepReceipts: boolean) => void
}

/**
 * Vault mode (SPEC state 7e): the user said "vault this" with the prefix, so nothing
 * is detected and the detect card is skipped. A masked field, then the scope step
 * with a required Service, then the same vaulted receipt as a detected key.
 *
 * The secret lives in a ref and in the field's own DOM value, never in React state, the
 * composer's value, the draft mirror or storage. It is cleared when the vault succeeds,
 * on cancel and on unmount. Client error reporting is paused for as long as it is held.
 * Enter never vaults: in the field it opens the scope step, and only that step's primary
 * button writes anything.
 */
export function VaultPrefixFlow({
	workspaceId,
	seedRef,
	capture,
	unavailable,
	agentName,
	onSend,
	onLeave,
	onDone,
}: VaultPrefixFlowProps) {
	const queryClient = useQueryClient()
	const helperId = useId()
	const inputRef = useRef<HTMLInputElement>(null)
	const secretRef = useRef('')
	const [filled, setFilled] = useState(false)
	const [show, setShow] = useState(false)
	const [stage, setStage] = useState<Stage>('field')
	const [name, setName] = useState('')
	const [service, setService] = useState('')
	const [selected, setSelected] = useState<Set<string>>(
		() => new Set(capture ? [capture.agent.id] : []),
	)
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [finished, setFinished] = useState(false)
	const [sendError, setSendError] = useState<string | null>(null)
	const [vaults, setVaults] = useState<VaultRecord[]>([])
	const [undoingId, setUndoingId] = useState<string | null>(null)
	const [retryingId, setRetryingId] = useState<string | null>(null)
	const [cardError, setCardError] = useState<string | null>(null)
	const [now, setNow] = useState(() => Date.now())
	// Vaulting stops the session this flow was opened for, so the live capture target goes
	// away mid-flow. The relaunch watch keeps the last one it saw.
	const lastCapture = useRef(capture)
	if (capture) lastCapture.current = capture
	// The redacted marker of a vault whose relaunch failed. It is held back until Retry
	// stops the old session, because the message is what respawns it.
	const withheld = useRef<string | null>(null)
	const [watch, setWatch] = useState<(RelaunchWatch & { integrationId: string }) | null>(null)
	const { data: conversationSessions } = useActiveSessionsForConversation(
		workspaceId,
		capture?.conversationId ?? null,
	)
	const progress = useRelaunchProgress(workspaceId, watch)
	// Every session the conversation has right now, and the same set frozen when the vault
	// (or Retry) went out. A relaunch is watched for the session that is not in the frozen one.
	const sessionIds = useMemo(
		() => new Set((conversationSessions ?? []).map((x) => x.id)),
		[conversationSessions],
	)
	const sessionIdsNow = useRef<ReadonlySet<string>>(sessionIds)
	sessionIdsNow.current = sessionIds
	const sessionIdsAtRelaunch = useRef<ReadonlySet<string>>(new Set())

	const { data: actors } = useActors(workspaceId, { enabled: !!capture })
	const otherAgents = useMemo(
		() =>
			(actors ?? [])
				.filter((a) => a.type === 'agent' && a.id !== capture?.agent.id)
				.map((a) => ({ id: a.id, name: a.name })),
		[actors, capture?.agent.id],
	)

	const clearSecret = useCallback(() => {
		secretRef.current = ''
		if (inputRef.current) inputRef.current.value = ''
		setFilled(false)
		setShow(false)
	}, [])

	// Takes the pasted secret out of the seed and into the field, and makes sure it is
	// gone from both when this unmounts. React's dev-only strict mode unmounts and
	// remounts straight away, so the clearing waits a tick to tell that from a real
	// unmount; the seed itself is already consumed by then and must survive it.
	const mountedRef = useRef(false)
	useEffect(() => {
		mountedRef.current = true
		const input = inputRef.current
		if (seedRef.current !== '') {
			secretRef.current = seedRef.current
			seedRef.current = ''
			if (input) input.value = secretRef.current
			setFilled(secretRef.current.trim().length > 0)
		}
		input?.focus()
		return () => {
			mountedRef.current = false
			setTimeout(() => {
				if (mountedRef.current) return
				secretRef.current = ''
				seedRef.current = ''
				if (input) input.value = ''
			}, 0)
		}
	}, [seedRef])

	// Client error reporting stays off for as long as the secret can be in the field.
	useEffect(() => {
		if (finished) return
		return pauseClientErrorLogging()
	}, [finished])

	// Ticks only while an undo window is open, so the button disappears on time.
	const nextExpiry = Math.max(
		0,
		...vaults.filter((v) => v.phase !== 'undone').map((v) => v.undoExpiresAt),
	)
	useEffect(() => {
		if (nextExpiry <= Date.now()) return
		const t = setInterval(() => setNow(Date.now()), 1000)
		return () => clearInterval(t)
	}, [nextExpiry])

	const clearResuming = useCallback((integrationId: string) => {
		setWatch((w) => (w?.integrationId === integrationId ? null : w))
		setVaults((prev) =>
			prev.map((v) =>
				v.integrationId === integrationId && v.phase === 'resuming' ? { ...v, phase: 'live' } : v,
			),
		)
	}, [])
	useEffect(() => {
		if (progress && watch) clearResuming(watch.integrationId)
	}, [progress, watch, clearResuming])

	/** The marker message is out and the old session is gone: the new session is on its way. */
	const startResuming = useCallback((integrationId: string) => {
		setVaults((prev) =>
			prev.map((v) => (v.integrationId === integrationId ? { ...v, phase: 'resuming' } : v)),
		)
		const target = lastCapture.current
		if (!target?.conversationId) return
		setWatch({
			integrationId,
			conversationId: target.conversationId,
			agentId: target.agent.id,
			knownSessionIds: sessionIdsAtRelaunch.current,
		})
	}, [])

	const cancel = useCallback(() => {
		clearSecret()
		onLeave()
	}, [clearSecret, onLeave])

	const trimmedName = name.trim()
	const nameProblem = trimmedName ? checkCredentialName(trimmedName) : null
	const nameError = nameProblem ? credentialNameMessage(nameProblem) : null
	const trimmedService = service.trim()
	const serviceError =
		trimmedService && findHighConfidenceSecret(trimmedService)
			? "That looks like a secret. Use the service's plain name."
			: null
	const envVar = trimmedName && !nameProblem ? byoApiKeyEnvVar(trimmedName) : null

	const vault = useCallback(
		async (grants: 'selected' | 'none') => {
			const secret = secretRef.current.trim()
			if (!capture || !secret || unavailable) return
			setBusy(true)
			setError(null)
			sessionIdsAtRelaunch.current = sessionIdsNow.current
			let res: Awaited<ReturnType<typeof api.integrations.chatCapture>>
			try {
				res = await api.integrations.chatCapture(workspaceId, {
					sessionId: capture.sessionId,
					providerMode: 'byo_apikey',
					detectedProvider: 'manual',
					displayName: trimmedName,
					rawSecret: secret,
					agentIds: grants === 'none' ? [] : [...selected],
				})
			} catch (err) {
				// The field keeps the secret so the user can fix the name and press again.
				setError(
					err instanceof ApiError
						? `Couldn't vault — ${err.message.replace(/\.$/, '')}. Retry, or cancel the message.`
						: "Couldn't vault. Retry, or cancel the message.",
				)
				setBusy(false)
				return
			}
			// Vaulted: the secret has done its job, so it goes before anything else happens.
			clearSecret()
			queryClient.invalidateQueries({ queryKey: queryKeys.integrations.all(workspaceId) })
			const marker = manualRedactionMarker(trimmedName)
			setVaults((prev) => [
				...prev,
				{
					integrationId: res.integrationId,
					name: trimmedName,
					agentCount: grants === 'none' ? 0 : selected.size,
					marker,
					undoExpiresAt: res.undoExpiresAt ? new Date(res.undoExpiresAt).getTime() : 0,
					phase: res.relaunch === 'failed' ? 'failed' : 'live',
					sessionEnded: true,
				},
			])
			if (res.relaunch === 'failed') {
				// The old session is still running without the key. The message is what
				// respawns a session, so hold it until Retry has stopped the old one.
				withheld.current = marker
				setBusy(false)
				setFinished(true)
				onDone(true)
				return
			}
			let sent = true
			try {
				await onSend(marker)
			} catch (err) {
				sent = false
				setSendError(
					err instanceof Error
						? `Saved, but the message didn't send: ${err.message}`
						: 'Saved, but the message did not send.',
				)
			}
			setBusy(false)
			setFinished(true)
			onDone(true)
			if (sent) startResuming(res.integrationId)
		},
		[
			capture,
			unavailable,
			workspaceId,
			trimmedName,
			selected,
			clearSecret,
			queryClient,
			onSend,
			onDone,
			startResuming,
		],
	)

	const undo = useCallback(
		async (record: VaultRecord) => {
			setUndoingId(record.integrationId)
			setCardError(null)
			try {
				const res = await api.integrations.undo(record.integrationId, workspaceId)
				withheld.current = null
				setWatch((w) => (w?.integrationId === record.integrationId ? null : w))
				setVaults((prev) =>
					prev.map((v) =>
						v.integrationId === record.integrationId
							? { ...v, phase: 'undone', sessionEnded: res.sessionEnded }
							: v,
					),
				)
				queryClient.invalidateQueries({ queryKey: queryKeys.integrations.all(workspaceId) })
			} catch {
				setCardError("Couldn't undo. The undo window has closed.")
			} finally {
				setUndoingId(null)
			}
		},
		[queryClient, workspaceId],
	)

	/** Retry on 7c-3: repeat stop and wait; on success send the held marker, which respawns. */
	const retry = useCallback(
		async (record: VaultRecord) => {
			setRetryingId(record.integrationId)
			setCardError(null)
			sessionIdsAtRelaunch.current = sessionIdsNow.current
			try {
				const res = await api.integrations.relaunch(record.integrationId, workspaceId)
				if (res.relaunch === 'failed') return
				const body = withheld.current
				if (body === null) {
					setVaults((prev) =>
						prev.map((v) =>
							v.integrationId === record.integrationId ? { ...v, phase: 'live' } : v,
						),
					)
					return
				}
				try {
					await onSend(body)
				} catch (err) {
					setSendError(
						err instanceof Error
							? `Saved, but the message didn't send: ${err.message}`
							: 'Saved, but the message did not send.',
					)
					return
				}
				withheld.current = null
				startResuming(record.integrationId)
			} catch {
				// Same state as a failed stop: the line stays and Retry is offered again.
			} finally {
				setRetryingId(null)
			}
		},
		[workspaceId, onSend, startResuming],
	)

	const toggle = useCallback((id: string) => {
		setSelected((prev) => {
			const next = new Set(prev)
			if (next.has(id)) next.delete(id)
			else next.add(id)
			return next
		})
	}, [])

	const vaultedCards = vaults.map((v) => (
		<div key={v.integrationId} className="flex flex-col gap-2">
			<TranscriptRedactedRow marker={v.marker} />
			<VaultedCard
				credentialName={v.name}
				workspaceId={workspaceId}
				integrationId={v.integrationId}
				agentCount={v.agentCount}
				agentName={agentName}
				phase={v.phase}
				undoAvailable={v.undoExpiresAt > now}
				undoing={undoingId === v.integrationId}
				retrying={retryingId === v.integrationId}
				sessionEnded={v.sessionEnded}
				error={cardError}
				onUndo={() => undo(v)}
				onRetry={() => retry(v)}
			/>
		</div>
	))

	if (finished) {
		return (
			<div className="flex flex-col gap-2">
				{vaultedCards}
				{sendError ? (
					<p
						role="alert"
						className="rounded-md border border-error/40 bg-error/10 px-3 py-2 text-xs text-error"
					>
						{sendError}
					</p>
				) : null}
			</div>
		)
	}

	// Esc anywhere in vault mode leaves it and clears the field. It never sends.
	const handleEscape = (e: KeyboardEvent<HTMLDivElement>) => {
		if (e.key !== 'Escape' || busy) return
		e.preventDefault()
		cancel()
	}

	const handleFieldKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
		if (e.nativeEvent.isComposing) return
		if (e.key === 'Enter') {
			// Never sends and never vaults. A filled field moves on to the scope step.
			e.preventDefault()
			if (filled && !unavailable) setStage('scope')
			return
		}
		if (e.key === 'Backspace' && secretRef.current === '') {
			// Removes the chip: back to the normal composer.
			e.preventDefault()
			cancel()
		}
	}

	const helper = unavailable
		? `Messages still send. Vaulting another secret waits until ${agentName} is back.`
		: filled
			? `Vault mode. This goes to your Keychain, not to ${agentName}. Esc to leave.`
			: 'Nothing after the prefix yet. Paste a secret to vault it, or press Esc to type a normal message.'

	return (
		<div className="flex flex-col gap-2" onKeyDown={handleEscape}>
			{vaultedCards}
			<div className={stage === 'field' ? 'flex flex-wrap items-center gap-2' : 'hidden'}>
				{/* Visual order is chip, Show, Vault, then the field; DOM order is the focus
				    order (field, Show, Vault), so the layout reorders with flex order. */}
				<span className="order-1 inline-flex items-center gap-1 rounded-full border border-brand/40 bg-brand/10 px-2 py-0.5 text-xs font-semibold text-brand">
					<Lock size={12} aria-hidden />
					<span>{VAULT_PREFIX} Vault</span>
				</span>
				<Input
					ref={inputRef}
					type={show ? 'text' : 'password'}
					autoComplete="off"
					autoCorrect="off"
					autoCapitalize="off"
					spellCheck={false}
					data-1p-ignore
					data-lpignore="true"
					aria-label="Secret to vault"
					aria-describedby={helperId}
					placeholder={`Paste the secret. It goes to your Keychain, not to ${agentName}.`}
					className="order-4 basis-full"
					onChange={(e) => {
						secretRef.current = e.target.value
						setFilled(e.target.value.trim().length > 0)
					}}
					onKeyDown={handleFieldKeyDown}
					onBlur={() => setShow(false)}
				/>
				<Button
					type="button"
					variant="ghost"
					size="sm"
					className="order-2 ml-auto"
					aria-pressed={show}
					// Keeps focus in the field, so the click does not trip the blur that re-masks it.
					onMouseDown={(e) => e.preventDefault()}
					onClick={() => setShow((v) => !v)}
				>
					{show ? 'Hide' : 'Show'}
				</Button>
				<Button
					type="button"
					size="sm"
					className="order-3"
					disabled={!filled || unavailable}
					onClick={() => setStage('scope')}
				>
					Vault →
				</Button>
			</div>
			{stage === 'field' ? (
				<p id={helperId} className="text-xs text-muted-foreground">
					<span aria-hidden>{filled && !unavailable ? '🔒 ' : ''}</span>
					{helper}
				</p>
			) : null}
			{stage === 'scope' && capture ? (
				<InlineScopePicker
					credentialName={name}
					onCredentialNameChange={setName}
					service={service}
					onServiceChange={setService}
					serviceError={serviceError}
					nameError={nameError}
					envVar={envVar}
					sessionAgent={capture.agent}
					otherAgents={otherAgents}
					selectedIds={selected}
					onToggle={toggle}
					busy={busy}
					error={error ?? (unavailable ? helper : null)}
					onSaveUnassigned={() => vault('none')}
					onVault={() => vault('selected')}
				/>
			) : null}
		</div>
	)
}
