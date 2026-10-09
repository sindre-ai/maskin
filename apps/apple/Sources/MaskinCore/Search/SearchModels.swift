import Foundation

/// What a search result points at. The shell maps each kind onto its own navigation. Flows are
/// loop objects, so they stay `.object` here and open like any object; `SearchGroup` separates them.
public enum SearchKind: String, Sendable, Equatable, Hashable, CaseIterable {
	case object, chat, agent, file
}

/// The sections of the results list, in display order.
public enum SearchGroup: String, Sendable, Equatable, Hashable, CaseIterable {
	case team, agents, flows, objects, files

	public var title: String {
		switch self {
		case .team: "Team"
		case .agents: "Agents"
		case .flows: "Flows"
		case .objects: "Objects"
		case .files: "Files"
		}
	}

	static let displayOrder: [SearchGroup] = [.team, .agents, .flows, .objects, .files]
}

/// The scope chips: everything, or one of Team, Objects, Flows, Agents. Objects narrow further by
/// type through `SearchScope.objectTypes(in:)` (the sub-chips). Files appear under All only.
public enum SearchScope: String, Sendable, Equatable, Hashable, CaseIterable, Identifiable {
	case all, team, objects, flows, agents

	public var id: String { rawValue }

	/// The chips the search tab offers, in order.
	public static let chips: [SearchScope] = [.all, .team, .objects, .flows, .agents]

	public var title: String {
		switch self {
		case .all: "All"
		case .team: "Team"
		case .objects: "Objects"
		case .flows: "Flows"
		case .agents: "Agents"
		}
	}

	/// Whether a result belongs in this scope. `objectType` narrows `.objects` to one type.
	func includes(_ result: SearchResult, objectType: String? = nil) -> Bool {
		switch self {
		case .all: true
		case .team: result.group == .team
		case .agents: result.group == .agents
		case .flows: result.group == .flows
		case .objects:
			result.group == .objects && (objectType == nil || result.detail == objectType)
		}
	}

	/// The object types present in `results` (flows excluded), most frequent first, then by name.
	/// These are the sub-chips under Objects.
	public static func objectTypes(in results: [SearchResult]) -> [String] {
		var counts: [String: Int] = [:]
		for result in results where result.group == .objects {
			if let type = result.detail, !type.isEmpty { counts[type, default: 0] += 1 }
		}
		return counts.keys.sorted { (counts[$0]!, $1) > (counts[$1]!, $0) }
	}
}

/// One search hit. `id` is the entity id (object / conversation / agent / file); `title` is always
/// a resolved name, never an id.
public struct SearchResult: Identifiable, Sendable, Equatable, Hashable {
	public var kind: SearchKind
	public var entityId: String
	public var title: String
	/// Muted suffix on the title line: status for objects, participants for chats, mime for files.
	public var subtitle: String
	public var snippet: String
	/// Object type (`task`, `bet`...) for objects; mime type for files.
	public var detail: String?
	public var updatedAt: Date?
	/// Text the client-side filter matches against (chats and agents have no server search).
	public var searchableText: String

	public var id: String { "\(kind.rawValue):\(entityId)" }

	/// Flows are loop objects.
	public var isFlow: Bool { kind == .object && detail == "loop" }

	/// The section this result is listed under.
	public var group: SearchGroup {
		switch kind {
		case .chat: .team
		case .agent: .agents
		case .file: .files
		case .object: isFlow ? .flows : .objects
		}
	}

	public init(
		kind: SearchKind, entityId: String, title: String, subtitle: String = "",
		snippet: String = "", detail: String? = nil, updatedAt: Date? = nil,
		searchableText: String? = nil
	) {
		self.kind = kind
		self.entityId = entityId
		self.title = title
		self.subtitle = subtitle
		self.snippet = snippet
		self.detail = detail
		self.updatedAt = updatedAt
		self.searchableText = searchableText ?? [title, subtitle, snippet].joined(separator: "\n")
	}
}

public struct SearchSection: Identifiable, Sendable, Equatable {
	public var group: SearchGroup
	public var results: [SearchResult]
	public var id: String { group.rawValue }
}

public struct SearchError: Error, Equatable, Sendable {
	public var message: String
	public var isOffline: Bool

	public init(_ message: String, isOffline: Bool = false) {
		self.message = message
		self.isOffline = isOffline
	}
}

/// Everything Search needs from the server. The production implementation wraps the generated
/// client (`APISearchRemote`); tests supply a fake.
public protocol SearchRemote: Sendable {
	/// `GET /api/objects/search?q=` (server-side match on title and content).
	func searchObjects(query: String, limit: Int) async throws -> [SearchResult]
	/// `GET /api/files?q=` (server-side match on file name).
	func searchFiles(query: String, limit: Int) async throws -> [SearchResult]
	/// `GET /api/conversations`, newest first. No `q` parameter exists, so the store filters.
	func conversations() async throws -> [SearchResult]
	/// Agent actors (`GET /api/actors`, `type == agent`). No `q` parameter, so the store filters.
	func agents() async throws -> [SearchResult]
	/// The workspace's flows (loop objects). No `q` parameter, so the store filters by name.
	func flows() async throws -> [SearchResult]
}

extension SearchRemote {
	public func flows() async throws -> [SearchResult] { [] }
}
