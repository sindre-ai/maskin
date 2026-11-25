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
		case .team: "Chats"
		case .agents: "Agents"
		case .flows: "Flows"
		case .objects: "Items"
		case .files: "Files"
		}
	}

	static let displayOrder: [SearchGroup] = [.team, .agents, .flows, .objects, .files]
}

/// The scope chips: everything, or one of Team, Objects, Flows, Agents, Files. Objects narrow further by
/// type through `SearchScope.objectTypes(in:)` (the sub-chips).
public enum SearchScope: String, Sendable, Equatable, Hashable, CaseIterable, Identifiable {
	case all, team, objects, flows, agents, files

	public var id: String { rawValue }

	/// The chips the search tab offers, in order.
	public static let chips: [SearchScope] = [.all, .objects, .team, .flows, .files]

	public var title: String {
		switch self {
		case .all: "All"
		case .team: "Chats"
		case .objects: "Items"
		case .flows: "Flows"
		case .agents: "Agents"
		case .files: "Files"
		}
	}

	/// Whether a result belongs in this scope. `objectType` narrows `.objects` to one type.
	func includes(_ result: SearchResult, objectType: String? = nil) -> Bool {
		switch self {
		case .all: true
		case .team: result.group == .team
		case .agents: result.group == .agents
		case .flows: result.group == .flows
		case .files: result.group == .files
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
		snippet: String = "", detail: String? = nil, updatedAt: Date? = nil
	) {
		self.kind = kind
		self.entityId = entityId
		self.title = title
		self.subtitle = subtitle
		self.snippet = snippet
		self.detail = detail
		self.updatedAt = updatedAt
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

/// What the server search answered: its rows in its own order, and whether some of its sources failed.
public struct SearchAnswer: Sendable, Equatable {
	public var results: [SearchResult]
	/// Some sources failed while the others answered, so counts may be understated.
	public var isPartial: Bool

	public init(results: [SearchResult], isPartial: Bool = false) {
		self.results = results
		self.isPartial = isPartial
	}
}

/// Everything Search needs from the server. The production implementation is `APISearchRemote`;
/// tests supply a fake.
public protocol SearchRemote: Sendable {
	/// `GET /api/search`: chats, flows, agents and items, matched and ordered by the server, the same
	/// answer in the same order as the web. `participants` (actor ids) keeps only the chats all of
	/// them are in; the other sources then answer nothing.
	func search(query: String, participants: [String], limit: Int) async throws -> SearchAnswer
	/// `GET /api/files?q=` (server-side match on file name). Files are not in the server search.
	func searchFiles(query: String, limit: Int) async throws -> [SearchResult]
	/// Every person and agent in the workspace, for the @ menu.
	func people() async throws -> [SearchPerson]
}

extension SearchRemote {
	public func people() async throws -> [SearchPerson] { [] }
}
