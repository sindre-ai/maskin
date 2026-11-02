import Foundation
import Observation

/// Bulk-select state for a list: whether selection mode is on and which ids are picked. Pure
/// logic, shared by the Chats and Objects lists.
@MainActor
@Observable
public final class SelectionModel {
	public private(set) var isActive = false
	public private(set) var ids: Set<String> = []

	public init() {}

	public var count: Int { ids.count }
	public var isEmpty: Bool { ids.isEmpty }
	public func contains(_ id: String) -> Bool { ids.contains(id) }

	/// Turns selection mode on, optionally with the row that was long-pressed already picked.
	public func enter(selecting id: String? = nil) {
		isActive = true
		if let id { ids.insert(id) }
	}

	public func exit() {
		isActive = false
		ids = []
	}

	public func toggle(_ id: String) {
		if !ids.insert(id).inserted { ids.remove(id) }
	}

	public func selectAll(_ all: [String]) { ids = Set(all) }
	public func clear() { ids = [] }

	/// Whether every id in `all` is picked (and there is at least one).
	public func isAllSelected(of all: [String]) -> Bool {
		!all.isEmpty && all.allSatisfy(ids.contains)
	}

	/// Drops picked ids that are no longer in the list (archived elsewhere, filtered away, deleted).
	public func prune(toVisible visible: [String]) {
		let keep = Set(visible)
		let pruned = ids.intersection(keep)
		if pruned != ids { ids = pruned }
	}

	/// The picked ids in list order, so a bulk action runs top to bottom.
	public func ordered(in all: [String]) -> [String] { all.filter(ids.contains) }
}

/// What a bulk action did: each item is its own optimistic write, so some can fail while others land.
public struct BulkResult: Equatable, Sendable {
	public var succeeded: Int
	public var failed: Int

	public init(succeeded: Int = 0, failed: Int = 0) {
		self.succeeded = succeeded
		self.failed = failed
	}

	public var total: Int { succeeded + failed }
	public var allSucceeded: Bool { failed == 0 }

	/// A transient notice for a partial or total failure, or nil when everything landed.
	/// Example: `failureNotice(action: "archive", past: "archived", noun: "chat")`.
	public func failureNotice(action: String, past: String, noun: String) -> String? {
		guard failed > 0 else { return nil }
		if failed == total { return "Couldn't \(action) \(failed) \(failed == 1 ? noun : noun + "s")." }
		return "\(succeeded) \(past), \(failed) couldn't be. Try again for the rest."
	}
}
