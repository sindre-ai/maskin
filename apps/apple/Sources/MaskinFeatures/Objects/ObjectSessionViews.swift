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
	var isRetrying = false

	static var none: ObjectSessionActions { ObjectSessionActions() }
}

/// Wording and visibility rules for the session cards, pure so they test without rendering.
enum ObjectSessionCopy {
	/// "Developer is working"; without a resolvable agent, "An agent is working".
	static func workingTitle(agentName: String?) -> String {
		agentName.map { "\($0) is working" } ?? "An agent is working"
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

	/// "Sebastian started this session"; nil (row hidden) when nobody resolves.
	static func originLine(starterName: String?, agentName: String?) -> String? {
		if let starterName { return "\(starterName) started this" }
		if let agentName { return "\(agentName) started this" }
		return nil
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

/// "ORIGIN [avatar] Sebastian started this ⌄": opens to the chat, the session and a note.
struct ObjectOriginRow: View {
	@Environment(\.accessibilityReduceMotion) private var reduceMotion
	let session: ObjectSession
	let line: String
	let starterName: String?
	let actions: ObjectSessionActions
	@State private var open = false

	var body: some View {
		VStack(alignment: .leading, spacing: 0) {
			Button {
				withAnimation(reduceMotion ? nil : MaskinMotion.quick) { open.toggle() }
			} label: {
				HStack(spacing: MaskinSpace.s5) {
					Text("ORIGIN")
						.font(MaskinTypeface.sans(MaskinFontSize.t12, weight: .bold, relativeTo: .caption))
						.tracking(MaskinSpace.s1).foregroundStyle(MaskinColor.ink5)
					if let starterName {
						ActorAvatar(name: starterName, kind: .human, size: MaskinSpace.s12, seed: session.createdByActorID ?? "")
					}
					Text(line).maskinText(.subhead).foregroundStyle(MaskinColor.ink2)
						.frame(maxWidth: .infinity, alignment: .leading)
					Image(systemName: "chevron.down").maskinSymbol(MaskinFontSize.t12, weight: .bold)
						.foregroundStyle(MaskinColor.ink5).rotationEffect(.degrees(open ? 180 : 0))
				}
				.frame(minHeight: MaskinSpace.touchMin)
				.contentShape(Rectangle())
			}
			.buttonStyle(.plain)
			.accessibilityHint(open ? "Collapses" : "Expands")
			if open {
				VStack(alignment: .leading, spacing: MaskinSpace.s3) {
					if let chat = session.chatID, let openChat = actions.onOpenChat {
						row("Chat", symbol: "message") { openChat(chat) }
					}
					if let log = actions.onSeeLog {
						row("Session", symbol: "terminal") { log(session) }
					}
					Text("Written by the system. Not editable.")
						.maskinText(.caption).foregroundStyle(MaskinColor.ink5)
				}
				.padding(.bottom, MaskinSpace.s5)
			}
		}
		.padding(.horizontal, MaskinSpace.s8)
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
