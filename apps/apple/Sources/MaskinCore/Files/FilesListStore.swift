import Foundation
import Observation

/// The workspace's files, newest first, with name search and paging.
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

	/// First page for the current query. A failed refresh keeps the rows already on screen.
	public func load() async {
		generation += 1
		let mine = generation
		if files.isEmpty { phase = .loading }
		do {
			let page = try await remote.list(query: query, limit: Self.pageSize, offset: 0)
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
			let page = try await remote.list(query: query, limit: Self.pageSize, offset: files.count)
			guard mine == generation else { return }
			let known = Set(files.map(\.id))
			files += page.filter { !known.contains($0.id) }
			hasMore = page.count >= Self.pageSize
		} catch {
			// The next scroll to the end tries again.
		}
	}
}
