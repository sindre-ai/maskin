import Foundation

#if os(iOS) && canImport(ActivityKit)
	import ActivityKit
#endif

// Live Activities for the two kinds of time-bound work the design names besides an agent turn:
// a flow cycle running now, and a live meeting. Both are pure values here so they test without a
// device. Nothing in the app drives them yet: there is no cycle number or progress in the loop
// models and no meeting model, so the host is wired but has no caller (see the report).

/// A flow cycle's changing part. Driven by cycle state, never by a timer.
public struct CycleActivityState: Codable, Hashable, Sendable {
	public enum Phase: String, Codable, Sendable, Equatable {
		case running
		/// The cycle ended and the reader has to review: Review / Later, then the card ends.
		case needsYou
	}

	public static let maxFlowNameLength = 40
	public static let maxSummaryLength = 90
	/// A "needs you" card ends after the reader opens it, or after this long.
	public static let needsYouLifetime: TimeInterval = 8 * 60 * 60

	public var flowName: String
	/// 1-based cycle number, shown as "CYCLE 12".
	public var cycle: Int
	/// "Verify". Empty when the cycle has no named stage.
	public var stage: String
	/// 0...1, clamped.
	public var progress: Double
	/// One sentence of who is doing what: "Writer is drafting follow-ups. Step 2 of 3."
	public var summary: String
	public var phase: Phase
	/// Who the summary starts with ("Writer"), shown bold. `nil` when the summary has no lead name.
	public var actor: String?

	public init(
		flowName: String, cycle: Int, stage: String = "", progress: Double, summary: String,
		phase: Phase = .running, actor: String? = nil
	) {
		self.flowName = Self.clamp(flowName, to: Self.maxFlowNameLength, fallback: "Flow")
		self.cycle = max(1, cycle)
		self.stage = stage.trimmingCharacters(in: .whitespacesAndNewlines)
		self.progress = progress.isFinite ? min(1, max(0, progress)) : 0
		self.summary = Self.clamp(summary, to: Self.maxSummaryLength, fallback: "")
		self.phase = phase
		let lead = actor?.trimmingCharacters(in: .whitespacesAndNewlines)
		self.actor = lead?.isEmpty == false ? lead : nil
	}

	/// The summary split into its bold lead name and the rest ("Writer" + " is drafting ..."), or
	/// `nil` when the summary does not start with the actor.
	public var summaryParts: (actor: String, rest: String)? {
		guard let actor, summary.hasPrefix(actor) else { return nil }
		return (actor, String(summary.dropFirst(actor.count)))
	}

	public var percent: Int { Int((progress * 100).rounded()) }

	/// "CYCLE 12 · VERIFY"
	public var eyebrow: String {
		let base = "Cycle \(cycle)"
		return (stage.isEmpty ? base : "\(base) \u{00B7} \(stage)").uppercased()
	}

	public var isTerminal: Bool { phase == .needsYou }

	private static func clamp(_ text: String, to limit: Int, fallback: String) -> String {
		let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
		if trimmed.isEmpty { return fallback }
		return trimmed.count > limit ? String(trimmed.prefix(limit - 1)) + "\u{2026}" : trimmed
	}
}

/// A live meeting's changing part. The timer is `startedAt`, rendered by the system.
public struct MeetingActivityState: Codable, Hashable, Sendable {
	public static let maxNameLength = 40

	public var name: String
	public var startedAt: Date
	public var muted: Bool
	/// "AD HOC MEETING" or "DAILY BRIEFING".
	public var kind: Kind

	public enum Kind: String, Codable, Sendable, Equatable {
		case adHoc, dailyBriefing

		public var eyebrow: String {
			switch self {
			case .adHoc: "LIVE \u{00B7} AD HOC MEETING"
			case .dailyBriefing: "LIVE \u{00B7} DAILY BRIEFING"
			}
		}
	}

	public init(name: String, startedAt: Date, muted: Bool = false, kind: Kind = .adHoc) {
		let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
		self.name = trimmed.isEmpty ? "Maskin" : String(trimmed.prefix(Self.maxNameLength))
		self.startedAt = startedAt
		self.muted = muted
		self.kind = kind
	}
}

#if os(iOS) && canImport(ActivityKit)
	public struct MaskinCycleAttributes: ActivityAttributes {
		public typealias ContentState = CycleActivityState

		public let flowId: String
		public let workspaceId: String
		/// The flow's object, for the tap target. `nil` opens the inbox.
		public let objectId: String?

		public init(flowId: String, workspaceId: String, objectId: String?) {
			self.flowId = flowId
			self.workspaceId = workspaceId
			self.objectId = objectId
		}

		public var openURL: URL {
			if let objectId { return DeepLink.object(workspaceId: workspaceId, id: objectId).url }
			return DeepLink.notifications(workspaceId: workspaceId).url
		}
	}

	public struct MaskinMeetingAttributes: ActivityAttributes {
		public typealias ContentState = MeetingActivityState

		public let meetingId: String
		public let workspaceId: String
		public let conversationId: String?

		public init(meetingId: String, workspaceId: String, conversationId: String?) {
			self.meetingId = meetingId
			self.workspaceId = workspaceId
			self.conversationId = conversationId
		}

		public var openURL: URL {
			if let conversationId { return DeepLink.chat(workspaceId: workspaceId, id: conversationId).url }
			return DeepLink.notifications(workspaceId: workspaceId).url
		}
	}
#endif
