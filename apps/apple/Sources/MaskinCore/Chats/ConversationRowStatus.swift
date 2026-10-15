import Foundation

/// The second line of a Team row (spec 7 §6, "Live row status"). Pure: every signal arrives as a
/// value so the precedence (typing beats a draft beats working beats the plain preview) is tested
/// without a view.
public struct ConversationRowStatus: Equatable, Sendable {
	/// What the latest outgoing message is doing. `read` needs read receipts, which the API does
	/// not report yet; the case exists so the row is ready when it does.
	public enum Tick: Equatable, Sendable {
		case sending, sent, read, failed

		public var symbol: String {
			switch self {
			case .sending: "…"
			case .sent: "✓"
			case .read: "✓✓"
			case .failed: "!"
			}
		}
	}

	public enum Prefix: Equatable, Sendable {
		/// "typing…" replaces the preview.
		case typing
		/// "▮▮▮ Working ·" (one agent) or "n working ·" before the preview.
		case working(Int)
		case tick(Tick)
	}

	public var prefix: Prefix?
	/// The text after the prefix; empty while typing.
	public var preview: String
	public var isDraft: Bool
	public var mentionsYou: Bool

	public init(prefix: Prefix? = nil, preview: String, isDraft: Bool = false, mentionsYou: Bool = false) {
		self.prefix = prefix
		self.preview = preview
		self.isDraft = isDraft
		self.mentionsYou = mentionsYou
	}

	/// The label for a working prefix.
	public static func workingLabel(_ count: Int) -> String { count <= 1 ? "Working" : "\(count) working" }

	/// What the row says when the conversation has no message yet.
	public static let noMessages = "No messages yet"

	/// - Parameters:
	///   - draft: unsent text for this conversation, if any.
	///   - typing: an agent is composing a reply right now.
	///   - workingAgents: agents in this conversation that are running.
	///   - tick: the state of your latest message when the last message is yours.
	///   - mentionsYou: an unread message mentions you.
	public static func make(
		conversation: ConversationSummary, draft: String? = nil, typing: Bool = false,
		workingAgents: Int = 0, tick: Tick? = nil, mentionsYou: Bool = false
	) -> ConversationRowStatus {
		let mention = mentionsYou && conversation.isUnread
		if typing { return ConversationRowStatus(prefix: .typing, preview: "", mentionsYou: mention) }
		if let draft = draft?.trimmingCharacters(in: .whitespacesAndNewlines), !draft.isEmpty {
			return ConversationRowStatus(preview: "Draft: \(draft)", isDraft: true, mentionsYou: mention)
		}
		let text = conversation.snippet.map(ChatPreviewText.plain) ?? ""
		var preview = text.isEmpty ? noMessages : text
		var prefix: Prefix?
		if workingAgents > 0 {
			prefix = .working(workingAgents)
		} else if let tick {
			prefix = .tick(tick)
		} else if !text.isEmpty, let who = conversation.snippetActorName, !who.isEmpty {
			preview = "\(who): \(text)"
		}
		return ConversationRowStatus(prefix: prefix, preview: preview, mentionsYou: mention)
	}

	/// A flow row: `{agent}: {first clause of the last post}` with a working prefix while agents run.
	public static func make(flow: TeamFlowRoom) -> ConversationRowStatus {
		let text = flow.lastPostText.map(ChatPreviewText.plain) ?? ""
		var preview = text.isEmpty ? noMessages : ChatPreviewText.firstClause(text)
		if !text.isEmpty, let who = flow.lastPostAuthor, !who.isEmpty { preview = "\(who): \(preview)" }
		return ConversationRowStatus(
			prefix: flow.workingCount > 0 ? .working(flow.workingCount) : nil, preview: preview)
	}

	/// What a screen reader hears for the whole line.
	public var accessibilityText: String {
		var parts: [String] = []
		switch prefix {
		case .typing: parts.append("typing")
		case .working(let n): parts.append(Self.workingLabel(n))
		case .tick(.sending): parts.append("sending")
		case .tick(.sent): parts.append("sent")
		case .tick(.read): parts.append("read")
		case .tick(.failed): parts.append("not sent")
		case nil: break
		}
		if !preview.isEmpty { parts.append(preview) }
		if mentionsYou { parts.append("mentions you") }
		return parts.joined(separator: ", ")
	}
}
