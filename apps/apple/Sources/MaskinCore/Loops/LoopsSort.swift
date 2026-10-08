import Foundation

/// How the Flows list is ordered. Flows carry no tags, so this is the list's only display choice.
public enum LoopsSort: String, CaseIterable, Identifiable, Codable, Sendable {
	case recent, name

	public var id: String { rawValue }

	public var title: String {
		switch self {
		case .recent: "Recent"
		case .name: "Name"
		}
	}

	/// Recent puts the most recently touched flow first (a flow with no date goes last); Name is
	/// A to Z, ignoring case. Either way, flows that tie keep the order the API gave them.
	public func apply(to loops: [LoopSummary]) -> [LoopSummary] {
		loops.enumerated().sorted { lhs, rhs in
			let a = lhs.element, b = rhs.element
			switch self {
			case .recent:
				let da = a.updatedAt ?? a.createdAt ?? .distantPast
				let db = b.updatedAt ?? b.createdAt ?? .distantPast
				if da != db { return da > db }
			case .name:
				let order = a.displayName.localizedCaseInsensitiveCompare(b.displayName)
				if order != .orderedSame { return order == .orderedAscending }
			}
			return lhs.offset < rhs.offset
		}.map(\.element)
	}
}

/// Remembers the sort on this device. Not workspace-wide: the Display scope is per user and device.
public protocol LoopsSortStorage: Sendable {
	func load() -> LoopsSort?
	func save(_ sort: LoopsSort)
}

public struct UserDefaultsLoopsSortStorage: LoopsSortStorage, @unchecked Sendable {
	private let defaults: UserDefaults
	private let key: String

	public init(defaults: UserDefaults = .standard, key: String = "flows.sort.v1") {
		self.defaults = defaults
		self.key = key
	}

	public func load() -> LoopsSort? {
		defaults.string(forKey: key).flatMap(LoopsSort.init(rawValue:))
	}

	public func save(_ sort: LoopsSort) { defaults.set(sort.rawValue, forKey: key) }
}

/// Keeps the value in memory, for tests and previews.
public final class InMemoryLoopsSortStorage: LoopsSortStorage, @unchecked Sendable {
	private let lock = NSLock()
	private var value: LoopsSort?

	public init(_ value: LoopsSort? = nil) { self.value = value }

	public func load() -> LoopsSort? { lock.withLock { value } }
	public func save(_ sort: LoopsSort) { lock.withLock { value = sort } }
}
