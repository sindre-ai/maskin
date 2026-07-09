import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { unzipSync } from 'fflate'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TestWrapper } from '../../setup'

const { mockNavigate, searchState } = vi.hoisted(() => ({
	mockNavigate: vi.fn(),
	searchState: {
		sort: 'name' as 'name' | 'createdAt' | 'updatedAt',
		order: 'asc' as 'asc' | 'desc',
	},
}))

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../mocks/router')
	return {
		...mockTanStackRouter(),
		// Wrap in { options } to mirror the real TanStack Route shape so the
		// test file can read Route.options.component and Route.options.validateSearch.
		createFileRoute: () => (options: Record<string, unknown>) => ({ options }),
		useSearch: () => ({ sort: searchState.sort, order: searchState.order }),
		useNavigate: () => mockNavigate,
	}
})

vi.mock('@/lib/workspace-context', () => ({
	useWorkspace: () => ({ workspaceId: 'ws-1' }),
}))

const mockUseWorkspaceSkills = vi.fn()
const mockUseWorkspaceSkill = vi.fn()
const mockUseWorkspaceSkillFiles = vi.fn()
const mockCreateMutate = vi.fn()
const mockCreateMutateAsync = vi.fn()
const mockUpdateMutate = vi.fn()
const mockDeleteMutate = vi.fn()
const mockUploadMutate = vi.fn()
const mockUploadMutateAsync = vi.fn()
const createPending = { value: false }
const updatePending = { value: false }
const deletePending = { value: false }
const uploadPending = { value: false }

vi.mock('@/hooks/use-workspace-skills', () => ({
	useWorkspaceSkills: (...args: unknown[]) => mockUseWorkspaceSkills(...args),
	useWorkspaceSkill: (...args: unknown[]) => mockUseWorkspaceSkill(...args),
	useWorkspaceSkillFiles: (...args: unknown[]) => mockUseWorkspaceSkillFiles(...args),
	useCreateWorkspaceSkill: () => ({
		mutate: mockCreateMutate,
		mutateAsync: mockCreateMutateAsync,
		isPending: createPending.value,
	}),
	useUpdateWorkspaceSkill: () => ({ mutate: mockUpdateMutate, isPending: updatePending.value }),
	useDeleteWorkspaceSkill: () => ({ mutate: mockDeleteMutate, isPending: deletePending.value }),
	useUploadWorkspaceSkill: () => ({
		mutate: mockUploadMutate,
		mutateAsync: mockUploadMutateAsync,
		isPending: uploadPending.value,
	}),
}))

// Route is imported after the mocks so the component picks up the mocked hooks.
import {
	Route,
	deriveNameFromFileName,
	formatSize,
	sortSkills,
	toSkillUpload,
	uniqueName,
	zipFolderFiles,
} from '@/routes/_authed/$workspaceId/settings/skills'

const SkillsPage = Route.options.component as () => React.ReactElement

function renderPage() {
	return render(
		<TestWrapper>
			<SkillsPage />
		</TestWrapper>,
	)
}

const buildSkill = (overrides: Record<string, unknown> = {}) => ({
	id: 'skill-1',
	workspaceId: 'ws-1',
	name: 'deploy',
	description: 'Deploy the service',
	storageKey: 'workspaces/ws-1/skills/deploy/SKILL.md',
	sizeBytes: 100,
	isValid: true,
	isFolder: false,
	fileCount: null,
	createdBy: 'actor-1',
	createdAt: '2026-04-23T00:00:00Z',
	updatedAt: '2026-04-23T00:00:00Z',
	...overrides,
})

function buildFolderFile(relativePath: string, content: string): File {
	const file = new File([content], relativePath.split('/').pop() ?? relativePath, {
		type: 'text/plain',
	})
	Object.defineProperty(file, 'webkitRelativePath', { value: relativePath })
	return file
}

// jsdom's Blob/File implementation doesn't have .arrayBuffer()/.text() —
// FileReader is the one read API it fully implements.
function readAsUint8Array(file: File): Promise<Uint8Array> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader()
		reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer))
		reader.onerror = () => reject(reader.error ?? new Error('read failed'))
		reader.readAsArrayBuffer(file)
	})
}

describe('Settings > Skills', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		searchState.sort = 'name'
		searchState.order = 'asc'
		createPending.value = false
		updatePending.value = false
		deletePending.value = false
		uploadPending.value = false
		mockUseWorkspaceSkills.mockReturnValue({ data: [], isLoading: false })
		mockUseWorkspaceSkill.mockReturnValue({ data: null, isLoading: false })
		mockUseWorkspaceSkillFiles.mockReturnValue({ data: [], isLoading: false, error: null })
		mockCreateMutate.mockImplementation((_vars, opts) => opts?.onSuccess?.())
		mockCreateMutateAsync.mockResolvedValue({})
		mockUpdateMutate.mockImplementation((_vars, opts) => opts?.onSuccess?.())
		mockDeleteMutate.mockImplementation((_vars, opts) => opts?.onSuccess?.())
		mockUploadMutateAsync.mockResolvedValue({ id: 'skill-1', isFolder: true, fileCount: 3 })
	})

	it('shows empty state when there are no skills', () => {
		renderPage()
		expect(screen.getByText('No skills yet')).toBeInTheDocument()
		expect(
			screen.getByText(
				"Create a skill, browse for SKILL.md or .zip bundles, import a folder directly, or drag and drop files here. Files that don't match the SKILL.md format are still added so you can fix them.",
			),
		).toBeInTheDocument()
	})

	it('renders a warning icon for skills with invalid format', () => {
		mockUseWorkspaceSkills.mockReturnValue({
			data: [buildSkill({ name: 'broken-skill', description: null, isValid: false })],
			isLoading: false,
		})
		renderPage()
		expect(screen.getByLabelText('Invalid SKILL.md format')).toBeInTheDocument()
		expect(
			screen.getByText("Won't be loaded by agents until the format is fixed"),
		).toBeInTheDocument()
	})

	it('allows renaming a skill via the edit dialog', async () => {
		const user = userEvent.setup()
		mockUseWorkspaceSkills.mockReturnValue({
			data: [buildSkill({ name: 'deploy' })],
			isLoading: false,
		})
		mockUseWorkspaceSkill.mockReturnValue({
			data: { ...buildSkill({ name: 'deploy' }), content: 'existing content' },
			isLoading: false,
		})
		renderPage()

		await user.click(screen.getByRole('button', { name: 'Actions for deploy' }))
		await user.click(screen.getByRole('menuitem', { name: /Edit/ }))

		const nameInput = screen.getByLabelText('Name') as HTMLInputElement
		// Name input must be enabled in edit mode so the user can rename.
		expect(nameInput).not.toBeDisabled()
		expect(nameInput.value).toBe('deploy')

		await user.clear(nameInput)
		await user.type(nameInput, 'deploy-v2')

		await user.click(screen.getByRole('button', { name: 'Save' }))

		expect(mockUpdateMutate).toHaveBeenCalledTimes(1)
		const [payload] = mockUpdateMutate.mock.calls[0]
		expect(payload).toEqual({
			name: 'deploy',
			data: { name: 'deploy-v2', content: 'existing content' },
			newName: 'deploy-v2',
		})
	})

	it('omits the name field when the edit dialog save is not a rename', async () => {
		const user = userEvent.setup()
		mockUseWorkspaceSkills.mockReturnValue({
			data: [buildSkill({ name: 'deploy' })],
			isLoading: false,
		})
		mockUseWorkspaceSkill.mockReturnValue({
			data: { ...buildSkill({ name: 'deploy' }), content: 'existing content' },
			isLoading: false,
		})
		renderPage()

		await user.click(screen.getByRole('button', { name: 'Actions for deploy' }))
		await user.click(screen.getByRole('menuitem', { name: /Edit/ }))

		const contentInput = screen.getByLabelText('SKILL.md')
		await user.clear(contentInput)
		await user.type(contentInput, 'updated body')

		await user.click(screen.getByRole('button', { name: 'Save' }))

		expect(mockUpdateMutate).toHaveBeenCalledTimes(1)
		const [payload] = mockUpdateMutate.mock.calls[0]
		expect(payload).toEqual({
			name: 'deploy',
			data: { content: 'updated body' },
			newName: undefined,
		})
	})

	it('renders skills in the list', () => {
		mockUseWorkspaceSkills.mockReturnValue({
			data: [
				buildSkill({ id: 's1', name: 'deploy', description: 'Deploy the service' }),
				buildSkill({ id: 's2', name: 'review', description: 'Review a PR' }),
			],
			isLoading: false,
		})
		renderPage()
		expect(screen.getByText('deploy')).toBeInTheDocument()
		expect(screen.getByText('Deploy the service')).toBeInTheDocument()
		expect(screen.getByText('review')).toBeInTheDocument()
		expect(screen.getByText('Review a PR')).toBeInTheDocument()
	})

	it('submits the create dialog and calls create mutation', async () => {
		const user = userEvent.setup()
		renderPage()

		// Open dialog via header button (not the empty-state one — both exist, pick the first).
		await user.click(screen.getAllByRole('button', { name: /Create skill/ })[0])

		expect(screen.getByRole('heading', { name: 'Create skill' })).toBeInTheDocument()

		const nameInput = screen.getByLabelText('Name')
		await user.type(nameInput, 'new-skill')

		const contentInput = screen.getByLabelText('SKILL.md')
		await user.clear(contentInput)
		await user.type(contentInput, 'body')

		await user.click(screen.getByRole('button', { name: 'Save' }))

		expect(mockCreateMutate).toHaveBeenCalledTimes(1)
		const [payload] = mockCreateMutate.mock.calls[0]
		expect(payload).toEqual({ name: 'new-skill', content: 'body' })
	})

	it('opens the edit dialog when the skill row is clicked', async () => {
		const user = userEvent.setup()
		mockUseWorkspaceSkills.mockReturnValue({
			data: [buildSkill({ name: 'deploy' })],
			isLoading: false,
		})
		mockUseWorkspaceSkill.mockReturnValue({
			data: { ...buildSkill({ name: 'deploy' }), content: 'existing content' },
			isLoading: false,
		})
		renderPage()

		await user.click(screen.getByText('deploy'))

		expect(screen.getByRole('heading', { name: 'Edit skill' })).toBeInTheDocument()
		expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('deploy')
	})

	it('does not open the edit dialog when the kebab menu is opened', async () => {
		const user = userEvent.setup()
		mockUseWorkspaceSkills.mockReturnValue({
			data: [buildSkill({ name: 'deploy' })],
			isLoading: false,
		})
		renderPage()

		await user.click(screen.getByRole('button', { name: 'Actions for deploy' }))

		// Kebab opens its menu but does NOT trigger row click → no edit dialog yet.
		expect(screen.queryByRole('heading', { name: 'Edit skill' })).not.toBeInTheDocument()
		expect(screen.getByRole('menuitem', { name: /Edit/ })).toBeInTheDocument()
	})

	it('lists skills sorted by name ascending by default', () => {
		mockUseWorkspaceSkills.mockReturnValue({
			data: [
				buildSkill({ id: 's1', name: 'review', description: 'b' }),
				buildSkill({ id: 's2', name: 'archive', description: 'a' }),
				buildSkill({ id: 's3', name: 'deploy', description: 'c' }),
			],
			isLoading: false,
		})
		renderPage()
		const rendered = screen.getAllByText(/^(archive|deploy|review)$/).map((el) => el.textContent)
		expect(rendered).toEqual(['archive', 'deploy', 'review'])
	})

	it('navigates with the new sort when the user picks a different option', async () => {
		const user = userEvent.setup()
		mockUseWorkspaceSkills.mockReturnValue({
			data: [buildSkill({ name: 'deploy' })],
			isLoading: false,
		})
		renderPage()

		await user.click(screen.getByRole('button', { name: /display/i }))
		// Default sort is Name — open the sort dropdown, then pick Updated.
		await user.click(screen.getByRole('button', { name: 'Name' }))
		await user.click(screen.getByRole('menuitem', { name: /Updated/ }))

		expect(mockNavigate).toHaveBeenCalled()
		const lastCall = mockNavigate.mock.calls.at(-1)?.[0] as {
			search: { sort: string; order: string }
			replace: boolean
		}
		expect(lastCall.search.sort).toBe('updatedAt')
		// replace: true keeps the sort change out of browser history so the back
		// button doesn't step through every intermediate sort.
		expect(lastCall.replace).toBe(true)
		// Changing only sort must preserve order — otherwise toggling sort would
		// silently flip a user-chosen desc back to asc.
		expect(lastCall.search.order).toBe('asc')
	})

	it('renders rows in the order dictated by the URL sort state', () => {
		// Pre-set the URL state to sort=updatedAt asc. The page reads useSearch,
		// so the render order must match sortSkills(rawList, 'updatedAt', 'asc').
		searchState.sort = 'updatedAt'
		searchState.order = 'asc'
		const rawList = [
			buildSkill({ id: 'a', name: 'archive', updatedAt: '2026-04-01T00:00:00Z' }),
			buildSkill({ id: 'b', name: 'deploy', updatedAt: '2026-02-01T00:00:00Z' }),
			buildSkill({ id: 'c', name: 'review', updatedAt: '2026-03-01T00:00:00Z' }),
		]
		mockUseWorkspaceSkills.mockReturnValue({ data: rawList, isLoading: false })
		renderPage()

		const expected = sortSkills(rawList, 'updatedAt', 'asc').map((s) => s.name)
		const rendered = screen.getAllByText(/^(archive|deploy|review)$/).map((el) => el.textContent)
		expect(rendered).toEqual(expected)
		expect(rendered).toEqual(['deploy', 'review', 'archive'])
	})

	it('renders a folder badge with file count for folder skills', () => {
		mockUseWorkspaceSkills.mockReturnValue({
			data: [buildSkill({ name: 'docx', isFolder: true, fileCount: 3, description: 'docx skill' })],
			isLoading: false,
		})
		renderPage()
		expect(screen.getByText('docx')).toBeInTheDocument()
		expect(screen.getByText('3 files')).toBeInTheDocument()
	})

	it('expands the folder row inline on click instead of opening the edit dialog', async () => {
		const user = userEvent.setup()
		mockUseWorkspaceSkills.mockReturnValue({
			data: [buildSkill({ name: 'docx', isFolder: true, fileCount: 2, description: 'docx skill' })],
			isLoading: false,
		})
		mockUseWorkspaceSkillFiles.mockReturnValue({
			data: [
				{ relativePath: 'SKILL.md', sizeBytes: 512 },
				{ relativePath: 'reference/style.md', sizeBytes: 2048 },
			],
			isLoading: false,
			error: null,
		})
		renderPage()

		await user.click(screen.getByText('docx'))

		// No edit dialog — folder click toggles expand.
		expect(screen.queryByRole('heading', { name: 'Edit skill' })).not.toBeInTheDocument()
		// File tree renders with sizes and Download / Replace controls.
		expect(screen.getByText('SKILL.md')).toBeInTheDocument()
		expect(screen.getByText('reference/style.md')).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Download docx as zip' })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Replace bundle for docx' })).toBeInTheDocument()
	})

	it('shows a single Import button with From file and From folder options', async () => {
		const user = userEvent.setup()
		renderPage()

		// Empty state renders the action twice (header + empty-state body).
		expect(screen.queryByRole('button', { name: 'Import from file' })).not.toBeInTheDocument()
		expect(screen.queryByRole('button', { name: 'Import folder' })).not.toBeInTheDocument()

		await user.click(screen.getAllByRole('button', { name: 'Import' })[0])

		expect(screen.getByRole('menuitem', { name: 'From file' })).toBeInTheDocument()
		expect(screen.getByRole('menuitem', { name: 'From folder' })).toBeInTheDocument()
	})

	it('routes a .zip file through the multipart upload mutation', async () => {
		const user = userEvent.setup()
		renderPage()

		const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
		const zipFile = new File(['PK fake-zip-bytes'], 'docx.zip', { type: 'application/zip' })

		// The drop-zone's `accept` includes `application/zip`, so the file's
		// MIME passes user-event's filter — handleFiles runs as it would in
		// the browser.
		await user.upload(fileInput, [zipFile])

		await waitFor(() => expect(mockUploadMutateAsync).toHaveBeenCalledTimes(1))
		const [zipPayload] = mockUploadMutateAsync.mock.calls[0]
		expect(zipPayload.file).toBe(zipFile)
		// First upload of a brand-new bundle — no replace, no skillId on the call.
		expect(zipPayload.skillId).toBeUndefined()
	})

	it('zips a folder selection client-side and routes it through the multipart upload mutation', async () => {
		const user = userEvent.setup()
		renderPage()

		const folderInput = document.querySelector('input[webkitdirectory]') as HTMLInputElement
		expect(folderInput).toBeTruthy()

		const files = [
			buildFolderFile('my-skill/SKILL.md', '---\nname: my-skill\n---\nbody'),
			buildFolderFile('my-skill/reference/style.md', 'reference content'),
		]

		await user.upload(folderInput, files)

		await waitFor(() => expect(mockUploadMutateAsync).toHaveBeenCalledTimes(1))
		const [payload] = mockUploadMutateAsync.mock.calls[0]
		expect(payload.file).toBeInstanceOf(File)
		expect(payload.file.name).toBe('my-skill.zip')
		expect(payload.skillId).toBeUndefined()

		// The zip preserves the folder-relative paths (including the root
		// folder name) so the server's wrapper-stripping logic can apply.
		const buffer = await readAsUint8Array(payload.file)
		const unzipped = unzipSync(buffer)
		expect(Object.keys(unzipped).sort()).toEqual([
			'my-skill/SKILL.md',
			'my-skill/reference/style.md',
		])
	})

	it('shows a friendly error and skips upload when a folder selection is empty', async () => {
		const user = userEvent.setup()
		renderPage()

		const folderInput = document.querySelector('input[webkitdirectory]') as HTMLInputElement
		const emptyFile = buildFolderFile('my-skill/empty.md', '')

		await user.upload(folderInput, [emptyFile])

		await waitFor(() => expect(screen.getByText(/Folder is empty/)).toBeInTheDocument())
		expect(mockUploadMutateAsync).not.toHaveBeenCalled()
	})

	it('passes skillId through the upload mutation when Replace bundle is used', async () => {
		const user = userEvent.setup()
		mockUseWorkspaceSkills.mockReturnValue({
			data: [buildSkill({ id: 'skill-42', name: 'docx', isFolder: true, fileCount: 3 })],
			isLoading: false,
		})
		renderPage()

		// Expand the folder row to surface the Replace bundle button + input.
		await user.click(screen.getByText('docx'))

		// Wait for the Replace button to render (proves expansion happened) before
		// grabbing the hidden per-row input that sits next to it.
		await waitFor(() =>
			expect(screen.getByRole('button', { name: 'Replace bundle for docx' })).toBeInTheDocument(),
		)
		// The SkillRow's expanded Replace input renders inside the row markup,
		// above the page-level picker at the end of SkillsPage's tree — so it
		// shows up first in document order. Use accept to disambiguate instead
		// of relying on positional indices.
		const replaceInput = Array.from(
			document.querySelectorAll<HTMLInputElement>('input[type="file"]'),
		).find((el) => !el.multiple) as HTMLInputElement
		expect(replaceInput).toBeTruthy()

		const newZip = new File(['PK new'], 'docx-v2.zip', { type: 'application/zip' })
		await user.upload(replaceInput, [newZip])

		await waitFor(() => expect(mockUploadMutateAsync).toHaveBeenCalledTimes(1))
		const [payload] = mockUploadMutateAsync.mock.calls[0]
		expect(payload.file).toBe(newZip)
		expect(payload.skillId).toBe('skill-42')
	})

	it('zips a folder selection and passes skillId when Replace with folder is used', async () => {
		const user = userEvent.setup()
		mockUseWorkspaceSkills.mockReturnValue({
			data: [buildSkill({ id: 'skill-42', name: 'docx', isFolder: true, fileCount: 3 })],
			isLoading: false,
		})
		renderPage()

		await user.click(screen.getByText('docx'))
		await waitFor(() =>
			expect(
				screen.getByRole('button', { name: 'Replace bundle for docx with a folder' }),
			).toBeInTheDocument(),
		)

		const replaceFolderInput = document.querySelector(
			'input[webkitdirectory][multiple]',
		) as HTMLInputElement
		expect(replaceFolderInput).toBeTruthy()

		const files = [buildFolderFile('docx/SKILL.md', '---\nname: docx\n---\nbody')]
		await user.upload(replaceFolderInput, files)

		await waitFor(() => expect(mockUploadMutateAsync).toHaveBeenCalledTimes(1))
		const [payload] = mockUploadMutateAsync.mock.calls[0]
		expect(payload.file.name).toBe('docx.zip')
		expect(payload.skillId).toBe('skill-42')
	})

	it('confirms deletion and calls delete mutation', async () => {
		const user = userEvent.setup()
		mockUseWorkspaceSkills.mockReturnValue({
			data: [buildSkill({ name: 'deploy' })],
			isLoading: false,
		})
		renderPage()

		await user.click(screen.getByRole('button', { name: 'Actions for deploy' }))
		await user.click(screen.getByRole('menuitem', { name: /Delete/ }))

		expect(screen.getByRole('heading', { name: 'Delete skill' })).toBeInTheDocument()

		await user.click(screen.getByRole('button', { name: 'Delete' }))

		await waitFor(() => expect(mockDeleteMutate).toHaveBeenCalledTimes(1))
		const [name] = mockDeleteMutate.mock.calls[0]
		expect(name).toBe('deploy')
	})
})

describe('settings/skills helpers', () => {
	describe('deriveNameFromFileName', () => {
		it('strips the .md extension and lowercases', () => {
			expect(deriveNameFromFileName('Deploy.md')).toBe('deploy')
		})

		it('replaces spaces and underscores with hyphens', () => {
			expect(deriveNameFromFileName('review pr.md')).toBe('review-pr')
			expect(deriveNameFromFileName('deep_work.markdown')).toBe('deep-work')
		})

		it('drops disallowed characters and collapses hyphens', () => {
			expect(deriveNameFromFileName('Foo!@#$.md')).toBe('foo')
			expect(deriveNameFromFileName('--a  b--.md')).toBe('a-b')
		})

		it('falls back to imported-skill when sanitisation yields empty string', () => {
			expect(deriveNameFromFileName('!!!.md')).toBe('imported-skill')
		})

		it('truncates to 64 chars', () => {
			const long = `${'a'.repeat(80)}.md`
			expect(deriveNameFromFileName(long)).toHaveLength(64)
		})
	})

	describe('uniqueName', () => {
		it('returns the base when not taken', () => {
			expect(uniqueName('deploy', new Set())).toBe('deploy')
		})

		it('appends a numeric suffix on collision', () => {
			expect(uniqueName('deploy', new Set(['deploy']))).toBe('deploy-2')
			expect(uniqueName('deploy', new Set(['deploy', 'deploy-2']))).toBe('deploy-3')
		})
	})

	describe('sortSkills', () => {
		const a = buildSkill({
			id: 'a',
			name: 'archive',
			createdAt: '2026-01-01T00:00:00Z',
			updatedAt: '2026-04-01T00:00:00Z',
		})
		const b = buildSkill({
			id: 'b',
			name: 'deploy',
			createdAt: '2026-02-01T00:00:00Z',
			updatedAt: '2026-03-01T00:00:00Z',
		})
		const c = buildSkill({
			id: 'c',
			name: 'review',
			createdAt: '2026-03-01T00:00:00Z',
			updatedAt: '2026-02-01T00:00:00Z',
		})

		it('sorts by name ascending', () => {
			expect(sortSkills([c, a, b], 'name', 'asc').map((s) => s.id)).toEqual(['a', 'b', 'c'])
		})

		it('sorts by name descending', () => {
			expect(sortSkills([a, c, b], 'name', 'desc').map((s) => s.id)).toEqual(['c', 'b', 'a'])
		})

		it('sorts by createdAt descending (newest first)', () => {
			expect(sortSkills([a, c, b], 'createdAt', 'desc').map((s) => s.id)).toEqual(['c', 'b', 'a'])
		})

		it('sorts by updatedAt ascending (oldest first)', () => {
			expect(sortSkills([a, c, b], 'updatedAt', 'asc').map((s) => s.id)).toEqual(['c', 'b', 'a'])
		})
	})

	describe('toSkillUpload', () => {
		it('uses the frontmatter name when the SKILL.md parses with a valid name', () => {
			const raw = '---\nname: from-frontmatter\ndescription: d\n---\n\nbody'
			const result = toSkillUpload(raw, 'whatever.md')
			expect(result.baseName).toBe('from-frontmatter')
			expect(result.content).toBe(raw)
		})

		it('falls back to the sanitised filename when the content lacks frontmatter', () => {
			const raw = 'no frontmatter — just body text'
			const result = toSkillUpload(raw, 'My Skill.md')
			expect(result.baseName).toBe('my-skill')
			expect(result.content).toBe(raw)
		})

		it('falls back to the filename when the frontmatter name is not in the allowed format', () => {
			const raw = '---\nname: Not Valid!\ndescription: d\n---\n\nbody'
			const result = toSkillUpload(raw, 'fallback-name.md')
			expect(result.baseName).toBe('fallback-name')
		})
	})

	describe('formatSize', () => {
		it('renders bytes under 1KB as raw B', () => {
			expect(formatSize(0)).toBe('0 B')
			expect(formatSize(512)).toBe('512 B')
		})

		it('renders KB with one decimal under 1MB', () => {
			expect(formatSize(1024)).toBe('1.0 KB')
			expect(formatSize(1536)).toBe('1.5 KB')
		})

		it('renders MB with one decimal above 1MB', () => {
			expect(formatSize(1024 * 1024)).toBe('1.0 MB')
			expect(formatSize(5 * 1024 * 1024)).toBe('5.0 MB')
		})

		it('returns a placeholder for negative or non-finite values', () => {
			expect(formatSize(-1)).toBe('—')
			expect(formatSize(Number.NaN)).toBe('—')
		})
	})

	describe('zipFolderFiles', () => {
		it('zips files preserving folder-relative paths, named after the root folder', async () => {
			const files = [
				buildFolderFile('my-skill/SKILL.md', '---\nname: my-skill\n---\nbody'),
				buildFolderFile('my-skill/reference/style.md', 'reference content'),
			]

			const result = await zipFolderFiles(files)
			if ('error' in result) throw new Error(`expected success, got error: ${result.error}`)
			expect(result.file.name).toBe('my-skill.zip')

			const unzipped = unzipSync(await readAsUint8Array(result.file))
			expect(Object.keys(unzipped).sort()).toEqual([
				'my-skill/SKILL.md',
				'my-skill/reference/style.md',
			])
		})

		it('rejects an empty file selection', async () => {
			const result = await zipFolderFiles([buildFolderFile('my-skill/empty.md', '')])
			expect(result).toEqual({ error: 'Folder is empty' })
		})

		it('rejects a selection with more than 500 entries', async () => {
			const files = Array.from({ length: 501 }, (_, i) => buildFolderFile(`my-skill/f${i}.md`, 'x'))
			const result = await zipFolderFiles(files)
			expect('error' in result && result.error).toMatch(/Folder has 501 files \(limit 500\)/)
		})

		it('rejects a single entry larger than 5 MB', async () => {
			const oversized = buildFolderFile('my-skill/big.bin', 'x'.repeat(5 * 1024 * 1024 + 1))
			const result = await zipFolderFiles([oversized])
			expect('error' in result && result.error).toMatch(/limit 5\.0 MB/)
		})

		it('rejects a folder whose total uncompressed size exceeds 10 MB', async () => {
			const files = [
				buildFolderFile('my-skill/a.bin', 'x'.repeat(5 * 1024 * 1024)),
				buildFolderFile('my-skill/b.bin', 'x'.repeat(5 * 1024 * 1024)),
				buildFolderFile('my-skill/c.bin', 'x'),
			]
			const result = await zipFolderFiles(files)
			expect('error' in result && result.error).toMatch(/Folder exceeds 10\.0 MB uncompressed/)
		})
	})

	describe('Route.options.validateSearch', () => {
		// Direct coverage for the "malformed URL recovers to defaults" guarantee —
		// the route-level test only exercises the happy path through useSearch.
		const validateSearch = Route.options.validateSearch as (search: Record<string, unknown>) => {
			sort: string
			order: string
		}
		const DEFAULTS = { sort: 'name', order: 'asc' }

		it('falls back to defaults when sort is an unknown string', () => {
			expect(validateSearch({ sort: 'bogus', order: 'asc' })).toEqual(DEFAULTS)
		})

		it('falls back to defaults when fields are missing', () => {
			expect(validateSearch({})).toEqual(DEFAULTS)
		})

		it('falls back to defaults when fields are non-string', () => {
			expect(validateSearch({ sort: 123, order: null })).toEqual(DEFAULTS)
		})

		it('passes through a valid sort + order pair', () => {
			expect(validateSearch({ sort: 'updatedAt', order: 'desc' })).toEqual({
				sort: 'updatedAt',
				order: 'desc',
			})
		})
	})
})
