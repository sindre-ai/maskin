import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// What the item's session cards can do. A closure left nil hides the control that needs it
/// (missing data hides its row).
struct ObjectSessionActions {
	var onWatch: ((ObjectSession) -> Void)?
	var onStop: ((ObjectSession) -> Void)?
	/// Nil until a prompt to run again is known; Retry stays hidden meanwhile.
	var onRetry: ((ObjectSession) -> Void)?
	var onSeeLog: ((ObjectSession) -> Void)?
	var onOpenChat: ((String) -> Void)?
	/// Opens the log of the session that produced the item (the origin panel's Session row).
	var onOpenOriginSession: ((ObjectOrigin) -> Void)?
	var isRetrying = false

	static var none: ObjectSessionActions { ObjectSessionActions() }
}

/// Wording and visibility rules for the session cards, pure so they test without rendering.
enum ObjectSessionCopy {
	/// "Developer is thinking"; without a resolvable agent, "An agent is thinking". Same words as web.
	static func thinkingTitle(agentName: String?) -> String {
		agentName.map { "\($0) is thinking" } ?? "An agent is thinking"
	}

	/// "12s" under a minute, then "1m 5s"; nil before the session has a start time.
	static func elapsed(since start: Date?, now: Date) -> String? {
		guard let start else { return nil }
		let seconds = max(0, Int(now.timeIntervalSince(start)))
		return seconds < 60 ? "\(seconds)s" : "\(seconds / 60)m \(seconds % 60)s"
	}

	/// "Forge asks:"; without a name, "Open question:" (web's words).
	static func askLead(askedBy: String?) -> String {
		guard let askedBy, !askedBy.isEmpty else { return "Open question:" }
		return "\(askedBy) asks:"
	}

	/// The words before the age in "Spawned by Forge, 2h ago".
	static func spawnedBy(agentName: String?) -> String {
		"Spawned by \(agentName ?? "an agent")"
	}

	/// "Developer stopped: 403 from Search Console"; the server's reason or a plain fallback.
	static func failedTitle(agentName: String?, reason: String?) -> String {
		let who = agentName ?? "The agent"
		guard let reason, !reason.isEmpty else { return "\(who) stopped" }
		return "\(who) stopped: \(reason)"
	}

	static let failedFallback = "The run ended before it finished."

	/// A failed card shows only for a failed last session with nothing running now.
	static func showsFailed(_ session: ObjectSession?, hasActiveSession: Bool) -> Bool {
		guard let session, session.isFailed else { return false }
		return !hasActiveSession
	}

}

/// "Developer stopped: …" with the reason, Retry and See log.
struct FailedSessionBanner: View {
	let agentName: String?
	let session: ObjectSession
	let actions: ObjectSessionActions

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s4) {
			HStack(alignment: .firstTextBaseline, spacing: MaskinSpace.s5) {
				Circle().fill(MaskinColor.dangerStrong).frame(width: MaskinSpace.s4, height: MaskinSpace.s4)
					.accessibilityHidden(true)
				Text(ObjectSessionCopy.failedTitle(agentName: agentName, reason: nil))
					.font(MaskinTypeface.sans(MaskinFontSize.t15, weight: .semibold, relativeTo: .body))
					.foregroundStyle(MaskinColor.ink)
			}
			Text(session.failureReason ?? ObjectSessionCopy.failedFallback)
				.maskinText(.subhead).foregroundStyle(MaskinColor.ink4)
				.fixedSize(horizontal: false, vertical: true)
			HStack(spacing: MaskinSpace.s8) {
				if let retry = actions.onRetry {
					Button(actions.isRetrying ? "Retrying…" : "Retry") { retry(session) }
						.disabled(actions.isRetrying)
						.foregroundStyle(MaskinColor.sigInk)
				}
				if let log = actions.onSeeLog {
					Button("See log") { log(session) }.foregroundStyle(MaskinColor.ink)
				}
			}
			.font(MaskinTypeface.sans(MaskinFontSize.t15, weight: .semibold, relativeTo: .body))
			.buttonStyle(.plain)
		}
		.frame(maxWidth: .infinity, alignment: .leading)
		.padding(MaskinSpace.s8)
		.background(MaskinSurface.fill, in: RoundedRectangle(cornerRadius: MaskinRadius.panelXl, style: .continuous))
		.accessibilityElement(children: .contain)
	}
}

/// The origin panel under the meta line: the chat that started the session and the session
/// itself. Nothing in it is editable.
struct ObjectOriginPanel: View {
	let origin: ObjectOrigin
	let actions: ObjectSessionActions

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s3) {
			if let chat = origin.chatId, let openChat = actions.onOpenChat {
				row("Chat", symbol: "message") { openChat(chat) }
			}
			if let open = actions.onOpenOriginSession {
				row("Session", symbol: "terminal") { open(origin) }
			}
			Text("Written by the system. Not editable.")
				.maskinText(.caption).foregroundStyle(MaskinColor.ink5)
		}
		.padding(.horizontal, MaskinSpace.s8)
		.padding(.vertical, MaskinSpace.s3)
		.frame(maxWidth: .infinity, alignment: .leading)
		.background(MaskinSurface.fill, in: RoundedRectangle(cornerRadius: MaskinRadius.panelXl, style: .continuous))
	}

	private func row(_ title: String, symbol: String, action: @escaping () -> Void) -> some View {
		Button(action: action) {
			HStack(spacing: MaskinSpace.s5) {
				Image(systemName: symbol).foregroundStyle(MaskinColor.ink4)
				Text(title).foregroundStyle(MaskinColor.ink)
				Spacer(minLength: 0)
				Image(systemName: "chevron.right").maskinSymbol(MaskinFontSize.t12, weight: .bold)
					.foregroundStyle(MaskinColor.ink5)
			}
			.maskinText(.subhead)
			.frame(minHeight: MaskinSpace.touchMin)
			.contentShape(Rectangle())
		}
		.buttonStyle(.plain)
	}
}

/// Which way the item composer sends: a comment on the item, or a message to its agent's chat.
enum ObjectComposerMode: Equatable {
	case comment, message

	/// The agent to message: the one running now, else the item's driver, only if it is an agent.
	static func target(object: WorkObject?, actor: (String?) -> ActorRef?) -> ActorRef? {
		let id = object?.lastSession.flatMap { $0.isLive ? $0.agentID : nil } ?? object?.driverId
		guard let found = actor(id), found.isAgent else { return nil }
		return found
	}

	/// The comment box's own words: "Type / for commands or @ to mention", shorter on a phone.
	static func commentPlaceholder(compact: Bool) -> String {
		compact ? "Type / or @" : "Type / for commands or @ to mention"
	}

	/// "Comment", "Message Forge"; on a phone in message mode just "Message".
	static func chipTitle(_ mode: ObjectComposerMode, agentName: String, compact: Bool) -> String {
		switch mode {
		case .comment: "Comment"
		case .message: compact ? "Message" : "Message \(agentName)"
		}
	}

	/// In message mode the field reads "Message Forge" ("Message" on a phone, where the chip is as short).
	func placeholder(commentPlaceholder: String, agentName: String?, compact: Bool = false) -> String {
		switch (self, agentName) {
		case (.message, let name?): return compact ? "Message" : "Message \(name)"
		default: return commentPlaceholder
		}
	}
}

/// The small chip inside the comment bar: "Comment" or "Message {agent}", opening a two-way menu.
/// On a phone the message label drops the name, as web does ("Message"); the menu still names it.
struct ObjectComposerModeChip: View {
	@Binding var mode: ObjectComposerMode
	let agentName: String
	var compact = false

	var body: some View {
		Menu {
			choice("Comment", .comment)
			choice("Message \(agentName)", .message)
		} label: {
			HStack(spacing: MaskinSpace.s2) {
				Text(ObjectComposerMode.chipTitle(mode, agentName: agentName, compact: compact))
					.font(MaskinTypeface.sans(MaskinFontSize.t13, weight: .semibold, relativeTo: .footnote))
					.lineLimit(1)
				Image(systemName: "chevron.down").maskinSymbol(MaskinFontSize.t12, weight: .bold)
			}
			.foregroundStyle(MaskinColor.ink2)
			.padding(.horizontal, MaskinSpace.s5)
			.frame(minHeight: MaskinSpace.s14)
			.background(MaskinSurface.fill, in: Capsule())
			.frame(minHeight: MaskinSpace.touchMin)
			.contentShape(Rectangle())
		}
		.accessibilityLabel("Switch between comment and message")
		.accessibilityValue(ObjectComposerMode.chipTitle(mode, agentName: agentName, compact: false))
	}

	@ViewBuilder private func choice(_ title: String, _ value: ObjectComposerMode) -> some View {
		Button {
			MaskinHaptics.play(.selection)
			mode = value
		} label: {
			if mode == value { Label(title, systemImage: "checkmark") } else { Text(title) }
		}
	}
}

/// "Comment | Message {agent}": two pills above the composer.
struct ObjectComposerModeToggle: View {
	@Binding var mode: ObjectComposerMode
	let agentName: String

	var body: some View {
		HStack(spacing: MaskinSpace.s3) {
			pill("Comment", .comment)
			pill("Message \(agentName)", .message)
			Spacer(minLength: 0)
		}
		.padding(.horizontal, MaskinSpace.s5)
	}

	private func pill(_ title: String, _ value: ObjectComposerMode) -> some View {
		let active = mode == value
		return Button {
			MaskinHaptics.play(.selection)
			mode = value
		} label: {
			Text(title)
				.font(MaskinTypeface.sans(MaskinFontSize.t14, weight: .semibold, relativeTo: .subheadline))
				.foregroundStyle(active ? MaskinSurface.onInverse : MaskinColor.ink)
				.lineLimit(1)
				.padding(.horizontal, MaskinSpace.s7)
				.frame(minHeight: MaskinSpace.s14)
				.background(active ? MaskinSurface.inverse : MaskinSurface.card, in: Capsule())
				.overlay(Capsule().strokeBorder(MaskinSurface.line, lineWidth: 0.5))
				.contentShape(Capsule())
		}
		.buttonStyle(.maskinPressed(.shrink))
		.accessibilityAddTraits(active ? .isSelected : [])
	}
}
