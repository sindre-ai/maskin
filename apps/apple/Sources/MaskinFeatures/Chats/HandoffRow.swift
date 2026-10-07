import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// A sub-agent session, between two messages: an agent was handed work by another agent. Centred
/// and compact: the agent, what it was asked (the task), what it is doing now and how it stands.
/// Tapping opens the steps it has taken so far. Everything comes from the session and its
/// activity trace, never from a timer; when the agent finishes, its result is an ordinary message.
struct HandoffRow: View {
	let handoff: ChatHandoff
	let agent: ChatParticipant
	/// The session's steps so far (live or finished); nil until the trace has loaded.
	var turn: ActivityTurn?
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
			.disabled(turn?.steps.isEmpty != false)
			.accessibilityHint(expanded ? "Hide steps" : "Show steps")
			if expanded, let turn {
				VStack(alignment: .leading, spacing: MaskinSpace.s3) {
					ForEach(turn.steps) { step in
						HStack(alignment: .firstTextBaseline, spacing: MaskinSpace.s4) {
							marker(for: step).frame(width: MaskinSpace.s8)
							Text(step.label).maskinText(.caption)
								.foregroundStyle(step.status == .running ? MaskinColor.ink : MaskinColor.ink4)
								.lineLimit(2)
						}
					}
				}
				.transition(.opacity)
			}
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
					name: agent.name, kind: .agent, size: MaskinSpace.s11, seed: agent.id,
					working: handoff.status.isLive)
				Text(agent.name).maskinText(.caption).fontWeight(.semibold).foregroundStyle(MaskinColor.ink2)
					.lineLimit(1)
				Spacer(minLength: MaskinSpace.s3)
				statusLabel
			}
			Text(handoff.title).maskinText(.subhead).fontWeight(.semibold).foregroundStyle(MaskinColor.ink)
				.lineLimit(2).multilineTextAlignment(.leading)
			if let step = currentStep {
				Text(step).maskinText(.caption).foregroundStyle(MaskinColor.ink4).lineLimit(1)
			}
		}
		.frame(maxWidth: .infinity, alignment: .leading)
		.contentShape(Rectangle())
	}

	/// What it is doing now: only while it runs, and only what the trace actually says.
	private var currentStep: String? {
		guard handoff.status.isLive else { return nil }
		return turn?.currentStep?.label
	}

	@ViewBuilder
	private var statusLabel: some View {
		if handoff.status.isLive {
			HStack(spacing: MaskinSpace.s3) {
				if let count = turn?.steps.count, count > 0 {
					Text("Step \(count)").maskinText(.caption).foregroundStyle(MaskinColor.ink4)
				} else {
					Text("Starting").maskinText(.caption).foregroundStyle(MaskinColor.ink4)
				}
				PulsingDots()
			}
		} else if handoff.status.isTroubled || turn?.failed == true {
			Label("Failed", systemImage: "exclamationmark.triangle.fill")
				.maskinText(.caption).foregroundStyle(MaskinColor.warningStrong)
		} else if handoff.status == .paused {
			Label("Paused", systemImage: "pause.fill").maskinText(.caption).foregroundStyle(MaskinColor.ink4)
		} else {
			Label("Done", systemImage: "checkmark").maskinText(.caption).foregroundStyle(MaskinColor.success)
		}
	}

	/// Tick for a finished step, Patina dot for the one in progress, a warning triangle for a failure.
	@ViewBuilder
	private func marker(for step: ActivityStep) -> some View {
		switch step.status {
		case .completed:
			Image(systemName: "checkmark").font(.caption2).foregroundStyle(MaskinColor.success)
		case .running:
			Circle().fill(MaskinColor.sig).frame(width: MaskinSpace.s3, height: MaskinSpace.s3)
		case .failed:
			Image(systemName: "exclamationmark.triangle.fill").font(.caption2).foregroundStyle(MaskinColor.warning)
		}
	}
}
