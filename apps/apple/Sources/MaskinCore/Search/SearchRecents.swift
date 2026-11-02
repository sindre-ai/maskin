import Foundation

/// Recently run searches, kept per person and workspace in `UserDefaults`, so neither switching
/// workspaces nor a second person on the same device shows someone else's queries. Sign-out calls
/// `clearAll()`.
public struct SearchRecents: @unchecked Sendable {
	public static let limit = 8

	static let keyPrefix = "maskin.search.recents."

	private let defaults: UserDefaults
	private let actorId: String

	public init(defaults: UserDefaults = .standard, actorId: String = "") {
		self.defaults = defaults
		self.actorId = actorId
	}

	private func key(_ workspaceId: String) -> String { "\(Self.keyPrefix)\(actorId).\(workspaceId)" }

	/// Removes every stored recent for every person and workspace (sign-out).
	public static func clearAll(defaults: UserDefaults = .standard) {
		for key in defaults.dictionaryRepresentation().keys where key.hasPrefix(keyPrefix) {
			defaults.removeObject(forKey: key)
		}
	}

	public func load(workspaceId: String) -> [String] {
		defaults.stringArray(forKey: key(workspaceId)) ?? []
	}

	/// Moves `query` to the front (dropping an earlier copy, case-insensitively) and trims to `limit`.
	@discardableResult
	public func push(_ query: String, workspaceId: String) -> [String] {
		let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
		guard !trimmed.isEmpty else { return load(workspaceId: workspaceId) }
		var list = load(workspaceId: workspaceId).filter { $0.caseInsensitiveCompare(trimmed) != .orderedSame }
		list.insert(trimmed, at: 0)
		list = Array(list.prefix(Self.limit))
		defaults.set(list, forKey: key(workspaceId))
		return list
	}

	public func remove(_ query: String, workspaceId: String) -> [String] {
		let list = load(workspaceId: workspaceId).filter { $0 != query }
		defaults.set(list, forKey: key(workspaceId))
		return list
	}

	public func clear(workspaceId: String) {
		defaults.removeObject(forKey: key(workspaceId))
	}
}
