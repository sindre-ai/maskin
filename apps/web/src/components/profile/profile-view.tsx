import { ActorAvatar } from '@/components/shared/actor-avatar'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import { useActor, useUpdateActor, useUploadActorAvatar } from '@/hooks/use-actors'
import { type ActorResponse, ApiError } from '@/lib/api'
import { cn } from '@/lib/cn'
import { ACTOR_DESCRIPTION_MAX_STORED_LENGTH } from '@maskin/shared'
import { Camera, Copy } from 'lucide-react'
import { useRef, useState } from 'react'
import { toast } from 'sonner'

const ACCEPTED_MIME = new Set(['image/png', 'image/jpeg'])

// `avatar_url` is not on the shared response schema yet — the agent avatar
// uploader reads it the same defensive way (see agent-avatar-upload.tsx).
function readAvatarUrl(actor: ActorResponse): string | undefined {
	const url = (actor as unknown as { avatar_url?: unknown }).avatar_url
	return typeof url === 'string' && url.length > 0 ? url : undefined
}

/**
 * Your profile — mockup screen `Profile` (v2 line 2518).
 *
 * Three sections: who you are, how your agents should work with you, and the
 * account facts. The mockup's fourth section (Availability) is prototype-only —
 * its rows are hardcoded and its own handler says availability "lives in
 * Settings" — so there is nothing to render it from and it is left out.
 */
export function ProfileView({
	actorId,
	workspaceId,
	workspaceName,
}: {
	actorId: string
	workspaceId: string
	workspaceName: string
}) {
	const { data: actor, isLoading } = useActor(actorId)

	if (isLoading || !actor) {
		return (
			<div className="mx-auto flex max-w-[560px] justify-center py-16">
				<Spinner />
			</div>
		)
	}

	return (
		<div className="mx-auto flex max-w-[560px] flex-col">
			<IdentityHeader actor={actor} workspaceId={workspaceId} workspaceName={workspaceName} />
			<WorkingPreferences actor={actor} workspaceId={workspaceId} />
			<AccountSection actor={actor} workspaceId={workspaceId} workspaceName={workspaceName} />
		</div>
	)
}

function IdentityHeader({
	actor,
	workspaceId,
	workspaceName,
}: {
	actor: ActorResponse
	workspaceId: string
	workspaceName: string
}) {
	const upload = useUploadActorAvatar(workspaceId)
	const inputRef = useRef<HTMLInputElement>(null)
	const avatarUrl = readAvatarUrl(actor)

	async function handleFile(file: File | undefined) {
		if (!file) return
		if (!ACCEPTED_MIME.has(file.type)) {
			toast.error('Only PNG or JPG images are supported')
			return
		}
		try {
			await upload.mutateAsync({ id: actor.id, file })
			toast.success('Photo updated')
		} catch (err) {
			toast.error(err instanceof ApiError || err instanceof Error ? err.message : 'Upload failed')
		}
	}

	return (
		<div className="flex items-center gap-[15px]">
			<button
				type="button"
				onClick={() => inputRef.current?.click()}
				title="Upload a photo"
				aria-label="Upload a photo"
				className="relative size-12 shrink-0 overflow-hidden rounded-full transition-opacity duration-150 hover:opacity-85"
			>
				<ActorAvatar
					id={actor.id}
					name={actor.name}
					type={actor.type}
					imageUrl={avatarUrl}
					className="size-12 text-lg"
				/>
				{/* The camera strip is the only affordance saying the plate is a
				    control — without it a bare initial reads as decoration. */}
				<span className="absolute inset-x-0 bottom-0 grid h-4 place-items-center bg-foreground/55 text-background">
					{upload.isPending ? (
						<Spinner className="size-2.5" />
					) : (
						<Camera aria-hidden="true" className="size-2.5" />
					)}
				</span>
			</button>
			<input
				ref={inputRef}
				type="file"
				accept="image/png,image/jpeg"
				className="hidden"
				onChange={(e) => {
					void handleFile(e.target.files?.[0])
					e.target.value = ''
				}}
			/>
			<div className="min-w-0 flex-1">
				<h1 className="text-xl font-bold tracking-[-0.02em]">{actor.name}</h1>
				<div className="mt-0.5 truncate text-[12.5px] text-muted-foreground">
					{[actor.email, workspaceName].filter(Boolean).join(' · ')}
				</div>
			</div>
		</div>
	)
}

function SectionHeading({
	title,
	note,
	action,
}: { title: string; note?: string; action?: React.ReactNode }) {
	return (
		<div className="mb-2 mt-7 flex items-center gap-2.5">
			<span className="text-sm font-bold">{title}</span>
			{note && <span className="text-[11px] text-muted-foreground">{note}</span>}
			<div className="h-px flex-1 bg-border" />
			{action}
		</div>
	)
}

// The actor's `description` is the field agents already receive on the actor
// record, so it is the honest home for "how to work with me" — no new column,
// and what you write here genuinely reaches them.
function WorkingPreferences({ actor, workspaceId }: { actor: ActorResponse; workspaceId: string }) {
	const updateActor = useUpdateActor(workspaceId)
	const [editing, setEditing] = useState(false)
	const [draft, setDraft] = useState('')
	const saved = actor.description ?? ''

	function startEditing() {
		setDraft(saved)
		setEditing(true)
	}

	// The editor stays open until the write settles, and the draft survives a
	// failure. Closing first — as this did — re-rendered the read view with the
	// *old* text and dropped everything the user had typed, with a generic
	// "try again" that could not succeed if the text was over the limit.
	function save() {
		if (updateActor.isPending) return
		const next = draft.trim()
		if (next === saved) {
			setEditing(false)
			return
		}
		if (next.length > ACTOR_DESCRIPTION_MAX_STORED_LENGTH) {
			toast.error(
				`That's ${next.length} characters — ${ACTOR_DESCRIPTION_MAX_STORED_LENGTH} is the limit.`,
			)
			return
		}
		updateActor.mutate(
			{ id: actor.id, data: { description: next } },
			{
				onSuccess: () => {
					setEditing(false)
					toast.success('Your agents have the update')
				},
				onError: (err) =>
					toast.error(err instanceof ApiError ? err.message : "Couldn't save that — try again"),
			},
		)
	}

	const paragraphs = saved.split('\n\n').filter((p) => p.trim())

	return (
		<>
			<SectionHeading
				title="How to work with me"
				note="your agents read this"
				action={
					<button
						type="button"
						// Keeping focus in the textarea stops the button's own mousedown
						// from firing `onBlur` — which saved, flipped `editing` to false,
						// and left the click to land on `startEditing()` and re-open the box.
						onMouseDown={(e) => e.preventDefault()}
						onClick={() => (editing ? save() : startEditing())}
						disabled={updateActor.isPending}
						// "Edit" alone is the same name the account rows below already
						// use, so out of context it says nothing about what it edits.
						aria-label={editing ? 'Done editing how to work with me' : 'Edit how to work with me'}
						className="text-xs font-semibold text-muted-foreground transition-colors duration-150 hover:text-foreground disabled:opacity-60"
					>
						{editing ? (updateActor.isPending ? 'Saving…' : 'Done') : 'Edit'}
					</button>
				}
			/>
			{/* Edit is an explicit request to type here, so the caret lands in the
			    box rather than making the reader hunt for it. */}
			{editing ? (
				<Textarea
					autoFocus
					value={draft}
					onChange={(e) => setDraft(e.target.value)}
					onBlur={save}
					maxLength={ACTOR_DESCRIPTION_MAX_STORED_LENGTH}
					aria-label="How to work with me"
					className="min-h-[120px] resize-y rounded-xl px-4 py-3.5 text-[13px] leading-[1.65]"
				/>
			) : paragraphs.length > 0 ? (
				<div className="text-[13px] leading-[1.65] text-secondary-foreground">
					{paragraphs.map((p) => (
						<p key={p} className="mb-2.5 text-pretty">
							{p}
						</p>
					))}
				</div>
			) : (
				<p className="text-[13px] leading-[1.65] text-muted-foreground">
					Nothing here yet — how you like to be worked with, when to ask before acting, what to
					never do without you.
				</p>
			)}
		</>
	)
}

function AccountSection({
	actor,
	workspaceId,
	workspaceName,
}: {
	actor: ActorResponse
	workspaceId: string
	workspaceName: string
}) {
	return (
		<>
			<SectionHeading title="Account" />
			<div className="flex flex-col">
				<EditableRow
					label="Full name"
					value={actor.name}
					actorId={actor.id}
					workspaceId={workspaceId}
					field="name"
					first
				/>
				<EditableRow
					label="Email"
					value={actor.email ?? ''}
					actorId={actor.id}
					workspaceId={workspaceId}
					field="email"
					copyable
				/>
				<AccountRow label="Workspace" value={workspaceName} />
				<AccountRow label="Actor ID" value={actor.id} copyable />
			</div>
		</>
	)
}

function AccountRow({
	label,
	value,
	copyable,
	first,
	children,
}: {
	label: string
	value?: string
	copyable?: boolean
	first?: boolean
	children?: React.ReactNode
}) {
	return (
		<div className={cn('flex items-center gap-3 py-2.5', !first && 'border-t border-border')}>
			<span className="min-w-0 flex-1 text-[13px] text-muted-foreground">{label}</span>
			{children ?? (
				<span className="flex-none font-mono text-xs font-semibold text-secondary-foreground">
					{value}
				</span>
			)}
			{copyable && value && <CopyButton value={value} />}
		</div>
	)
}

function EditableRow({
	label,
	value,
	actorId,
	workspaceId,
	field,
	copyable,
	first,
}: {
	label: string
	value: string
	actorId: string
	workspaceId: string
	field: 'name' | 'email'
	copyable?: boolean
	first?: boolean
}) {
	const updateActor = useUpdateActor(workspaceId)
	const [editing, setEditing] = useState(false)
	const [draft, setDraft] = useState(value)

	function commit() {
		setEditing(false)
		const next = draft.trim()
		if (!next || next === value) {
			setDraft(value)
			return
		}
		updateActor.mutate(
			{ id: actorId, data: { [field]: next } },
			{
				onSuccess: () => toast.success(`${label} saved`),
				onError: () => {
					setDraft(value)
					toast.error(`Couldn't save your ${label.toLowerCase()}`)
				},
			},
		)
	}

	return (
		<AccountRow label={label} value={value} copyable={copyable && !editing} first={first}>
			{editing ? (
				<input
					// biome-ignore lint/a11y/noAutofocus: the row was clicked to edit it.
					autoFocus
					value={draft}
					aria-label={label}
					onChange={(e) => setDraft(e.target.value)}
					onBlur={commit}
					onKeyDown={(e) => {
						if (e.key === 'Enter') commit()
						if (e.key === 'Escape') {
							setDraft(value)
							setEditing(false)
						}
					}}
					className="w-[220px] max-w-[50vw] flex-none border-b-[1.5px] border-foreground bg-transparent pb-px text-right font-mono text-xs font-semibold text-foreground outline-none"
				/>
			) : (
				<button
					type="button"
					onClick={() => {
						setDraft(value)
						setEditing(true)
					}}
					// The value is the button's text, so an aria-label naming only the
					// action would drop it for anyone not reading the screen.
					aria-label={`Edit ${label.toLowerCase()}, currently ${value}`}
					className="-mr-1 flex-none rounded px-1 py-px font-mono text-xs font-semibold text-secondary-foreground transition-colors duration-150 hover:bg-muted"
				>
					{value}
				</button>
			)}
		</AccountRow>
	)
}

function CopyButton({ value }: { value: string }) {
	return (
		<button
			type="button"
			title="Copy"
			aria-label="Copy"
			onClick={() => {
				void navigator.clipboard?.writeText(value)
				toast.success('Copied')
			}}
			className="grid size-6 flex-none place-items-center rounded-md text-border-strong transition-colors duration-150 hover:bg-muted hover:text-foreground"
		>
			<Copy aria-hidden="true" className="size-3" />
		</button>
	)
}
