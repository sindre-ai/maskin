import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// The sub-agent sessions a message handed work to, between two messages: one card for the whole
/// message, a two-line row per agent (who and how it stands, then what it was asked and how long it
/// took). Tapping a row opens the full task and, once it ended, the note it left. Everything is the
/// session's own data (`spawned_sessions` on the message); the server has no step list, so none is shown.
struct HandoffGroup: View {
	let entries: [HandoffEntry]

	/// "Handed to 3 agents · 1 working". A single handoff has no header.
	static func header(for sessions: [SpawnedSession]) -> String? {
		guard sessions.count > 1 else { return nil }
		let working = sessions.filter { $0.pill == .working }.count
		return "Handed to \(sessions.count) agents" + (working > 0 ? " · \(working) working" : "")
	}

	var body: some View {
		let shape = RoundedRectangle(cornerRadius: MaskinRadius.card, style: .continuous)
		let header = Self.header(for: entries.map(\.session))
		VStack(alignment: .leading, spacing: 0) {
			if let header {
				Text(header.uppercased()).maskinText(.microLabel).foregroundStyle(MaskinColor.ink4)
					.padding(.horizontal, MaskinSpace.s7).padding(.top, MaskinSpace.s5).padding(.bottom, MaskinSpace.s2)
					.accessibilityAddTraits(.isHeader)
			}
			ForEach(Array(entries.enumerated()), id: \.element.session.id) { index, entry in
				if index > 0 || header != nil {
					Rectangle().fill(MaskinSurface.line).frame(height: 1)
				}
				HandoffRow(session: entry.session, behind: entry.behind)
			}
		}
		.frame(maxWidth: .infinity, alignment: .leading)
		.background(MaskinSurface.cardInset, in: shape)
		.overlay(shape.strokeBorder(MaskinSurface.line, lineWidth: 1))
		.accessibilityElement(children: .contain)
	}
}

/// One agent's row of a handoff card.
struct HandoffRow: View {
	let session: SpawnedSession
	/// Names of the sessions of the same message this one waits on.
	var behind: [String] = []
	@State private var expanded = false

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s3) {
			Button {
				withAnimation(MaskinMotion.quick) { expanded.toggle() }
			} label: {
				summary
			}
			.buttonStyle(.maskinPressed)
			.accessibilityHint(expanded ? "Hide details" : "Show details")
			if expanded { details.transition(.opacity) }
		}
		.padding(.horizontal, MaskinSpace.s7).padding(.vertical, MaskinSpace.s5)
		.frame(minHeight: MaskinSpace.touchMin + MaskinSpace.s2, alignment: .leading)
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
			TimelineView(.periodic(from: .now, by: 30)) { context in
				Text(secondLine(now: context.date)).maskinText(.caption).foregroundStyle(MaskinColor.ink3)
					.lineLimit(expanded ? nil : 1).multilineTextAlignment(.leading)
			}
		}
		.frame(maxWidth: .infinity, alignment: .leading)
		.contentShape(Rectangle())
	}

	/// "Draft the importer rollout note · 3m": what it was asked, and how long it has run or took.
	/// Re-read every half minute so a running count-up moves without polling anything.
	private func secondLine(now: Date) -> String {
		[session.title, session.elapsedLabel(now: now)].compactMap { $0 }.joined(separator: " · ")
	}

	/// "behind Sentinel and Forge · Reading the brief": only what the data says.
	private var caption: String? {
		var parts: [String] = []
		if !behind.isEmpty, session.isLive { parts.append("behind \(Self.names(behind))") }
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
			if let caption {
				Text(caption).maskinText(.caption).foregroundStyle(MaskinColor.ink4)
			}
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

	/// The status as a small pill, as in the design: Working in the signal tint, Done quiet, Failed in warning.
	@ViewBuilder
	private var statusLabel: some View {
		switch session.pill {
		case .queued?: pill(HandoffPill.queued.label, fg: MaskinColor.ink4, bg: MaskinSurface.fill)
		case .working?:
			HStack(spacing: MaskinSpace.s2) {
				Text(HandoffPill.working.label)
				EqualiserBars()
			}
			.maskinText(.caption).fontWeight(.semibold).foregroundStyle(MaskinColor.sigInk)
			.padding(.horizontal, MaskinSpace.s4).padding(.vertical, MaskinSpace.s1)
			.background(MaskinColor.sigTint, in: Capsule())
		case .failed?:
			pill(HandoffPill.failed.label, fg: MaskinColor.warningStrong, bg: MaskinColor.warningTint)
		case .done?:
			pill(HandoffPill.done.label, fg: MaskinColor.doneFg, bg: MaskinColor.doneBg)
		case nil:
			EmptyView()
		}
	}

	private func pill(_ text: String, fg: Color, bg: Color) -> some View {
		Text(text).maskinText(.caption).fontWeight(.semibold).foregroundStyle(fg)
			.padding(.horizontal, MaskinSpace.s4).padding(.vertical, MaskinSpace.s1)
			.background(bg, in: Capsule())
	}
}
