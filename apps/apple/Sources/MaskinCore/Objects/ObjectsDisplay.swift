import Foundation

/// How the Objects list is ordered (the Display menu's "Sort by").
public enum ObjectsSort: String, Sendable, CaseIterable, Identifiable, Codable {
	/// Objects that want the person first, then blocked, active, done; newest-updated within a tier.
	case needsYou
	case updated
	case name

	public var id: String { rawValue }
	public var title: String {
		switch self {
		case .needsYou: "Needs you"
		case .updated: "Updated"
		case .name: "Name"
		}
	}

	/// What the server is asked to order a page by. "Needs you" has no server field, so it pages by
	/// `updatedAt` (the tiers are applied to what is loaded).
	var serverField: String { self == .name ? "title" : "updatedAt" }
	var serverAscending: Bool { self == .name }
}

public enum ObjectsLayout: String, Sendable, CaseIterable, Identifiable, Codable {
	case list
	case board

	public var id: String { rawValue }
	public var title: String { self == .list ? "List" : "Board" }
}

/// A property a row or card can show. The workspace's objects carry no flow on the list payload,
/// so Flow is deliberately not offered here yet. The title and the ask are never optional.
public enum ObjectsProperty: String, Sendable, CaseIterable, Identifiable, Codable {
	case driver
	case status
	case updated

	public var id: String { rawValue }
	public var title: String {
		switch self {
		case .driver: "Owner"
		case .status: "Status"
		case .updated: "Updated"
		}
	}
}

/// The person's Display choices for the Objects tab.
public struct ObjectsDisplay: Equatable, Sendable, Codable {
	public var sort: ObjectsSort = .needsYou
	public var needsYouOnly = false
	public var shown: Set<ObjectsProperty> = Set(ObjectsProperty.allCases)
	public var layout: ObjectsLayout = .list
	/// How the list is grouped; status by default (per type while every type shows).
	public var groupBy: ObjectsGrouping = .status
	/// Group ids the reader folded, remembered per grouping so folding a status does not fold a
	/// type of the same name.
	public var collapsed: [ObjectsGrouping: Set<String>] = [:]

	public init(
		sort: ObjectsSort = .needsYou, needsYouOnly: Bool = false,
		shown: Set<ObjectsProperty> = Set(ObjectsProperty.allCases), layout: ObjectsLayout = .list,
		groupBy: ObjectsGrouping = .status, collapsed: [ObjectsGrouping: Set<String>] = [:]
	) {
		self.sort = sort
		self.needsYouOnly = needsYouOnly
		self.shown = shown
		self.layout = layout
		self.groupBy = groupBy
		self.collapsed = collapsed
	}

	// Hand-written so choices saved before a field existed still decode.
	public init(from decoder: any Decoder) throws {
		let c = try decoder.container(keyedBy: CodingKeys.self)
		sort = try c.decodeIfPresent(ObjectsSort.self, forKey: .sort) ?? .needsYou
		needsYouOnly = try c.decodeIfPresent(Bool.self, forKey: .needsYouOnly) ?? false
		shown = try c.decodeIfPresent(Set<ObjectsProperty>.self, forKey: .shown) ?? Set(ObjectsProperty.allCases)
		layout = try c.decodeIfPresent(ObjectsLayout.self, forKey: .layout) ?? .list
		groupBy = try c.decodeIfPresent(ObjectsGrouping.self, forKey: .groupBy) ?? .status
		collapsed = try c.decodeIfPresent([ObjectsGrouping: Set<String>].self, forKey: .collapsed) ?? [:]
	}

	public func shows(_ property: ObjectsProperty) -> Bool { shown.contains(property) }

	public mutating func toggle(_ property: ObjectsProperty) {
		if shown.contains(property) { shown.remove(property) } else { shown.insert(property) }
	}

	public func isCollapsed(_ groupId: String) -> Bool { collapsed[groupBy]?.contains(groupId) == true }

	public mutating func toggleCollapsed(_ groupId: String) {
		var set = collapsed[groupBy] ?? []
		if !set.insert(groupId).inserted { set.remove(groupId) }
		collapsed[groupBy] = set
	}

	/// Anything off its default, so the Display button can show it.
	public var isCustomised: Bool {
		sort != .needsYou || needsYouOnly || shown != Set(ObjectsProperty.allCases) || layout != .list
			|| groupBy != .status
	}
}

/// Where Display choices survive a relaunch.
public protocol ObjectsDisplayStorage: Sendable {
	func load() -> ObjectsDisplay?
	func save(_ display: ObjectsDisplay)
}

public struct UserDefaultsObjectsDisplayStorage: ObjectsDisplayStorage, @unchecked Sendable {
	private let defaults: UserDefaults
	private let key: String

	public init(defaults: UserDefaults = .standard, key: String = "objects.display.v1") {
		self.defaults = defaults
		self.key = key
	}

	public func load() -> ObjectsDisplay? {
		guard let data = defaults.data(forKey: key) else { return nil }
		return try? JSONDecoder().decode(ObjectsDisplay.self, from: data)
	}

	public func save(_ display: ObjectsDisplay) {
		guard let data = try? JSONEncoder().encode(display) else { return }
		defaults.set(data, forKey: key)
	}
}

/// Keeps the value in memory, for tests and previews.
public final class InMemoryObjectsDisplayStorage: ObjectsDisplayStorage, @unchecked Sendable {
	private let lock = NSLock()
	private var value: ObjectsDisplay?

	public init(_ value: ObjectsDisplay? = nil) { self.value = value }

	public func load() -> ObjectsDisplay? { lock.withLock { value } }
	public func save(_ display: ObjectsDisplay) { lock.withLock { value = display } }
}
