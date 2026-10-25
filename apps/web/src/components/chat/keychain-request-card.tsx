import { SecretInput } from '@/components/keychain/secret-input'
import { FormError } from '@/components/shared/form-error'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useConversation, useSendMessage } from '@/hooks/use-conversation'
import { useIntegrations } from '@/hooks/use-integrations'
import { useContinueSession } from '@/hooks/use-sessions'
import { ApiError, type MessageKeychainRequest, api } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
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
	/** The message the card is on, so a saved credential can be matched back to it. */
	messageCreatedAt: string | null
	/** The agent that asked: always among the agents the credential is shared with. */
	askingAgentId: string
	request: MessageKeychainRequest
}

/** The env var names an agent reads the credential from; mirrors the session launch. */
export function keychainEnvNames(kind: 'api_key' | 'login', name: string): string[] {
	const slug = credentialSlug(name)
	if (!slug) return []
	return kind === 'login'
		? [`KEYCHAIN_BYO_LOGIN_${slug}_USERNAME`, `KEYCHAIN_BYO_LOGIN_${slug}_PASSWORD`]
		: [`KEYCHAIN_BYO_APIKEY_${slug}`]
}

/**
 * The Keychain card an agent puts in chat via `request_keychain_credential`.
 *
 * The person types the key, or the username and password, straight into this card, and
 * it goes to the vault: the value never passes through the agent or the message. It is
 * saved for the workspace but shared only with the agents in this chat (changeable on
 * the credential's page). Saving stops the agent's idle session and posts a short
 * message, which starts a fresh session that has the credential in its environment.
 *
 * A saved credential is matched back to its card from the integration list rather than
 * stored on the message, so a card scrolled back to reads "Saved" instead of offering
 * the form again.
 */
export function KeychainRequestCard({
	workspaceId,
	conversationId,
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
	// The Keychain pages only exist behind this flag, so the link and the pointer would dead-end.

	const agents = useMemo(() => {
		const inChat = (conversation?.participants ?? [])
			.filter((p) => p.actorType === 'agent')
			.map((p) => ({ id: p.actorId, name: p.actorName }))
		return inChat.some((a) => a.id === askingAgentId)
			? inChat
			: [{ id: askingAgentId, name: 'The agent that asked' }, ...inChat]
	}, [conversation?.participants, askingAgentId])

	const [name, setName] = useState(request.suggested_name ?? '')
	const [secret, setSecret] = useState('')
	const [username, setUsername] = useState('')
	const [password, setPassword] = useState('')
	// Everyone in the chat by default; only a person's untick removes an agent.
	const [unselected, setUnselected] = useState<ReadonlySet<string>>(new Set())
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [savedName, setSavedName] = useState<string | null>(null)
	const [agentStillRunning, setAgentStillRunning] = useState(false)

	const selectedIds = agents.map((a) => a.id).filter((id) => !unselected.has(id))
	const nameProblem = name.trim() ? checkCredentialName(name) : null
	const hasValue = isLogin ? username.trim().length > 0 && password.length > 0 : secret.length > 0
	const canSave =
		!busy && name.trim().length > 0 && !nameProblem && hasValue && selectedIds.length > 0

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
			queryClient.invalidateQueries({ queryKey: queryKeys.integrations.all(workspaceId) })
			if (res.relaunch === 'failed') {
				// The idle session could not be stopped, so it still has no credential. Say so
				// rather than starting a second one beside it.
				setAgentStillRunning(true)
				return
			}
			const vars = keychainEnvNames(request.kind, displayName)
			const where = vars.length > 0 ? `. It's in your environment as ${vars.join(' and ')}` : ''
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

	if (doneName) {
		return (
			<div className="mt-2 flex flex-wrap items-center gap-2 rounded-xl border border-border bg-muted/40 px-4 py-3 text-sm">
				<Lock className="size-4 text-muted-foreground" aria-hidden />
				<span>
					Saved <strong>{doneName}</strong> to the Keychain.
				</span>
				<Link
					to="/$workspaceId/settings/keychain"
					params={{ workspaceId }}
					className="text-xs text-muted-foreground underline"
				>
					Manage in Keychain
				</Link>
				{agentStillRunning ? (
					<p className="w-full text-xs text-muted-foreground">
						The agent is still running without it. Stop it from the chat, then send a message to
						start it again with the credential.
					</p>
				) : null}
			</div>
		)
	}

	return (
		<form
			className="mt-2 flex flex-col gap-3 rounded-xl border border-border bg-muted/40 p-4"
			aria-label={isLogin ? 'Add a login to the Keychain' : 'Add an API key to the Keychain'}
			onSubmit={(e) => {
				e.preventDefault()
				void save()
			}}
		>
			<div className="flex items-start gap-2">
				<Lock className="mt-0.5 size-4 shrink-0" aria-hidden />
				<div>
					<h3 className="text-sm font-semibold">
						{isLogin ? 'Add a login to your Keychain' : 'Add an API key to your Keychain'}
					</h3>
					<p className="mt-0.5 text-xs text-muted-foreground">
						{request.hint ? `${request.hint} ` : ''}It goes straight to your encrypted vault, so the
						agent never sees it.
					</p>
				</div>
			</div>

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
					<SecretInput id={`kr-secret-${request.session_id}`} value={secret} onChange={setSecret} />
				</div>
			)}

			<fieldset className="space-y-1.5">
				<legend className="text-xs font-medium">Shared with</legend>
				{agents.map((agent) => (
					<div key={agent.id} className="flex items-center gap-2">
						<Checkbox
							id={`kr-agent-${request.session_id}-${agent.id}`}
							checked={!unselected.has(agent.id)}
							onCheckedChange={(checked) =>
								setUnselected((prev) => {
									const next = new Set(prev)
									if (checked) next.delete(agent.id)
									else next.add(agent.id)
									return next
								})
							}
						/>
						<Label htmlFor={`kr-agent-${request.session_id}-${agent.id}`} className="font-normal">
							{agent.name}
						</Label>
					</div>
				))}
				<p className="text-xs text-muted-foreground">
					Saved for this workspace. You can change who can use it in Settings → Keychain.
				</p>
			</fieldset>

			<FormError error={error ?? undefined} />
			<div className="flex justify-end">
				<Button type="submit" disabled={!canSave}>
					{busy ? 'Saving…' : 'Save to Keychain'}
				</Button>
			</div>
		</form>
	)
}
