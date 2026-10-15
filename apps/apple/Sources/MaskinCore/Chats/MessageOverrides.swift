import Foundation

/// Per-message UI state the server does not hold yet (spec 7 §8 `messageOverrides[id]`): answer
/// versions after "Try again" / "Make it shorter", a stopped stream, local feedback. Kept in
/// `ChatStore.overrides`, keyed by the message's row id. The API has no revision, regenerate or
/// feedback endpoint today, so nothing here round-trips; see the store's stubbed methods.
public struct MessageOverride: Equatable, Sendable {
	/// Alternative texts for one agent answer. Empty until a second version exists; index 0 is
	/// the message's own text.
	public var versions: [String] = []
	public var versionIndex = 0
	/// The agent's turn was stopped before it finished; the bubble says `Stopped`.
	public var stopped = false
	/// "Good answer" / "Not right" recorded locally.
	public var feedback: Feedback?

	public enum Feedback: String, Equatable, Sendable { case good, notRight }

	public init(
		versions: [String] = [], versionIndex: Int = 0, stopped: Bool = false, feedback: Feedback? = nil
	) {
		self.versions = versions
		self.versionIndex = versionIndex
		self.stopped = stopped
		self.feedback = feedback
	}

	/// The text to show for the chosen version; `original` when there are no alternatives.
	public func text(original: String) -> String {
		guard versions.count > 1, versions.indices.contains(versionIndex) else { return original }
		return versions[versionIndex]
	}

	/// `‹ 2/2 ›` is shown only once there is something to switch between.
	public var hasVersions: Bool { versions.count > 1 }
	public var isEmpty: Bool { versions.count <= 1 && !stopped && feedback == nil }
}

/// What an agent in the thread is doing right now, for the nav-bar status line and indicators.
/// One meaning each: typing = composing a reply (dots), working = running a task (bars),
/// replying = picked the message up but no step has arrived yet.
public enum ChatAgentPresence: Equatable, Sendable {
	case typing, replying, working

	/// The nav-bar status word.
	public var label: String {
		switch self {
		case .typing: "typing…"
		case .replying: "replying…"
		case .working: "working"
		}
	}
}

/// The flow a conversation belongs to, for the flow-channel nav bar (spec 7 §4). The API does not
/// link a conversation to a loop yet, so this is set by whoever opens the thread (nil today).
public struct ChatFlowContext: Equatable, Sendable {
	public var loopID: String
	public var name: String
	/// The agent leading the flow; shown first and filled ink in the member stack.
	public var leadID: String?
	public var memberIDs: [String]

	public init(loopID: String, name: String, leadID: String? = nil, memberIDs: [String] = []) {
		self.loopID = loopID
		self.name = name
		self.leadID = leadID
		self.memberIDs = memberIDs
	}
}

/// Where the one pinned message per chat is remembered. The API has no pinned-message field, so
/// the default keeps it on this device, per conversation.
public protocol ChatPinStoring: Sendable {
	func pinnedMessageID(conversationID: String) -> Int?
	func setPinnedMessageID(_ id: Int?, conversationID: String)
}

/// `UserDefaults` is thread-safe but not marked Sendable; this wrapper only reads and writes it.
public struct UserDefaultsChatPinStore: ChatPinStoring, @unchecked Sendable {
	private let defaults: UserDefaults
	public init(defaults: UserDefaults = .standard) { self.defaults = defaults }

	private func key(_ conversationID: String) -> String { "chat.pinnedMessage.\(conversationID)" }

	public func pinnedMessageID(conversationID: String) -> Int? {
		let value = defaults.integer(forKey: key(conversationID))
		return value > 0 ? value : nil
	}

	public func setPinnedMessageID(_ id: Int?, conversationID: String) {
		if let id { defaults.set(id, forKey: key(conversationID)) } else { defaults.removeObject(forKey: key(conversationID)) }
	}
}

/// Keeps nothing between launches; for tests and previews.
public final class MemoryChatPinStore: ChatPinStoring, @unchecked Sendable {
	private var pins: [String: Int] = [:]
	private let lock = NSLock()
	public init() {}

	public func pinnedMessageID(conversationID: String) -> Int? {
		lock.withLock { pins[conversationID] }
	}

	public func setPinnedMessageID(_ id: Int?, conversationID: String) {
		lock.withLock { pins[conversationID] = id }
	}
}
