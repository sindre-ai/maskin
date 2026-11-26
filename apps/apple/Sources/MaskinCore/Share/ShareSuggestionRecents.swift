import Foundation

/// The agents the share sheet's top row offers: the ones the person chatted with most recently,
/// per workspace, newest first. iOS shows whatever the app donated, so keeping this list short is
/// what keeps the row short: an agent that falls off the end is no longer donated.
public final class ShareSuggestionRecents: @unchecked Sendable {
	/// The most agents the row offers.
	public static let limit = 7

	public struct Entry: Codable, Equatable, Sendable {
		public var id: String
		public var name: String
		public init(id: String, name: String) {
			self.id = id
			self.name = name
		}
	}

	private let defaults: UserDefaults
	private let key = "maskin.share.suggestionRecents"

	public init(defaults: UserDefaults) { self.defaults = defaults }

	/// The agents of `workspaceId`, newest first.
	public func entries(workspaceId: String) -> [Entry] { all()[workspaceId] ?? [] }

	/// Puts `entry` first. Returns the agents that no longer fit, so their donations can be removed.
	@discardableResult
	public func promote(_ entry: Entry, workspaceId: String) -> [Entry] {
		guard !entry.id.isEmpty else { return [] }
		let kept = [entry] + entries(workspaceId: workspaceId).filter { $0.id != entry.id }
		return write(kept, workspaceId: workspaceId)
	}

	/// Keeps only the agents in `current` (a renamed one takes its new name, a deleted one goes).
	/// Returns the ones removed.
	@discardableResult
	public func reconcile(with current: [Entry], workspaceId: String) -> [Entry] {
		let names = Dictionary(current.map { ($0.id, $0.name) }, uniquingKeysWith: { first, _ in first })
		let before = entries(workspaceId: workspaceId)
		var kept: [Entry] = []
		for entry in before {
			if let name = names[entry.id] { kept.append(Entry(id: entry.id, name: name)) }
		}
		save(kept, workspaceId: workspaceId)
		return before.filter { names[$0.id] == nil }
	}

	/// Forgets everything (sign-out).
	public func removeAll() { defaults.removeObject(forKey: key) }

	private func write(_ list: [Entry], workspaceId: String) -> [Entry] {
		save(Array(list.prefix(Self.limit)), workspaceId: workspaceId)
		return Array(list.dropFirst(Self.limit))
	}

	private func save(_ list: [Entry], workspaceId: String) {
		var all = all()
		all[workspaceId] = list.isEmpty ? nil : list
		defaults.set(try? JSONEncoder().encode(all), forKey: key)
	}

	private func all() -> [String: [Entry]] {
		defaults.data(forKey: key).flatMap { try? JSONDecoder().decode([String: [Entry]].self, from: $0) } ?? [:]
	}
}
