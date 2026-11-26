import Foundation

/// An agent offered in the top row of the iOS share sheet. The app writes it into the conversation
/// identifier of the message action it donates, and the share extension reads it back when the
/// person taps that agent. Ids only, never names or shared content.
public struct ShareSuggestion: Equatable, Sendable {
	public var workspaceId: String
	public var agentID: String

	public init(workspaceId: String, agentID: String) {
		self.workspaceId = workspaceId
		self.agentID = agentID
	}

	private static let prefix = "maskin.share.agent"

	/// The conversation identifier of the donated action.
	public var conversationIdentifier: String { "\(Self.prefix):\(workspaceId):\(agentID)" }

	/// The suggestion behind `identifier`, or `nil` when it isn't one of ours.
	public init?(conversationIdentifier identifier: String?) {
		guard let identifier else { return nil }
		let parts = identifier.split(separator: ":", omittingEmptySubsequences: false)
		guard parts.count == 3, parts[0] == Self.prefix, !parts[1].isEmpty, !parts[2].isEmpty else { return nil }
		self.init(workspaceId: String(parts[1]), agentID: String(parts[2]))
	}
}
