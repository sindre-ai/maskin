import Foundation

/// What a marketplace loop bundles (mirrors the catalog's `item_types`).
public enum MarketplaceItemKind: String, Sendable, Equatable, CaseIterable, Codable {
	case actor, trigger, skill, integration

	public init(wire: String) { self = MarketplaceItemKind(rawValue: wire) ?? .skill }

	/// Plural, as the web catalog's filter chips name them.
	public var pluralLabel: String {
		switch self {
		case .actor: "Agents"
		case .trigger: "Triggers"
		case .skill: "Skills"
		case .integration: "Integrations"
		}
	}

	public var singularLabel: String {
		switch self {
		case .actor: "Agent"
		case .trigger: "Trigger"
		case .skill: "Skill"
		case .integration: "Integration"
		}
	}

	public var symbol: String {
		switch self {
		case .actor: "person.crop.circle"
		case .trigger: "bolt"
		case .skill: "sparkles"
		case .integration: "puzzlepiece.extension"
		}
	}
}

/// One loop in the marketplace catalog.
public struct MarketplaceLoop: Identifiable, Equatable, Sendable {
	public var id: String
	public var name: String
	public var summary: String
	public var version: String
	public var useCase: String?
	public var itemKinds: [MarketplaceItemKind]
	public var updatedAt: Date?

	public init(
		id: String, name: String, summary: String = "", version: String = "1.0.0",
		useCase: String? = nil, itemKinds: [MarketplaceItemKind] = [], updatedAt: Date? = nil
	) {
		self.id = id
		self.name = name
		self.summary = summary
		self.version = version
		self.useCase = useCase
		self.itemKinds = itemKinds
		self.updatedAt = updatedAt
	}

	/// "2 agents · 1 trigger" style line; empty when the catalog lists no parts.
	public var contentsLine: String {
		MarketplaceItemKind.allCases.compactMap { kind in
			let n = itemKinds.filter { $0 == kind }.count
			guard n > 0 else { return nil }
			return "\(n) \((n == 1 ? kind.singularLabel : kind.pluralLabel).lowercased())"
		}.joined(separator: " · ")
	}
}

/// One part of a marketplace loop (an agent, trigger, skill or integration) with the name and
/// description read out of its snapshot.
public struct MarketplaceItem: Identifiable, Equatable, Sendable {
	public var id: String
	public var kind: MarketplaceItemKind
	public var name: String
	public var summary: String?

	public init(id: String, kind: MarketplaceItemKind, name: String, summary: String? = nil) {
		self.id = id
		self.kind = kind
		self.name = name
		self.summary = summary
	}
}

public struct MarketplaceLoopDetail: Equatable, Sendable {
	public var loop: MarketplaceLoop
	public var items: [MarketplaceItem]

	public init(loop: MarketplaceLoop, items: [MarketplaceItem]) {
		self.loop = loop
		self.items = items
	}
}

/// A marketplace loop installed in this workspace.
public struct InstalledLoop: Identifiable, Equatable, Sendable {
	public var id: String
	public var sourceLoopID: String
	/// The loop object it provisioned (nil for older installs).
	public var objectID: String?
	public var installedVersion: String
	public var availableVersion: String
	public var hasUpdate: Bool
	/// A fork no longer follows the marketplace version.
	public var isForked: Bool
	public var loopName: String

	public init(
		id: String, sourceLoopID: String, objectID: String? = nil, installedVersion: String = "1.0.0",
		availableVersion: String = "1.0.0", hasUpdate: Bool = false, isForked: Bool = false,
		loopName: String = ""
	) {
		self.id = id
		self.sourceLoopID = sourceLoopID
		self.objectID = objectID
		self.installedVersion = installedVersion
		self.availableVersion = availableVersion
		self.hasUpdate = hasUpdate
		self.isForked = isForked
		self.loopName = loopName
	}

	/// The sentence the update banner shows, like the web's. A fork keeps its own version.
	public var updateNote: String? {
		guard hasUpdate else { return nil }
		return isForked
			? "v\(availableVersion) of the source is available. Your fork stays at v\(installedVersion)."
			: "Update to v\(availableVersion) available."
	}
}

/// How a catalog loop relates to this workspace.
public enum MarketplaceInstallState: Equatable, Sendable {
	case notInstalled
	case installing
	case installed(InstalledLoop)
}
