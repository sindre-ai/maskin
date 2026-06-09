import { ActorAvatar } from '@/components/shared/actor-avatar'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
	ResponsiveDialog,
	ResponsiveDialogContent,
	ResponsiveDialogDescription,
	ResponsiveDialogFooter,
	ResponsiveDialogHeader,
	ResponsiveDialogTitle,
} from '@/components/ui/responsive-dialog'
import { useUploadAvatar } from '@/hooks/use-actors'
import { trackEvent } from '@/lib/analytics'
import { type ActorResponse, ApiError } from '@/lib/api'
import { type ChangeEvent, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'

const MAX_BYTES = 5 * 1024 * 1024
const ACCEPT = 'image/jpeg,image/png,image/webp'
const ACCEPT_MIME = new Set(['image/jpeg', 'image/png', 'image/webp'])

export function AvatarRow({ actor }: { actor: ActorResponse }) {
	const [open, setOpen] = useState(false)
	const [showSaved, setShowSaved] = useState(false)

	useEffect(() => {
		if (!showSaved) return
		const t = setTimeout(() => setShowSaved(false), 2000)
		return () => clearTimeout(t)
	}, [showSaved])

	return (
		<div
			data-row="avatar"
			className="grid grid-cols-1 gap-1 py-3.5 md:grid-cols-[160px_1fr] md:items-center md:gap-4"
		>
			<div className="pt-1 text-sm font-medium text-muted-foreground">Avatar</div>
			<div className="flex items-center justify-between gap-4">
				<ActorAvatar
					name={actor.name}
					type={actor.type}
					size="lg"
					avatarUrl={actor.avatar_storage_key ? `/api/actors/${actor.id}/avatar` : null}
				/>
				<div className="flex items-center gap-3">
					{showSaved ? <span className="text-xs text-muted-foreground">Saved</span> : null}
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={() => setOpen(true)}
						aria-label="Upload avatar"
					>
						Upload
					</Button>
				</div>
			</div>
			<AvatarUploadDialog
				actor={actor}
				open={open}
				onOpenChange={setOpen}
				onSaved={() => setShowSaved(true)}
			/>
		</div>
	)
}

function AvatarUploadDialog({
	actor,
	open,
	onOpenChange,
	onSaved,
}: {
	actor: ActorResponse
	open: boolean
	onOpenChange: (open: boolean) => void
	onSaved: () => void
}) {
	const mutation = useUploadAvatar(actor.id)
	const fileInputRef = useRef<HTMLInputElement>(null)
	const [file, setFile] = useState<File | null>(null)
	const [preview, setPreview] = useState<string | null>(null)
	const [localError, setLocalError] = useState<string | null>(null)
	const [serverError, setServerError] = useState<string | null>(null)

	useEffect(() => {
		if (!file) {
			setPreview(null)
			return
		}
		const url = URL.createObjectURL(file)
		setPreview(url)
		return () => URL.revokeObjectURL(url)
	}, [file])

	function reset() {
		setFile(null)
		setPreview(null)
		setLocalError(null)
		setServerError(null)
		mutation.reset()
		if (fileInputRef.current) fileInputRef.current.value = ''
	}

	function handleOpenChange(value: boolean) {
		if (!value) reset()
		onOpenChange(value)
	}

	function handleFileChange(e: ChangeEvent<HTMLInputElement>) {
		setServerError(null)
		const picked = e.target.files?.[0] ?? null
		if (!picked) {
			setFile(null)
			setLocalError(null)
			return
		}
		if (!ACCEPT_MIME.has(picked.type)) {
			setFile(null)
			setLocalError('Use a JPEG, PNG, or WebP image.')
			return
		}
		if (picked.size > MAX_BYTES) {
			setFile(null)
			setLocalError('Image must be 5MB or smaller.')
			return
		}
		setLocalError(null)
		setFile(picked)
	}

	async function handleSave() {
		if (!file) return
		setServerError(null)
		try {
			await mutation.mutateAsync(file)
			trackEvent('profile.field_changed', { field: 'avatar' })
			toast.success('Avatar updated')
			onSaved()
			onOpenChange(false)
			reset()
		} catch (err) {
			setServerError(
				err instanceof ApiError
					? err.message
					: err instanceof Error
						? err.message
						: 'Upload failed.',
			)
		}
	}

	const error = serverError ?? localError

	return (
		<ResponsiveDialog open={open} onOpenChange={handleOpenChange}>
			<ResponsiveDialogContent>
				<ResponsiveDialogHeader>
					<ResponsiveDialogTitle>Upload avatar</ResponsiveDialogTitle>
					<ResponsiveDialogDescription>JPEG, PNG, or WebP. Up to 5MB.</ResponsiveDialogDescription>
				</ResponsiveDialogHeader>

				<div className="flex flex-col items-center gap-4 py-2">
					{preview ? (
						<img
							src={preview}
							alt="Avatar preview"
							className="h-24 w-24 rounded-full object-cover"
						/>
					) : (
						<span
							className="inline-flex h-24 w-24 items-center justify-center rounded-full bg-zinc-700 text-xl font-medium text-zinc-300"
							aria-hidden="true"
						>
							{actor.name.charAt(0).toUpperCase()}
						</span>
					)}
					<Input
						ref={fileInputRef}
						type="file"
						accept={ACCEPT}
						onChange={handleFileChange}
						aria-label="Choose avatar image"
						className="max-w-xs"
					/>
					{error ? <span className="text-xs text-destructive">{error}</span> : null}
				</div>

				<ResponsiveDialogFooter>
					<Button
						type="button"
						variant="outline"
						onClick={() => handleOpenChange(false)}
						disabled={mutation.isPending}
					>
						Cancel
					</Button>
					<Button type="button" onClick={handleSave} disabled={!file || mutation.isPending}>
						{mutation.isPending ? 'Uploading…' : 'Save'}
					</Button>
				</ResponsiveDialogFooter>
			</ResponsiveDialogContent>
		</ResponsiveDialog>
	)
}
