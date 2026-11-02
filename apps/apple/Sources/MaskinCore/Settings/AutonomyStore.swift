import Foundation
import Observation

/// How far the Chief of Staff goes before asking (2E). Per user, per workspace.
public enum AutonomyLevel: String, CaseIterable, Sendable, Codable, Identifiable {
	case askFirst, routineOnly, askOnlyWhenStuck

	public var id: String { rawValue }

	public var title: String {
		switch self {
		case .askFirst: "Ask me first"
		case .routineOnly: "Routine only"
		case .askOnlyWhenStuck: "Ask only when stuck"
		}
	}

	public var summary: String {
		switch self {
		case .askFirst: "Everything outbound or irreversible waits for you"
		case .routineOnly: "Does recurring, undoable work. Asks for the rest"
		case .askOnlyWhenStuck: "Asks only when blocked or spending money"
		}
	}

	/// The thing that is "decided without you" at this level; nil when nothing is.
	var decidedWithoutYou: String? {
		switch self {
		case .askFirst: nil
		case .routineOnly: "recurring, undoable work"
		case .askOnlyWhenStuck: "everything except blocked steps and spending"
		}
	}

	/// Changing level says what changes: "From now on, X is decided without you."
	public var changeLine: String {
		guard let text = decidedWithoutYou else { return "From now on, nothing is decided without you." }
		return "From now on, \(text) is decided without you."
	}
}

/// The rules that always ask, whatever the level. Shown, never switched.
public enum AutonomyAlwaysAsk: String, CaseIterable, Sendable, Identifiable {
	case outsideWorkspace, spendingOver50, deleting

	public var id: String { rawValue }

	public var title: String {
		switch self {
		case .outsideWorkspace: "Sending to people outside the workspace"
		case .spendingOver50: "Spending over $50"
		case .deleting: "Deleting anything"
		}
	}
}

/// Where the chosen level lives. The server has no autonomy setting yet, so the production
/// storage is the device; a server-backed one slots in behind the same protocol.
public protocol AutonomyStoring: Sendable {
	func level(for key: String) -> AutonomyLevel?
	func save(_ level: AutonomyLevel, for key: String)
}

public struct UserDefaultsAutonomyStorage: AutonomyStoring, @unchecked Sendable {
	private let defaults: UserDefaults

	public init(defaults: UserDefaults = .standard) { self.defaults = defaults }

	public func level(for key: String) -> AutonomyLevel? {
		defaults.string(forKey: "autonomy.\(key)").flatMap(AutonomyLevel.init(rawValue:))
	}

	public func save(_ level: AutonomyLevel, for key: String) {
		defaults.set(level.rawValue, forKey: "autonomy.\(key)")
	}
}

@MainActor
@Observable
public final class AutonomyStore {
	public static let defaultLevel = AutonomyLevel.routineOnly

	public private(set) var level: AutonomyLevel
	/// The line shown after a change, until the reader leaves or changes it again.
	public private(set) var changeLine: String?

	@ObservationIgnored private let storage: any AutonomyStoring
	@ObservationIgnored private let key: String

	public init(workspaceID: String, actorID: String, storage: any AutonomyStoring) {
		self.storage = storage
		key = "\(actorID).\(workspaceID)"
		level = storage.level(for: key) ?? Self.defaultLevel
	}

	public func select(_ new: AutonomyLevel) {
		guard new != level else { return }
		level = new
		storage.save(new, for: key)
		changeLine = new.changeLine
	}
}
