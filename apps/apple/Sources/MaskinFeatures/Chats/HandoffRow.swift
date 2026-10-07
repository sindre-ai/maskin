import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// A sub-agent session, between two messages: an agent was handed work by another agent. Centred
/// and compact: the agent, what it was asked, how it stands and what it reports doing now.
/// Tapping opens the full task and, once it ended, the note it left. Everything is the session's
/// own data (`spawned_sessions` on the message); the server has no step list, so none is shown.
struct HandoffRow: View {
	let session: SpawnedSession
	/// Names of the sessions of the same message this one waits on.
	var behind: [String] = []
	@State private var expanded = false

	static let maxWidth: CGFloat = 290

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s3) {
			Button {
				withAnimation(MaskinMotion.quick) { expanded.toggle() }
			} label: {
				summary
			}
			.buttonStyle(.plain)
			.accessibilityHint(expanded ? "Hide details" : "Show details")
			if expanded { details.transition(.opacity) }
		}
		.padding(MaskinSpace.s7)
		.frame(maxWidth: Self.maxWidth, alignment: .leading)
		.background(MaskinSurface.cardInset, in: RoundedRectangle(cornerRadius: MaskinRadius.card, style: .continuous))
		.overlay(
			RoundedRectangle(cornerRadius: MaskinRadius.card, style: .continuous)
				.strokeBorder(MaskinSurface.line, lineWidth: 1)
		)
		.frame(maxWidth: .infinity)
		.accessibilityElement(children: .contain)
	}

	private var summary: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s2) {
			HStack(spacing: MaskinSpace.s3) {
				ActorAvatar(
					name: session.actorName, kind: .agent, size: MaskinSpace.s11, seed: session.actorID,
					working: session.pill == .working)
				Text(session.actorName).maskinText(.caption).fontWeight(.semibold)
					.foregroundStyle(MaskinColor.ink2).lineLimit(1)
				Spacer(minLength: MaskinSpace.s3)
				statusLabel
			}
			Text(session.title).maskinText(.subhead).fontWeight(.semibold).foregroundStyle(MaskinColor.ink)
				.lineLimit(expanded ? nil : 2).multilineTextAlignment(.leading)
			caption
		}
		.frame(maxWidth: .infinity, alignment: .leading)
		.contentShape(Rectangle())
	}

	/// "behind Sentinel and Forge · 3m · Reading the brief": only what the data says. Re-read every
	/// half minute so a running count-up moves without polling anything.
	private var caption: some View {
		TimelineView(.periodic(from: .now, by: 30)) { context in
			if let line = captionText(now: context.date) {
				Text(line).maskinText(.caption).foregroundStyle(MaskinColor.ink4).lineLimit(1)
			}
		}
	}

	private func captionText(now: Date) -> String? {
		var parts: [String] = []
		if !behind.isEmpty, session.isLive { parts.append("behind \(Self.names(behind))") }
		if let elapsed = session.elapsedLabel(now: now) { parts.append(elapsed) }
		if let activity = session.liveActivity { parts.append(activity) }
		return parts.isEmpty ? nil : parts.joined(separator: " · ")
	}

	static func names(_ names: [String]) -> String {
		switch names.count {
		case 0, 1: names.first ?? ""
		case 2: "\(names[0]) and \(names[1])"
		default: names.dropLast().joined(separator: ", ") + ", and " + (names.last ?? "")
		}
	}

	@ViewBuilder
	private var details: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s3) {
			if session.actionPrompt.trimmingCharacters(in: .whitespacesAndNewlines) != session.title {
				Text(session.actionPrompt).maskinText(.caption).foregroundStyle(MaskinColor.ink3)
					.multilineTextAlignment(.leading).textSelection(.enabled)
			}
			if let outcome = session.outcomeText {
				Text(outcome).maskinText(.caption)
					.foregroundStyle(session.pill == .failed ? MaskinColor.warningStrong : MaskinColor.ink2)
					.multilineTextAlignment(.leading).textSelection(.enabled)
			}
		}
	}

	@ViewBuilder
	private var statusLabel: some View {
		switch session.pill {
		case .queued?:
			Text(HandoffPill.queued.label).maskinText(.caption).foregroundStyle(MaskinColor.ink4)
		case .working?:
			HStack(spacing: MaskinSpace.s3) {
				Text(HandoffPill.working.label).maskinText(.caption).foregroundStyle(MaskinColor.ink4)
				PulsingDots()
			}
		case .failed?:
			Label(HandoffPill.failed.label, systemImage: "exclamationmark.triangle.fill")
				.maskinText(.caption).foregroundStyle(MaskinColor.warningStrong)
		case .done?:
			Label(HandoffPill.done.label, systemImage: "checkmark")
				.maskinText(.caption).foregroundStyle(MaskinColor.success)
		case nil:
			EmptyView()
		}
	}
}
