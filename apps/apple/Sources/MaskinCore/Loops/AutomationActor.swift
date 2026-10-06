import Foundation

/// A person or agent a loop step or trigger refers to, resolved to a name for display and for the
/// trigger's "who runs this" picker.
public struct AutomationActor: Identifiable, Hashable, Sendable, Codable {
	public var id: String
	public var name: String
	public var isAgent: Bool
	public var summary: String?

	public init(id: String, name: String, isAgent: Bool, summary: String? = nil) {
		self.id = id
		self.name = name
		self.isAgent = isAgent
		self.summary = summary
	}
}

/// User-facing failure from the loops/triggers layer. The message is safe to show.
public struct AutomationError: Error, Equatable, Sendable, LocalizedError {
	public let message: String
	public init(_ message: String) { self.message = message }
	public var errorDescription: String? { message }

	static func message(_ error: Error) -> String {
		(error as? AutomationError)?.message ?? "Something went wrong. Check your connection."
	}
}

enum AutomationDates {
	static func parse(_ string: String?) -> Date? {
		guard let string else { return nil }
		let withFraction = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
		return (try? withFraction.parse(string)) ?? (try? Date.ISO8601FormatStyle().parse(string))
	}
}

/// Name lookup shared by every store here: id → actor, with a plain fallback that never shows the id.
public struct ActorDirectory: Sendable, Equatable {
	public private(set) var byID: [String: AutomationActor] = [:]
	public init(_ actors: [AutomationActor] = []) {
		byID = Dictionary(actors.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
	}
	public var all: [AutomationActor] {
		byID.values.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
	}
	public var agents: [AutomationActor] { all.filter(\.isAgent) }
	public func name(_ id: String?) -> String? { id.flatMap { byID[$0]?.name } }
	public func actor(_ id: String?) -> AutomationActor? { id.flatMap { byID[$0] } }
}
