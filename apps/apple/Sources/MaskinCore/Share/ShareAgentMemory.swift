import Foundation

/// The agents a person last sent a share to, per workspace, kept in the App Group so the share
/// extension (writes on Send) and the app agree. Holds ids only, never names or shared content.
public final class ShareAgentMemory: @unchecked Sendable {
	/// How many recent agents the picker offers.
	public static let recentCount = 2

	private let defaults: UserDefaults
	private let key = "maskin.share.recentAgents"

	public init(defaults: UserDefaults) { self.defaults = defaults }

	/// The memory in the App Group, or `nil` when this build isn't signed with the group.
	public static func shared() -> ShareAgentMemory? {
		UserDefaults(suiteName: ShareQueue.appGroupIdentifier).map(ShareAgentMemory.init)
	}

	/// Agent ids of `workspaceId`, most recent first.
	public func recent(workspaceId: String) -> [String] {
		all()[workspaceId] ?? []
	}

	/// Puts `agentID` first for `workspaceId`; only the last `recentCount` are kept.
	public func remember(_ agentID: String, workspaceId: String) {
		guard !agentID.isEmpty else { return }
		var all = all()
		let others = (all[workspaceId] ?? []).filter { $0 != agentID }
		all[workspaceId] = Array(([agentID] + others).prefix(Self.recentCount))
		defaults.set(all, forKey: key)
	}

	private func all() -> [String: [String]] {
		defaults.dictionary(forKey: key) as? [String: [String]] ?? [:]
	}
}
