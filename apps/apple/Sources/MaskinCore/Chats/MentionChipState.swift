import Foundation

/// Where a tagged person or agent stands, shown under your message (spec 7 audit, "@ chip states").
/// "Can't join" needs a membership check the API does not offer here yet, so it is not derived.
public enum MentionChipState: Equatable, Sendable {
	case tagged, working, replied, waiting

	/// The chip text: `Relay · Working`, `Relay · Replied`, `Waiting for Sam`.
	public func label(name: String) -> String {
		switch self {
		case .tagged: "\(name) · Tagged"
		case .working: "\(name) · Working"
		case .replied: "\(name) · Replied"
		case .waiting: "Waiting for \(name)"
		}
	}

	/// Replied wins, then a running agent; an unanswered person is waited for; an agent that
	/// has not started is simply tagged.
	public static func resolve(
		mentionedID: String, kind: ChatParticipant.Kind?, after message: ChatMessage,
		in messages: [ChatMessage], working: Bool
	) -> MentionChipState {
		if let index = messages.firstIndex(where: { $0.id == message.id }),
			messages[(index + 1)...].contains(where: { $0.actorID == mentionedID })
		{
			return .replied
		}
		if working { return .working }
		return kind == .human ? .waiting : .tagged
	}
}

public struct MentionStateChip: Equatable, Sendable, Identifiable {
	public var id: String
	public var name: String
	public var state: MentionChipState
	public init(id: String, name: String, state: MentionChipState) {
		self.id = id
		self.name = name
		self.state = state
	}
	public var label: String { state.label(name: name) }
}
