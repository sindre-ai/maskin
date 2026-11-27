import Foundation
import Observation

/// The kinds of rows the Agents and Flows pages ask the server search about.
public enum PageSearchType: String, Sendable {
	case agent
	case loop
}

/// One server search for a single type: the ids of the matching rows, best match first.
public protocol PageSearchRanking: Sendable {
	func rankedIDs(query: String, type: PageSearchType) async throws -> [String]
}

/// The Agents and Flows pages' search order, the same as the web: while words are typed, one server
/// search for this page's type says which row is the best match, so a name match sits above a
/// description match. The page keeps its own word filter for which rows show; this only says in what
/// order. With nothing typed, or before the answer arrives (or if it fails), `order` is nil and the
/// page keeps its Display order.
@MainActor
@Observable
public final class PageSearchRank {
	/// Place of each matching row in the server's order (0 is the best match), or nil for no ranking.
	public private(set) var order: [String: Int]?

	@ObservationIgnored private let remote: any PageSearchRanking
	@ObservationIgnored private let type: PageSearchType
	@ObservationIgnored private let debounce: Duration
	@ObservationIgnored private var task: Task<Void, Never>?

	public init(remote: any PageSearchRanking, type: PageSearchType, debounce: Duration = .milliseconds(250)) {
		self.remote = remote
		self.type = type
		self.debounce = debounce
	}

	/// The search box changed. Any older answer is dropped at once, so a stale order never shows for new words.
	public func update(text: String) {
		task?.cancel()
		order = nil
		let typed = text.trimmingCharacters(in: .whitespacesAndNewlines)
		guard !typed.isEmpty else { return }
		let (remote, type, debounce) = (remote, type, debounce)
		task = Task { [weak self] in
			do {
				try await Task.sleep(for: debounce)
				let ids = try await remote.rankedIDs(query: typed, type: type)
				guard !Task.isCancelled else { return }
				var places: [String: Int] = [:]
				for (place, id) in ids.enumerated() where places[id] == nil { places[id] = place }
				self?.order = places
			} catch {
				// A failed search leaves the Display order, the same as before the answer arrives.
			}
		}
	}

	/// The rows in the server's order. A row the server did not rank (a typo or a tag hit) keeps its
	/// place after them. With no ranking the rows come back as given.
	public nonisolated static func sort<Row>(_ rows: [Row], by order: [String: Int]?, id: (Row) -> String) -> [Row] {
		guard let order else { return rows }
		// Each row's place, then the index as the tiebreak so unranked rows keep their given order.
		var places: [Int] = []
		for row in rows { places.append(order[id(row)] ?? Int.max) }
		let indices: [Int] = Array(rows.indices)
		let sorted: [Int] = indices.sorted { (a: Int, b: Int) -> Bool in
			if places[a] != places[b] { return places[a] < places[b] }
			return a < b
		}
		return sorted.map { rows[$0] }
	}
}
