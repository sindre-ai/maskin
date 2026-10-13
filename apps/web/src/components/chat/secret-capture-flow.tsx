import { InlineScopePicker, type ScopeAgent } from '@/components/chat/inline-scope-picker'
import {
	SecretDetectedCard,
	VaultedCard,
	type VaultedPhase,
} from '@/components/chat/secret-detected-card'
import { TranscriptRedactedRow } from '@/components/chat/transcript-redacted-row'
import { useActors } from '@/hooks/use-actors'
import { type RelaunchWatch, useRelaunchProgress } from '@/hooks/use-relaunch-progress'
import { useActiveSessionsForConversation } from '@/hooks/use-sessions'
import { trackEvent } from '@/lib/analytics'
import { ApiError, type ChatCaptureProvider, api } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
import { scanComposerText } from '@/lib/secret-scanner'
import { type SecretMatch, redactSecrets, redactionMarker } from '@maskin/shared'
import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

const PROVIDER_LABEL: Record<ChatCaptureProvider, string> = {
	cloudflare: 'Cloudflare',
	github: 'GitHub',
	stripe: 'Stripe',
	slack: 'Slack',
	'openai-style': 'API key',
}

/** First and last characters only: the whole value never renders. */
export function maskSecret(value: string): string {
	const head = /^[A-Za-z]+[_-]/.exec(value)?.[0] ?? value.slice(0, 3)
	return `${head}…${value.slice(-4)}`
}

type Stage = 'detected' | 'scope'

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

export interface SecretCaptureFlowProps {
	workspaceId: string
	/** What the user typed, secret included. Lives in memory only, never storage. */
	content: string
	matches: SecretMatch[]
	/** The live session to vault into. Null on a composer with no session. */
	capture: { sessionId: string; conversationId?: string; agent: ScopeAgent } | null
	agentName: string
	/** The agent is restarting after an earlier vault: vaulting another secret waits for it. */
	restarting?: boolean
	/** Sends the final (redacted or as-is) body. */
	onSend: (content: string) => Promise<void>
	/** Drop the message. */
	onCancel: () => void
	/** Keep the text, close the card. */
	onEdit: () => void
	/** The decision is made. keepReceipts: vaulted cards (with Undo) stay on screen. */
	onDone: (keepReceipts: boolean) => void
	/** "Not a secret": mute these pattern ids for the session. */
	onMute: (patternIds: string[]) => void
}

/**
 * Drives the card the composer guard opens: detect, then scope, then vaulted. Enter
 * in the composer or the name input never vaults; only the primary button does.
 */
export function SecretCaptureFlow({
	workspaceId,
	content,
	matches,
	capture: liveCapture,
	agentName,
	restarting = false,
	onSend,
	onCancel,
	onEdit,
	onDone,
	onMute,
}: SecretCaptureFlowProps) {
	const queryClient = useQueryClient()
	// Vaulting stops the session this card was opened for, so the live capture target goes
	// away mid-flow. The card keeps the one it started with: the server only needs the
	// session id, which outlives the session.
	const [capture] = useState(liveCapture)
	const high = useMemo(() => matches.filter((m) => m.confidence === 'high'), [matches])
	const target = high[0] ?? null
	const provider = (target?.provider ?? null) as ChatCaptureProvider | null

	const [stage, setStage] = useState<Stage>('detected')
	const [current, setCurrent] = useState({ content, high })
	const [name, setName] = useState('')
	const [selected, setSelected] = useState<Set<string>>(
		() => new Set(capture ? [capture.agent.id] : []),
	)
	const [busy, setBusy] = useState(false)
	// Vaulted and sent: only the receipts (with Undo) stay on screen.
	const [finished, setFinished] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [vaults, setVaults] = useState<VaultRecord[]>([])
	const [undoingId, setUndoingId] = useState<string | null>(null)
	const [retryingId, setRetryingId] = useState<string | null>(null)
	const [cardError, setCardError] = useState<string | null>(null)
	const [now, setNow] = useState(() => Date.now())
	// The redacted message of a vault whose relaunch failed. It is held back until Retry
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

	// A fresh scan result (another secret left in the message) restarts the name.
	const currentTarget = current.high[0] ?? null
	const currentProvider = (currentTarget?.provider ?? null) as ChatCaptureProvider | null
	useEffect(() => {
		if (currentProvider) setName(`${PROVIDER_LABEL[currentProvider]} key`)
	}, [currentProvider])

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
	const startResuming = useCallback(
		(integrationId: string) => {
			setVaults((prev) =>
				prev.map((v) => (v.integrationId === integrationId ? { ...v, phase: 'resuming' } : v)),
			)
			if (!capture?.conversationId) return
			setWatch({
				integrationId,
				conversationId: capture.conversationId,
				agentId: capture.agent.id,
				knownSessionIds: sessionIdsAtRelaunch.current,
			})
		},
		[capture],
	)

	const sendBody = useCallback(
		async (body: string) => {
			try {
				await onSend(body)
				return true
			} catch (err) {
				setError(
					err instanceof Error
						? `Saved, but the message didn't send: ${err.message}`
						: 'Failed to send',
				)
				return false
			}
		},
		[onSend],
	)

	const vault = useCallback(
		async (grants: 'selected' | 'none') => {
			if (!capture || !currentTarget || !currentProvider) return
			setBusy(true)
			setError(null)
			const displayName = name.trim()
			sessionIdsAtRelaunch.current = sessionIdsNow.current
			try {
				const res = await api.integrations.chatCapture(workspaceId, {
					sessionId: capture.sessionId,
					providerMode: 'byo_apikey',
					detectedProvider: currentProvider,
					displayName,
					rawSecret: currentTarget.value,
					scopeGrants:
						grants === 'none' ? [] : [...selected].map((actorId) => ({ kind: 'actor', actorId })),
				})
				queryClient.invalidateQueries({ queryKey: queryKeys.integrations.all(workspaceId) })
				const marker = redactionMarker(currentTarget.value, displayName)
				setVaults((prev) => [
					...prev,
					{
						integrationId: res.integrationId,
						name: displayName,
						agentCount: grants === 'none' ? 0 : selected.size,
						marker,
						undoExpiresAt: new Date(res.undoExpiresAt).getTime(),
						phase: res.relaunch === 'failed' ? 'failed' : 'live',
						sessionEnded: true,
					},
				])
				const redacted = redactSecrets(current.content, [currentTarget], displayName)
				const remaining = scanComposerText(redacted, { workspaceId }).filter(
					(m) => m.confidence === 'high',
				)
				if (remaining.length > 0) {
					// Another secret is still in the message: vault it too before anything sends.
					setCurrent({ content: redacted, high: remaining })
					setStage('detected')
					return
				}
				if (res.relaunch === 'failed') {
					// The old session is still running without the key. The message is what
					// respawns a session, so hold it until Retry has stopped the old one.
					withheld.current = redacted
					setFinished(true)
					onDone(true)
					return
				}
				if (await sendBody(redacted)) {
					setFinished(true)
					onDone(true)
					startResuming(res.integrationId)
				}
			} catch (err) {
				setError(
					err instanceof ApiError
						? `Couldn't vault — ${err.message}. Retry, or cancel the message.`
						: "Couldn't vault. Retry, or cancel the message.",
				)
			} finally {
				setBusy(false)
			}
		},
		[
			capture,
			currentTarget,
			currentProvider,
			name,
			workspaceId,
			selected,
			current.content,
			queryClient,
			sendBody,
			onDone,
			startResuming,
		],
	)

	const sendAsIs = useCallback(async () => {
		setBusy(true)
		setError(null)
		trackEvent('keychain_secret_false_positive_reported', {
			pattern_id: matches[0]?.patternId ?? null,
		})
		onMute(matches.map((m) => m.patternId))
		try {
			await onSend(content)
			onDone(false)
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Failed to send')
		} finally {
			setBusy(false)
		}
	}, [content, matches, onDone, onMute, onSend])

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
				setCardError(
					"Couldn't undo. The undo window has closed. Revoke it from Settings > Keychain.",
				)
			} finally {
				setUndoingId(null)
			}
		},
		[queryClient, workspaceId],
	)

	/** Retry on 7c-3: repeat stop and wait; on success send the held message, which respawns. */
	const retry = useCallback(
		async (record: VaultRecord) => {
			setRetryingId(record.integrationId)
			setCardError(null)
			sessionIdsAtRelaunch.current = sessionIdsNow.current
			try {
				const res = await api.integrations.relaunch(record.integrationId, workspaceId)
				if (res.relaunch === 'failed') return
				const body = withheld.current
				if (body === null || (await sendBody(body))) {
					withheld.current = null
					if (body === null) {
						setVaults((prev) =>
							prev.map((v) =>
								v.integrationId === record.integrationId ? { ...v, phase: 'live' } : v,
							),
						)
					} else {
						startResuming(record.integrationId)
					}
				}
			} catch {
				// Same state as a failed stop: the line stays and Retry is offered again.
			} finally {
				setRetryingId(null)
			}
		},
		[workspaceId, sendBody, startResuming],
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

	if (finished) return <>{vaultedCards}</>

	if (stage === 'scope' && capture && currentProvider) {
		return (
			<div className="flex flex-col gap-2">
				{vaultedCards}
				<div
					className="rounded-xl border border-brand/40 bg-brand-subtle p-4"
					onKeyDown={(e) => {
						if (e.key === 'Escape' && !busy) {
							e.preventDefault()
							onCancel()
						}
					}}
				>
					<InlineScopePicker
						credentialName={name}
						onCredentialNameChange={setName}
						service={PROVIDER_LABEL[currentProvider]}
						sessionAgent={capture.agent}
						otherAgents={otherAgents}
						selectedIds={selected}
						onToggle={toggle}
						busy={busy}
						error={error}
						onSaveUnassigned={() => vault('none')}
						onVault={() => vault('selected')}
					/>
				</div>
			</div>
		)
	}

	const isHigh = current.high.length > 0
	const shown = isHigh ? current.high[0] : matches[0]
	if (!shown) return <>{vaultedCards}</>
	const extra = current.high.length - 1
	return (
		<div className="flex flex-col gap-2">
			{vaultedCards}
			<SecretDetectedCard
				variant={isHigh ? 'high' : 'low'}
				diagnostic={
					isHigh
						? `Looks like ${shown.description}${extra > 0 ? ` (and ${extra} more in this message; vault them one at a time)` : ''}`
						: `looks like ${shown.description}`
				}
				mask={maskSecret(shown.value)}
				service={currentProvider ? PROVIDER_LABEL[currentProvider] : undefined}
				agentName={agentName}
				canVault={!!capture && isHigh}
				restarting={restarting}
				busy={busy}
				error={error}
				onVault={() => setStage('scope')}
				onSendAsIs={sendAsIs}
				onEdit={onEdit}
				onCancel={onCancel}
			/>
		</div>
	)
}
