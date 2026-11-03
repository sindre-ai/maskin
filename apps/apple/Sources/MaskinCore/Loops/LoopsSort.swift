import Foundation

/// How the Flows list is ordered. Flows carry no tags, so this is the list's only display choice.
public enum LoopsSort: String, CaseIterable, Identifiable, Codable, Sendable {
	case recent, name
	/// Flows that wait on the viewer first, then the rest most recent first.
	case needsYouFirst

	public var id: String { rawValue }

	public var title: String {
		switch self {
		case .recent: "Default"
		case .name: "Name"
		case .needsYouFirst: "Needs you first"
		}
	}

	/// Recent puts the most recently touched flow first (a flow with no date goes last); Name is
	/// A to Z, ignoring case. Either way, flows that tie keep the order the API gave them.
	public func apply(to loops: [LoopSummary], reversed: Bool = false) -> [LoopSummary] {
		let ordered = apply(to: loops)
		return reversed ? Array(ordered.reversed()) : ordered
	}

	public func apply(to loops: [LoopSummary]) -> [LoopSummary] {
		loops.enumerated().sorted { lhs, rhs in
			let a = lhs.element, b = rhs.element
			switch self {
			case .recent, .needsYouFirst:
				if self == .needsYouFirst {
					let (na, nb) = (Self.needsYou(a), Self.needsYou(b))
					if na != nb { return na }
				}
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

extension LoopsSort {
	/// A flow waits on the viewer: its pill says so, or something in it is waiting.
	static func needsYou(_ loop: LoopSummary) -> Bool { loop.pill == .waitingOnYou || loop.waitingCount > 0 }
}

/// Which flows the list shows (the Display sheet's Filters row).
public enum LoopsFilter: String, CaseIterable, Identifiable, Codable, Sendable {
	case everything, needsYou, running

	public var id: String { rawValue }
	public var title: String {
		switch self {
		case .everything: "Everything"
		case .needsYou: "Needs you"
		case .running: "Running"
		}
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
