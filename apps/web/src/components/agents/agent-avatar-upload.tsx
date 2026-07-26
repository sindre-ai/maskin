import { ActorAvatar } from '@/components/shared/actor-avatar'
import { Spinner } from '@/components/ui/spinner'
import { useUploadActorAvatar } from '@/hooks/use-actors'
import { useWorkspaceMembers } from '@/hooks/use-workspaces'
import { type ActorResponse, ApiError } from '@/lib/api'
import { getStoredActor } from '@/lib/auth'
import { cn } from '@/lib/cn'
import { ImageUp } from 'lucide-react'
import { useCallback, useRef, useState } from 'react'

const ACCEPTED_MIME = new Set(['image/png', 'image/jpeg'])
const ACCEPT_ATTR = 'image/png,image/jpeg'

function isCurrentActorAdmin(members: { actorId: string; role?: string }[] | undefined): boolean {
	const actorId = getStoredActor()?.id
	if (!actorId || !members) return false
	const member = members.find((m) => m.actorId === actorId)
	if (!member) return false
	return member.role === 'admin' || member.role === 'owner'
}

export function AgentAvatarUpload({
	agent,
	workspaceId,
}: {
	agent: ActorResponse
	workspaceId: string
}) {
	const { data: members } = useWorkspaceMembers(workspaceId)
	const isAdmin = isCurrentActorAdmin(members)
	const uploadMutation = useUploadActorAvatar(workspaceId)
	const inputRef = useRef<HTMLInputElement>(null)
	const [error, setError] = useState<string | null>(null)
	const [isDragging, setIsDragging] = useState(false)
	const avatarUrl = agent.avatar_url ?? undefined

	const submit = useCallback(
		async (file: File) => {
			setError(null)
			if (!ACCEPTED_MIME.has(file.type)) {
				setError('Only PNG or JPG images are supported.')
				return
			}
			try {
				await uploadMutation.mutateAsync({ id: agent.id, file })
			} catch (err) {
				if (err instanceof ApiError || err instanceof Error) setError(err.message)
				else setError('Upload failed')
			}
		},
		[uploadMutation, agent.id],
	)

	const handlePick = useCallback(() => inputRef.current?.click(), [])

	const handleInputChange = useCallback(
		(e: React.ChangeEvent<HTMLInputElement>) => {
			const file = e.target.files?.[0]
			e.target.value = ''
			if (file) void submit(file)
		},
		[submit],
	)

	const isUploading = uploadMutation.isPending

	// Non-admins still see the avatar preview — they just can't upload.
	if (!isAdmin) {
		return (
			<div className="mb-4">
				<ActorAvatar
					name={agent.name}
					type={agent.type}
					size="md"
					id={agent.id}
					imageUrl={avatarUrl}
				/>
			</div>
		)
	}

	return (
		<div
			className={cn(
				'mb-4 flex items-start gap-3 rounded-lg border-2 border-dashed p-3 transition-colors',
				isDragging ? 'border-accent bg-accent/5' : 'border-transparent',
			)}
			onDragOver={(e) => {
				e.preventDefault()
				if (!isUploading) setIsDragging(true)
			}}
			onDragLeave={() => setIsDragging(false)}
			onDrop={(e) => {
				e.preventDefault()
				setIsDragging(false)
				if (isUploading) return
				const file = e.dataTransfer.files?.[0]
				if (file) void submit(file)
			}}
		>
			<div className="relative shrink-0">
				<ActorAvatar
					name={agent.name}
					type={agent.type}
					size="md"
					id={agent.id}
					imageUrl={avatarUrl}
				/>
				{isUploading && (
					<div className="absolute inset-0 flex items-center justify-center rounded-full bg-background/70">
						<Spinner className="h-4 w-4" />
					</div>
				)}
			</div>

			<div className="flex min-w-0 flex-1 flex-col gap-1">
				<button
					type="button"
					onClick={handlePick}
					disabled={isUploading}
					className={cn(
						'inline-flex min-h-11 items-center gap-1.5 self-start rounded-md px-2 py-1 text-sm text-muted-foreground transition-colors hover:bg-bg-hover hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50',
					)}
					aria-label="Upload avatar image"
				>
					<ImageUp size={14} />
					<span>
						{isUploading
							? 'Uploading…'
							: avatarUrl
								? 'Replace avatar image'
								: 'Upload avatar image'}
					</span>
				</button>
				<p className="text-xs text-muted-foreground">
					{isDragging
						? 'Drop a PNG or JPG to upload'
						: 'PNG or JPG, up to 2 MB. Or drag an image onto the avatar.'}
				</p>
				{error && <p className="text-xs text-error">{error}</p>}
			</div>

			<input
				ref={inputRef}
				type="file"
				accept={ACCEPT_ATTR}
				className="hidden"
				onChange={handleInputChange}
			/>
		</div>
	)
}
