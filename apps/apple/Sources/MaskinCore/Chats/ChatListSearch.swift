import Foundation
import Observation

/// One chat found by the Chats list search: from the server's search, so it can be any chat the
/// person is in, loaded into the list or not.
public struct ChatSearchHit: Identifiable, Hashable, Sendable {
	public var id: String
	public var title: String
	/// Who is in the chat, as one line ("Developer, Me").
	public var people: String?
	/// The newest message holding the typed words, cut to 160 characters by the server.
	public var snippet: String?
	/// The person archived this chat.
	public var archived: Bool
	public var updatedAt: Date?

	public init(
		id: String, title: String, people: String? = nil, snippet: String? = nil, archived: Bool = false,
		updatedAt: Date? = nil
	) {
		self.id = id
		self.title = title
		self.people = people
		self.snippet = snippet
		self.archived = archived
		self.updatedAt = updatedAt
	}
}

/// `GET /api/search` for chats only. A protocol so the model tests without a server.
public protocol ChatSearching: Sendable {
	func search(query: String) async throws -> [ChatSearchHit]
}

/// Which hits the default list leaves out, and which line explains a hit. The same rules as the web list.
public enum ChatSearchRules {
	/// A hit reads as archived when the person archived it, or when the default list leaves it out
	/// (the quiet-chat rule). The list runs newest activity first, so once all of it is loaded a
	/// missing chat is left out; while pages remain, a missing chat is left out only if it is newer
	/// than the oldest loaded row, because everything newer has already come in.
	public static func isArchived(
		_ hit: ChatSearchHit, loadedIDs: Set<String>, hasMore: Bool, oldestActivity: Date?
	) -> Bool {
		if hit.archived { return true }
		if loadedIDs.contains(hit.id) { return false }
		if !hasMore { return true }
		guard let oldestActivity, let updatedAt = hit.updatedAt else { return false }
		return updatedAt >= oldestActivity
	}

	/// The line under a hit's title: the message that matched, or the people when the name matched
	/// and the message did not.
	public static func line(for hit: ChatSearchHit, query: String) -> String? {
		let snippet = hit.snippet.flatMap { $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : $0 }
		let people = hit.people.flatMap { $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : $0 }
		let hitsPeople = people.map { !SearchHighlight.ranges(of: query, in: $0).isEmpty } ?? false
		let hitsSnippet = snippet.map { !SearchHighlight.ranges(of: query, in: $0).isEmpty } ?? false
		if hitsPeople && !hitsSnippet { return people }
		return snippet ?? people
	}
}

/// The list search's state: the words go to the server after a short pause, and the answer
/// replaces the grouped list while words are typed. Without a source (previews, tests of the
/// plain list) it stays idle and the list keeps its own on-screen filter.
@MainActor
@Observable
public final class ChatListSearchModel {
	public enum Phase: Equatable, Sendable { case idle, loading, loaded, failed }

	public private(set) var hits: [ChatSearchHit] = []
	public private(set) var phase: Phase = .idle
	@ObservationIgnored private let source: (any ChatSearching)?
	@ObservationIgnored private let debounce: Duration

	public init(source: (any ChatSearching)?, debounce: Duration = .milliseconds(250)) {
		self.source = source
		self.debounce = debounce
	}

	/// True when the list search can ask the server at all.
	public var isAvailable: Bool { source != nil }

	/// Run for the current text; call from `.task(id:)` so a newer text cancels an older run. The
	/// previous hits stay on screen while the next answer loads.
	public func update(_ text: String) async {
		let query = text.trimmingCharacters(in: .whitespacesAndNewlines)
		guard let source, !query.isEmpty else {
			hits = []
			phase = .idle
			return
		}
		phase = .loading
		do {
			try await Task.sleep(for: debounce)
			let found = try await source.search(query: query)
			guard !Task.isCancelled else { return }
			hits = found
			phase = .loaded
		} catch {
			// A cancelled run belongs to an older text; the newer run owns the state.
			guard !Task.isCancelled, !(error is CancellationError) else { return }
			phase = .failed
		}
	}
}
