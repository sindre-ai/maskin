import Foundation
import Observation

/// The workspace's files, newest first, with name search, a tag filter and paging.
@MainActor
@Observable
public final class FilesListStore {
	public enum Phase: Equatable, Sendable {
		case idle
		case loading
		case loaded
		case failed(String)
	}

	public static let pageSize = 50

	public private(set) var files: [FileSummary] = []
	public private(set) var phase: Phase = .idle
	public private(set) var isOffline = false
	public private(set) var isLoadingMore = false
	public private(set) var hasMore = false
	public private(set) var query = ""
	/// The tags the list is narrowed to, and whether a file needs all of them or any one.
	public private(set) var selectedTags: [String] = []
	public private(set) var match: FileTagMatch = .all
	/// Every tag in use with its file count, A to Z.
	public private(set) var availableTags: [FileTagCount] = []
	/// Why the last rename or merge failed, shown in its sheet; nil otherwise.
	public private(set) var tagChangeError: String?
	public private(set) var isChangingTag = false

	@ObservationIgnored private let remote: any FilesRemote
	@ObservationIgnored private var generation = 0

	public init(remote: any FilesRemote) {
		self.remote = remote
	}

	/// Changes the search text and reloads from the first page.
	public func setQuery(_ text: String) async {
		let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
		guard trimmed != query else { return }
		query = trimmed
		await load()
	}

	/// The tags to offer: those in use plus any picked one no file carries any more (count 0), so it
	/// can still be unpicked. A to Z.
	public var tagOptions: [FileTagCount] {
		let known = Set(availableTags.map(\.tag))
		let orphaned = selectedTags.filter { !known.contains($0) }.map { FileTagCount(tag: $0, count: 0) }
		return FileTagRules.sorted(availableTags + orphaned)
	}

	/// Whether the tag filter is worth showing: some file carries a tag, or one is already picked.
	public var hasTagFilter: Bool { !availableTags.isEmpty || !selectedTags.isEmpty }

	/// Replaces the picked tags and reloads from the first page.
	public func setTags(_ tags: [String]) async {
		guard tags != selectedTags else { return }
		selectedTags = tags
		await load()
	}

	/// Switches between "has all of these" and "has any of these". With no tags picked there is
	/// nothing to re-run.
	public func setMatch(_ newMatch: FileTagMatch) async {
		guard newMatch != match else { return }
		match = newMatch
		if !selectedTags.isEmpty { await load() }
	}

	/// The tags in use. A failure keeps the list already on screen.
	public func loadTags() async {
		guard let counts = try? await remote.tagCounts() else { return }
		availableTags = FileTagRules.sorted(counts)
	}

	/// Renames `tag` on every file. On success a picked `tag` follows its new name, and the list and
	/// the tag counts reload. Returns what changed, or nil with `tagChangeError` set.
	public func renameTag(_ tag: String, to newName: String) async -> FileTagChange? {
		await changeTag(from: tag) { try await self.remote.renameTag(from: tag, to: newName) }
	}

	/// Folds `tag` into `target` on every file. Same follow-up as `renameTag`.
	public func mergeTag(_ tag: String, into target: String) async -> FileTagChange? {
		await changeTag(from: tag) { try await self.remote.mergeTag(from: tag, into: target) }
	}

	public func clearTagChangeError() { tagChangeError = nil }

	private func changeTag(from tag: String, _ run: () async throws -> FileTagChange) async
		-> FileTagChange?
	{
		guard !isChangingTag else { return nil }
		isChangingTag = true
		tagChangeError = nil
		defer { isChangingTag = false }
		let change: FileTagChange
		do {
			change = try await run()
		} catch {
			tagChangeError = (error as? FileError)?.message ?? "Couldn't change the tag. Try again."
			return nil
		}
		if selectedTags.contains(tag) {
			var next: [String] = []
			for picked in selectedTags {
				let name = picked == tag ? change.to : picked
				if !next.contains(name) { next.append(name) }
			}
			selectedTags = next
		}
		await load()
		await loadTags()
		return change
	}

	/// First page for the current query. A failed refresh keeps the rows already on screen.
	public func load() async {
		generation += 1
		let mine = generation
		if files.isEmpty { phase = .loading }
		do {
			let page = try await remote.list(
				query: query, tags: selectedTags, match: match, limit: Self.pageSize, offset: 0)
			guard mine == generation else { return }
			files = page
			hasMore = page.count >= Self.pageSize
			isOffline = false
			phase = .loaded
		} catch {
			guard mine == generation else { return }
			let e = error as? FileError
			isOffline = e?.isOffline ?? false
			if files.isEmpty { phase = .failed(e?.message ?? "Something went wrong. Try again.") }
		}
	}

	/// Appends the next page when the row at the end of the list appears.
	public func loadMoreIfNeeded(current: FileSummary) async {
		guard hasMore, !isLoadingMore, current.id == files.last?.id else { return }
		isLoadingMore = true
		let mine = generation
		defer { isLoadingMore = false }
		do {
			let page = try await remote.list(
				query: query, tags: selectedTags, match: match, limit: Self.pageSize, offset: files.count)
			guard mine == generation else { return }
			let known = Set(files.map(\.id))
			files += page.filter { !known.contains($0.id) }
			hasMore = page.count >= Self.pageSize
		} catch {
			// The next scroll to the end tries again.
		}
	}
}
