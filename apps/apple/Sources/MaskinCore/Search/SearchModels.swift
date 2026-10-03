import Foundation

/// What a search result points at. The shell maps each kind onto its own navigation.
public enum SearchKind: String, Sendable, Equatable, Hashable, CaseIterable {
	case object, chat, agent, file

	/// Group order and section titles in the results list (the web's order, minus loops and
	/// automations, which have no server-side search yet).
	public var title: String {
		switch self {
		case .chat: "Chats"
		case .agent: "Agents"
		case .object: "Objects"
		case .file: "Files"
		}
	}

	static let displayOrder: [SearchKind] = [.chat, .agent, .object, .file]
}

/// The scope chips: everything, or one kind.
public enum SearchScope: String, Sendable, Equatable, Hashable, CaseIterable, Identifiable {
	case all, objects, chats, agents, files

	public var id: String { rawValue }

	public var title: String {
		switch self {
		case .all: "All"
		case .objects: "Objects"
		case .chats: "Chats"
		case .agents: "Agents"
		case .files: "Files"
		}
	}

	func includes(_ kind: SearchKind) -> Bool {
		switch self {
		case .all: true
		case .objects: kind == .object
		case .chats: kind == .chat
		case .agents: kind == .agent
		case .files: kind == .file
		}
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
	public var kind: SearchKind
	public var results: [SearchResult]
	public var id: String { kind.rawValue }
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
}
