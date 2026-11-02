import {
	REQUEST_CARD_LINK,
	RequestCardHeader,
	RequestCardReadOnly,
	RequestCardRow,
	RequestCardSummary,
} from '@/components/chat/request-card-parts'
import {
	REQUEST_CARD,
	REQUEST_CARD_BUTTON,
	REQUEST_CARD_QUIET_BUTTON,
} from '@/components/chat/request-card-styles'
import { SecretInput } from '@/components/keychain/secret-input'
import { FormError } from '@/components/shared/form-error'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useCanWrite } from '@/hooks/use-can-write'
import { useCardAnswer, useConversation, useSendMessage } from '@/hooks/use-conversation'
import { useIntegrations } from '@/hooks/use-integrations'
import { useContinueSession, useSendSessionInput } from '@/hooks/use-sessions'
import { ApiError, type MessageKeychainRequest, api } from '@/lib/api'
import { getStoredActor } from '@/lib/auth'
import { queryKeys } from '@/lib/query-keys'
import { useWorkspace } from '@/lib/workspace-context'
import {
	CREDENTIAL_NAME_MAX_LENGTH,
	checkCredentialName,
	credentialNameMessage,
	credentialSlug,
} from '@maskin/shared'
import { useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Lock } from 'lucide-react'
import { useMemo, useState } from 'react'

interface KeychainRequestCardProps {
	workspaceId: string
	conversationId: string
	/** The message the card is on: where Not now is recorded. */
	messageId: number
	/** When that message was posted, so a saved credential can be matched back to it. */
	messageCreatedAt: string | null
	/** The agent that asked: always among the agents the credential is shared with. */
	askingAgentId: string
	request: MessageKeychainRequest
}

/**
 * How the agent is told to use a credential it was just given; mirrors the session launch.
 * An API key is in its environment. A login never is: it types the login on its computer
 * with a reference that Maskin fills in, so it never sees the password.
 */
export function keychainUseHint(kind: 'api_key' | 'login', name: string): string {
	if (kind === 'login') {
		return `. It's a login, so you never see it: type it on your computer with desktop_type as {{keychain:${name}.username}} and {{keychain:${name}.password}}`
	}
	const slug = credentialSlug(name)
	return slug ? `. It's in your environment as KEYCHAIN_BYO_APIKEY_${slug}` : ''
}

/**
 * The Keychain card an agent puts in chat via `request_keychain_credential`.
 *
 * The person types the key, or the username and password, straight into this card, and
 * it goes to the vault: the value never passes through the agent or the message. It is
 * saved for the workspace but shared only with the agents in this chat, plus any the asker
 * named as needing it (changeable on the credential's page). Saving stops the agent's idle session and posts a short
 * message, which starts a fresh session that has the credential (an API key in its environment;
 * a login to type with desktop_type, never to read).
 *
 * A saved credential is matched back to its card from the integration list rather than
 * stored on the message, so a card scrolled back to reads "Saved" instead of offering
 * the form again.
 */
export function KeychainRequestCard({
	workspaceId,
	conversationId,
	messageId,
	messageCreatedAt,
	askingAgentId,
	request,
}: KeychainRequestCardProps) {
	const queryClient = useQueryClient()
	const isLogin = request.kind === 'login'
	const { data: conversation } = useConversation(conversationId, workspaceId)
	const { data: integrations } = useIntegrations(workspaceId)
	const sendMessage = useSendMessage(conversationId, workspaceId)
	// A helper is not in this chat and was stopped to take the key, so its follow-up carries on.
	const continueSession = useContinueSession(workspaceId, conversationId)
	const sendInput = useSendSessionInput(workspaceId)
	// Saving writes to the workspace, which a viewer cannot do.
	const canWrite = useCanWrite()
	const { workspace } = useWorkspace()
	// The Keychain pages only exist behind this flag, so the link and the pointer would dead-end.

	const targetIds = useMemo(
		() => new Set((request.target_agents ?? []).map((a) => a.id)),
		[request.target_agents],
	)
	const agents = useMemo(() => {
		const inChat = (conversation?.participants ?? [])
			.filter((p) => p.actorType === 'agent')
			.map((p) => ({ id: p.actorId, name: p.actorName }))
		const known = new Set(inChat.map((a) => a.id))
		const named = (request.target_agents ?? []).filter((a) => !known.has(a.id))
		const withTargets = [...inChat, ...named]
		return withTargets.some((a) => a.id === askingAgentId)
			? withTargets
			: [{ id: askingAgentId, name: 'The agent that asked' }, ...withTargets]
	}, [conversation?.participants, askingAgentId, request.target_agents])

	const [name, setName] = useState(request.suggested_name ?? '')
	const [secret, setSecret] = useState('')
	const [username, setUsername] = useState('')
	const [password, setPassword] = useState('')
	// What the person ticked or unticked; an agent they have not touched keeps its default.
	const [choices, setChoices] = useState<ReadonlyMap<string, boolean>>(new Map())
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [savedName, setSavedName] = useState<string | null>(null)
	const [agentStillRunning, setAgentStillRunning] = useState(false)
	const [sharing, setSharing] = useState(false)
	const [savedId, setSavedId] = useState<string | null>(null)
	const [removedName, setRemovedName] = useState<string | null>(null)
	const [declinedNow, setDeclinedNow] = useState(false)
	const storedAnswer = useCardAnswer(conversationId, workspaceId, messageId)
	const declined = declinedNow || storedAnswer === 'declined'

	// Everyone in the chat by default. When the asker named who needs it, the chat agents
	// that are neither named nor the asker start unticked, still tickable.
	const isChecked = (id: string) =>
		choices.get(id) ?? (targetIds.size === 0 || targetIds.has(id) || id === askingAgentId)
	const selectedIds = agents.map((a) => a.id).filter(isChecked)
	const nameProblem = name.trim() ? checkCredentialName(name) : null
	const hasValue = isLogin ? username.trim().length > 0 && password.length > 0 : secret.length > 0
	const canSave =
		!busy &&
		canWrite &&
		name.trim().length > 0 &&
		!nameProblem &&
		hasValue &&
		selectedIds.length > 0

	// Saved earlier (a reload, or another tab): same session, same kind, after this card.
	const savedEarlier = (integrations ?? []).find(
		(i) =>
			i.source === 'chat_capture' &&
			i.originSessionId === request.session_id &&
			i.providerMode === (isLogin ? 'byo_login' : 'byo_apikey') &&
			i.status !== 'undone' &&
			!!i.createdAt &&
			(!messageCreatedAt || i.createdAt >= messageCreatedAt),
	)
	const doneName = savedName ?? savedEarlier?.displayName ?? null

	const save = async () => {
		if (!canSave) return
		setBusy(true)
		setError(null)
		const displayName = name.trim()
		try {
			const base = {
				sessionId: request.session_id,
				displayName,
				fromCard: true,
				agentIds: selectedIds,
			}
			const res = await api.integrations.chatCapture(
				workspaceId,
				isLogin
					? { ...base, providerMode: 'byo_login', username: username.trim(), password }
					: { ...base, providerMode: 'byo_apikey', detectedProvider: 'manual', rawSecret: secret },
			)
			// The value is gone from the page the moment it is saved.
			setSecret('')
			setPassword('')
			setUsername('')
			setSavedName(displayName)
			setSavedId(res.integrationId)
			queryClient.invalidateQueries({ queryKey: queryKeys.integrations.all(workspaceId) })
			if (res.relaunch === 'failed') {
				// The idle session could not be stopped, so it still has no credential. Say so
				// rather than starting a second one beside it.
				setAgentStillRunning(true)
				return
			}
			const where = keychainUseHint(request.kind, displayName)
			if (request.reply_to_session) {
				continueSession.mutate({
					id: request.session_id,
					content: `I've saved ${displayName} to the Keychain${where}. Carry on with the work.`,
				})
				return
			}
			sendMessage.mutate({
				// Plain text: a person's own message is not rendered as markdown.
				content: `I've saved ${displayName} to the Keychain${where}. Reply with one short line to say you have it, then carry on.`,
				metadata: { hidden_from_chat: true },
			})
		} catch (err) {
			setError(
				err instanceof ApiError
					? `Couldn't save: ${err.message}`
					: "Couldn't save. Check the name and the value, then try again.",
			)
		} finally {
			setBusy(false)
		}
	}

	const me = getStoredActor()
	const keyId = savedId ?? savedEarlier?.id ?? null
	// The server lets only the person who saved a key, or a workspace admin or owner, take it
	// back out (POST /integrations/:id/remove answers 403 otherwise). A key saved in this card
	// was saved by the person looking at it; one found afterwards has its creator on the row.
	const canUndo =
		canWrite &&
		me?.type === 'human' &&
		(!!savedId ||
			savedEarlier?.createdBy === me.id ||
			workspace.role === 'owner' ||
			workspace.role === 'admin')

	// Undo takes the key back out of the vault. The agent was already restarted with it, which
	// is the same as removing it from the Keychain page: the secret is destroyed at once.
	const undo = async () => {
		if (!keyId || !doneName) return
		setBusy(true)
		setError(null)
		try {
			await api.integrations.remove(keyId, workspaceId)
			setRemovedName(doneName)
			setSavedName(null)
			queryClient.invalidateQueries({ queryKey: queryKeys.integrations.all(workspaceId) })
		} catch (err) {
			setError(
				err instanceof ApiError ? `Couldn't undo: ${err.message}` : "Couldn't undo. Try again.",
			)
		} finally {
			setBusy(false)
		}
	}

	const decline = () => {
		setDeclinedNow(true)
		const content = `Not now: please don't ask for ${name.trim() || 'a key'} yet. Carry on without it, or tell me what you need instead.`
		if (request.reply_to_session) {
			sendInput.mutate({
				id: request.session_id,
				content,
				card_answer: { message_id: messageId, outcome: 'declined' },
				conversationId,
			})
			return
		}
		sendMessage.mutate({
			content,
			metadata: {
				hidden_from_chat: true,
				card_answer: { message_id: messageId, outcome: 'declined' },
			},
		})
	}

	// Asking again is a plain message the agent answers with a new card.
	const askAgain = () => {
		setDeclinedNow(false)
		const content = `Please ask me for ${name.trim() || 'the key'} again.`
		if (request.reply_to_session) {
			sendInput.mutate({ id: request.session_id, content, conversationId })
			return
		}
		sendMessage.mutate({ content })
	}

	if (removedName) {
		return (
			<RequestCardSummary
				icon={Lock}
				actions={
					<Link
						to="/$workspaceId/settings/keychain"
						params={{ workspaceId }}
						className={REQUEST_CARD_LINK}
					>
						Manage
					</Link>
				}
			>
				Removed <strong>{removedName}</strong> from the Keychain.
			</RequestCardSummary>
		)
	}

	if (doneName) {
		const sharedWith = savedName
			? selectedIds.length
			: (savedEarlier?.agentGrants ?? []).filter((g) => g.access !== 'none').length
		return (
			<RequestCardSummary
				icon={Lock}
				note={
					error ??
					(agentStillRunning
						? 'The agent is still running without it. Stop it from the chat, then send a message to start it again with the credential.'
						: null)
				}
				actions={
					<>
						{keyId && canUndo ? (
							<button
								type="button"
								className={REQUEST_CARD_LINK}
								disabled={busy}
								onClick={() => void undo()}
							>
								Undo
							</button>
						) : null}
						<Link
							to="/$workspaceId/settings/keychain"
							params={{ workspaceId }}
							className={REQUEST_CARD_LINK}
						>
							Manage
						</Link>
					</>
				}
			>
				Saved <strong>{doneName}</strong> to the Keychain.
				{sharedWith > 0
					? ` Shared with ${sharedWith} ${sharedWith === 1 ? 'agent' : 'agents'}.`
					: ''}
			</RequestCardSummary>
		)
	}

	if (declined) {
		return (
			<RequestCardSummary
				icon={Lock}
				actions={
					canWrite ? (
						<button type="button" className={REQUEST_CARD_LINK} onClick={askAgain}>
							Ask again
						</button>
					) : null
				}
			>
				Declined <strong>{name.trim() || 'the key'}</strong>.
			</RequestCardSummary>
		)
	}

	if (!canWrite) {
		return (
			<RequestCardReadOnly icon={Lock} title="Viewer role">
				Only a person with edit access can save a key.
			</RequestCardReadOnly>
		)
	}

	const sharedNames = agents.filter((a) => isChecked(a.id)).map((a) => a.name)
	const sharedSummary =
		sharedNames.length <= 2
			? sharedNames.join(', ')
			: `${sharedNames.slice(0, 2).join(', ')}, ${sharedNames.length - 2} more`

	return (
		<form
			className={REQUEST_CARD}
			aria-label={isLogin ? 'Add a login to the Keychain' : 'Add an API key to the Keychain'}
			onSubmit={(e) => {
				e.preventDefault()
				void save()
			}}
		>
			<RequestCardHeader
				icon={Lock}
				title={isLogin ? 'Add a login to your Keychain' : 'Add an API key to your Keychain'}
			>
				{request.hint ? `${request.hint} ` : ''}Goes straight to your encrypted vault. The agent
				never sees it.
			</RequestCardHeader>

			<div className="space-y-1.5">
				<Label htmlFor={`kr-name-${request.session_id}`}>Name</Label>
				<Input
					id={`kr-name-${request.session_id}`}
					value={name}
					onChange={(e) => setName(e.target.value)}
					maxLength={CREDENTIAL_NAME_MAX_LENGTH}
					autoComplete="off"
					aria-invalid={nameProblem ? true : undefined}
					placeholder={isLogin ? 'e.g. e-conomic' : 'e.g. Stripe'}
					required
				/>
				{nameProblem ? (
					<p className="text-xs text-error">{credentialNameMessage(nameProblem)}</p>
				) : null}
			</div>

			{isLogin ? (
				<>
					<div className="space-y-1.5">
						<Label htmlFor={`kr-user-${request.session_id}`}>Username or email</Label>
						<Input
							id={`kr-user-${request.session_id}`}
							value={username}
							onChange={(e) => setUsername(e.target.value)}
							autoComplete="off"
							spellCheck={false}
							required
						/>
					</div>
					<div className="space-y-1.5">
						<Label htmlFor={`kr-pass-${request.session_id}`}>Password</Label>
						<SecretInput
							id={`kr-pass-${request.session_id}`}
							value={password}
							onChange={setPassword}
						/>
					</div>
				</>
			) : (
				<div className="space-y-1.5">
					<Label htmlFor={`kr-secret-${request.session_id}`}>Secret</Label>
					<SecretInput
						id={`kr-secret-${request.session_id}`}
						value={secret}
						onChange={setSecret}
						placeholder="Paste the key"
					/>
				</div>
			)}

			<RequestCardRow
				label="Shared with"
				action={
					<button
						type="button"
						className={REQUEST_CARD_LINK}
						aria-expanded={sharing}
						onClick={() => setSharing((v) => !v)}
					>
						{sharing ? 'Done' : 'Change'}
					</button>
				}
			>
				{sharedSummary || 'No one yet'}
			</RequestCardRow>
			{sharing ? (
				<fieldset className="space-y-1.5">
					<legend className="sr-only">Shared with</legend>
					{agents.map((agent) => (
						<div key={agent.id} className="flex items-center gap-2 max-md:min-h-11">
							<Checkbox
								id={`kr-agent-${request.session_id}-${agent.id}`}
								checked={isChecked(agent.id)}
								onCheckedChange={(checked) =>
									setChoices((prev) => new Map(prev).set(agent.id, checked === true))
								}
							/>
							<Label htmlFor={`kr-agent-${request.session_id}-${agent.id}`} className="font-normal">
								{agent.name}
							</Label>
						</div>
					))}
					<p className="text-xs text-muted-foreground">
						The agents in this chat, the one that asked and any it named. Saved for the whole
						workspace; only the ticked agents can use it. You can change that in Settings →
						Keychain.
					</p>
				</fieldset>
			) : null}

			<FormError error={error ?? undefined} />
			<div className="flex flex-wrap items-center gap-2">
				<Button type="submit" className={REQUEST_CARD_BUTTON} disabled={!canSave}>
					{busy ? 'Saving…' : 'Save to Keychain'}
				</Button>
				<Button
					type="button"
					variant="ghost"
					className={REQUEST_CARD_QUIET_BUTTON}
					disabled={busy}
					onClick={decline}
				>
					Not now
				</Button>
			</div>
		</form>
	)
}
