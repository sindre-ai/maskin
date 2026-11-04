import Foundation

/// The Flows Display choices besides the sort: the Order chip (Normal / Reversed) and the
/// Summary property. Flows carry no tags, so there is no Tags property.
public struct LoopsDisplay: Equatable, Sendable, Codable {
	public var reversed = false
	public var showsSummary = true

	public init(reversed: Bool = false, showsSummary: Bool = true) {
		self.reversed = reversed
		self.showsSummary = showsSummary
	}

	public init(from decoder: any Decoder) throws {
		let c = try decoder.container(keyedBy: CodingKeys.self)
		reversed = try c.decodeIfPresent(Bool.self, forKey: .reversed) ?? false
		showsSummary = try c.decodeIfPresent(Bool.self, forKey: .showsSummary) ?? true
	}
}

public protocol LoopsDisplayStorage: Sendable {
	func load() -> LoopsDisplay?
	func save(_ display: LoopsDisplay)
}

public struct UserDefaultsLoopsDisplayStorage: LoopsDisplayStorage, @unchecked Sendable {
	private let defaults: UserDefaults
	private let key: String

	public init(defaults: UserDefaults = .standard, key: String = "flows.display.v1") {
		self.defaults = defaults
		self.key = key
	}

	public func load() -> LoopsDisplay? {
		defaults.data(forKey: key).flatMap { try? JSONDecoder().decode(LoopsDisplay.self, from: $0) }
	}

	public func save(_ display: LoopsDisplay) {
		defaults.set(try? JSONEncoder().encode(display), forKey: key)
	}
}

/// Keeps the value in memory, for tests and previews.
public final class InMemoryLoopsDisplayStorage: LoopsDisplayStorage, @unchecked Sendable {
	private let lock = NSLock()
	private var value: LoopsDisplay?

	public init(_ value: LoopsDisplay? = nil) { self.value = value }

	public func load() -> LoopsDisplay? { lock.withLock { value } }
	public func save(_ display: LoopsDisplay) { lock.withLock { value = display } }
}
