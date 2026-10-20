import Foundation
import MaskinCore

// Pure logic behind the Apple TV screens. It lives in MaskinFeatures (no UI imports, no platform
// gate) so `swift test` covers it on the Mac; the tvOS views in `Apps/MaskinTV` only render it.

/// Quick-reply chips under a Team thread: up to three, picked from what was last said so the
/// answers fit without any typing.
public enum TVQuickReplies {
	public static func chips(lastMessage: String?) -> [String] {
		let text = (lastMessage ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
		if text.hasSuffix("?") { return ["Yes", "No", "Tell me more"] }
		if text.isEmpty { return ["Hello", "What needs me?", "Thanks"] }
		return ["Thanks", "Got it", "Show me"]
	}
}

/// The Search screen's suggestion chips and the "UNDERSTOOD AS" line over the answer.
public enum TVSearchGuide {
	public static let suggestions = ["What needs me?", "Northwind", "Outreach", "Pricing"]

	/// How the query was read: which kinds of result it found, in the order they are listed.
	public static func understoodAs(query: String, sections: [SearchSection]) -> String? {
		let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
		guard !trimmed.isEmpty else { return nil }
		let found = sections.filter { !$0.results.isEmpty }
		guard !found.isEmpty else { return "Nothing in the workspace matches \u{201C}\(trimmed)\u{201D}" }
		let kinds = found.map { $0.group.title.lowercased() }
		let list = kinds.count > 1 ? kinds.dropLast().joined(separator: ", ") + " and " + kinds[kinds.count - 1] : kinds[0]
		let total = found.reduce(0) { $0 + $1.results.count }
		return "\u{201C}\(trimmed)\u{201D} in \(list), \(total) \(total == 1 ? "result" : "results")"
	}
}

/// The Profile screen: which rows exist and what they open.
public enum TVProfileRow: String, CaseIterable, Identifiable, Sendable {
	case agents, marketplace, artefacts, settings, autonomy

	public var id: String { rawValue }

	public enum Section: String, Sendable { case workspace = "WORKSPACE", you = "YOU" }

	public var section: Section {
		switch self {
		case .agents, .marketplace, .artefacts: .workspace
		case .settings, .autonomy: .you
		}
	}

	public var title: String {
		switch self {
		case .agents: "Agents"
		case .marketplace: "Marketplace"
		case .artefacts: "Artefacts"
		case .settings: "Settings"
		case .autonomy: "Autonomy"
		}
	}

	public var symbol: String {
		switch self {
		case .agents: "person.2"
		case .marketplace: "square.grid.2x2"
		case .artefacts: "doc.text"
		case .settings: "gearshape"
		case .autonomy: "slider.horizontal.3"
		}
	}

	public static func rows(in section: Section) -> [TVProfileRow] { allCases.filter { $0.section == section } }
}

/// What the Decision screen tells the reader before an option that can't be taken back.
public enum TVConfirmCopy {
	public static func message(for option: DecisionOption) -> String {
		let lines = option.consequences.filter { !$0.isEmpty }
		return lines.isEmpty ? "This can't be undone once it goes out." : lines.joined(separator: "\n")
	}
}

/// Handoff: "Continue on iPhone" for a decision or object. The iPhone app opens the same
/// `maskin://` link a Top Shelf item uses.
public struct TVHandoff: Equatable, Sendable {
	public static let activityType = "io.maskin.app.continue"

	public let workspaceId: String
	public let objectId: String
	public let title: String

	public init(workspaceId: String, objectId: String, title: String) {
		self.workspaceId = workspaceId
		self.objectId = objectId
		self.title = title
	}

	public var url: URL { DeepLink.object(workspaceId: workspaceId, id: objectId).url }
	public var userInfo: [String: String] { ["url": url.absoluteString] }

	public func makeActivity() -> NSUserActivity {
		let activity = NSUserActivity(activityType: Self.activityType)
		activity.title = title
		activity.userInfo = userInfo
		activity.webpageURL = DeepLink.object(workspaceId: workspaceId, id: objectId).universalURL()
		activity.isEligibleForHandoff = true
		return activity
	}
}

// MARK: Device-code sign-in seam

/// What the TV shows while the reader approves the sign-in on their iPhone.
public struct TVDeviceCodePrompt: Equatable, Sendable {
	public var userCode: String
	public var verificationURL: URL
	public var expiresAt: Date
	public var pollInterval: TimeInterval

	public init(userCode: String, verificationURL: URL, expiresAt: Date, pollInterval: TimeInterval = 5) {
		self.userCode = userCode
		self.verificationURL = verificationURL
		self.expiresAt = expiresAt
		self.pollInterval = pollInterval
	}
}

public enum TVDeviceCodeOutcome: Equatable, Sendable {
	case pending
	case approved(apiKey: String, workspaceId: String)
	case denied
	case expired
}

/// The sign-in that avoids typing a password on a TV. The backend endpoint it needs does not exist
/// yet (a separate change); until it does, `TVDeviceCodeUnavailable` is the only conformer and the
/// app keeps using `GlanceLogin`. Wire a real `APITVDeviceCodeSource` here when the endpoint ships.
public protocol TVDeviceCodeSource: Sendable {
	func start() async throws -> TVDeviceCodePrompt
	func poll(userCode: String) async throws -> TVDeviceCodeOutcome
}

public struct TVDeviceCodeUnavailable: TVDeviceCodeSource {
	public struct Unavailable: Error, Equatable {}
	public init() {}
	public func start() async throws -> TVDeviceCodePrompt { throw Unavailable() }
	public func poll(userCode: String) async throws -> TVDeviceCodeOutcome { throw Unavailable() }
}

/// The "held 2d" tag on a decision that has been waiting a while.
public enum TVDecisionAge {
	public static func heldTag(since date: Date, now: Date = Date()) -> String? {
		let hours = Int(now.timeIntervalSince(date) / 3600)
		if hours >= 48 { return "held \(hours / 24)d" }
		if hours >= 24 { return "held 1d" }
		return nil
	}
}

/// The For you card's option row: the recommended option (else the first) and how many others hide
/// behind "+ n more". The Decision screen lists every option.
public enum TVCardOptions {
	public static func summary(labels: [String], recommended: String?) -> (primary: String?, more: Int) {
		let primary = recommended.flatMap { labels.contains($0) ? $0 : nil } ?? labels.first
		return (primary, max(0, labels.count - (primary == nil ? 0 : 1)))
	}
}
