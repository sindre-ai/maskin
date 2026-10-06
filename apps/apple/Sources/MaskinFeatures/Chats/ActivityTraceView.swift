import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// SF Symbol per step kind.
private extension ActivityStep.Kind {
	var symbol: String {
		switch self {
		case .toolUse: "wrench.and.screwdriver"
		case .thinking: "ellipsis.bubble"
		case .text: "text.alignleft"
		case .error: "exclamationmark.triangle"
		}
	}
}

/// One line of the trace. A running step is emphasized (ink, semibold, pulsing marker); finished
/// ones are muted with a check; a failed one is danger-tinted. The detail (a path, a command)
/// sits under the label in the mono role, never an id.
struct ActivityStepRow: View {
	let step: ActivityStep
	var emphasized = false
	@Environment(\.accessibilityReduceMotion) private var reduceMotion

	var body: some View {
		HStack(alignment: .firstTextBaseline, spacing: MaskinSpace.s4) {
			marker.frame(width: MaskinSpace.s8)
			VStack(alignment: .leading, spacing: 0) {
				Text(step.label)
					.maskinText(.subhead).fontWeight(emphasized ? .semibold : .regular)
					.foregroundStyle(color)
					.lineLimit(emphasized ? 3 : 1)
				if let detail = step.detail, !detail.isEmpty {
					Text(detail).maskinText(.caption).foregroundStyle(MaskinColor.ink5)
						.lineLimit(emphasized ? 3 : 1).truncationMode(.middle)
				}
			}
			Spacer(minLength: 0)
		}
		.accessibilityElement(children: .combine)
		.accessibilityLabel(accessibilityText)
	}

	private var color: Color {
		switch step.status {
		case .failed: MaskinColor.danger
		case .running: MaskinColor.ink
		case .completed: emphasized ? MaskinColor.ink2 : MaskinColor.ink4
		}
	}

	@ViewBuilder
	private var marker: some View {
		switch step.status {
		case .running:
			Image(systemName: step.kind.symbol).foregroundStyle(MaskinColor.accentFgStrong)
				.symbolEffect(.pulse, isActive: !reduceMotion)
				.accessibilityHidden(true)
		case .failed:
			Image(systemName: "xmark.circle.fill").foregroundStyle(MaskinColor.danger)
				.accessibilityHidden(true)
		case .completed:
			Image(systemName: step.kind == .error ? step.kind.symbol : "checkmark")
				.foregroundStyle(MaskinColor.ink5)
				.accessibilityHidden(true)
		}
	}

	private var accessibilityText: String {
		let state =
			switch step.status {
			case .running: "in progress"
			case .failed: "failed"
			case .completed: "done"
			}
		return "\(step.label), \(state)"
	}
}

/// The agent's working row: avatar, "<name> is working", an elapsed timer and Stop, then the
/// live step list with the current step emphasized. Without step data (older server, first poll)
/// it degrades to the session's one-line activity, as before.
struct LiveActivityView: View {
	let agent: ChatParticipant
	/// The session's own one-line status, used until steps arrive.
	var fallbackActivity: String?
	var turn: ActivityTurn?
	/// Where the elapsed timer starts when the turn doesn't say.
	var startedAt: Date?
	var onStop: (() -> Void)?

	/// Steps shown while live: the newest few, so the card doesn't grow without bound.
	static let visibleSteps = 5

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s3) {
			header
			if let turn, !turn.steps.isEmpty {
				let shown = Array(turn.steps.suffix(Self.visibleSteps))
				VStack(alignment: .leading, spacing: MaskinSpace.s2) {
					if turn.steps.count > shown.count {
						Text("\(turn.steps.count - shown.count) earlier")
							.maskinText(.caption).foregroundStyle(MaskinColor.ink5)
							.padding(.leading, MaskinSpace.s8 + MaskinSpace.s4)
					}
					ForEach(shown) { step in
						ActivityStepRow(step: step, emphasized: step.id == turn.currentStep?.id)
					}
				}
				.padding(.leading, MaskinSpace.s12 + MaskinSpace.s5)
			} else if let fallbackActivity, !fallbackActivity.isEmpty {
				Text(fallbackActivity).maskinText(.caption).foregroundStyle(MaskinColor.ink5).lineLimit(2)
					.padding(.leading, MaskinSpace.s12 + MaskinSpace.s5)
			}
		}
		.animation(MaskinMotion.quick, value: turn?.steps.map(\.id))
		.accessibilityElement(children: .contain)
	}

	private var header: some View {
		HStack(spacing: MaskinSpace.s5) {
			ActorAvatar(
				name: agent.name, kind: .agent, size: MaskinSpace.s12, seed: agent.id, working: true)
			HStack(spacing: MaskinSpace.s4) {
				Text("\(agent.name) is working").maskinText(.subhead).foregroundStyle(MaskinColor.ink4)
				if let start = turn?.startedAt ?? startedAt {
					ElapsedLabel(since: start)
				}
			}
			Spacer(minLength: 0)
			if let onStop {
				Button(action: onStop) {
					Text("Stop").maskinText(.subhead).foregroundStyle(MaskinColor.ink3)
						.padding(.horizontal, MaskinSpace.s7)
						.frame(minHeight: MaskinSpace.touchMin)
						.contentShape(Rectangle())
				}
				.buttonStyle(.plain)
				.accessibilityLabel("Stop \(agent.name)")
			}
		}
	}
}

/// "12s" / "1m 04s", ticking once a second. Hidden from VoiceOver (it would re-announce).
struct ElapsedLabel: View {
	let since: Date

	var body: some View {
		TimelineView(.periodic(from: since, by: 1)) { context in
			Text(Self.text(from: since, to: context.date))
				.maskinText(.caption).monospacedDigit().foregroundStyle(MaskinColor.ink5)
		}
		.accessibilityHidden(true)
	}

	static func text(from start: Date, to now: Date) -> String {
		let s = max(Int(now.timeIntervalSince(start)), 0)
		if s < 60 { return "\(s)s" }
		return "\(s / 60)m \(String(format: "%02d", s % 60))s"
	}
}

/// A finished turn: one muted line (the last thing the agent did, "· 3 steps · 8s") that opens to
/// the full trace. A failed turn
/// says so and names the point it reached; the line stays quiet otherwise.
struct FinishedTraceView: View {
	let turn: ActivityTurn
	@State private var expanded = false

	/// A failed turn opens by itself so the reason is on screen; otherwise the line stays closed.
	init(turn: ActivityTurn, expanded: Bool? = nil) {
		self.turn = turn
		_expanded = State(initialValue: expanded ?? turn.failed)
	}

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s2) {
			Button {
				withAnimation(MaskinMotion.quick) { expanded.toggle() }
			} label: {
				HStack(spacing: MaskinSpace.s3) {
					Image(systemName: turn.failed ? "exclamationmark.circle" : "chevron.right")
						.rotationEffect(.degrees(expanded && !turn.failed ? 90 : 0))
						.foregroundStyle(turn.failed ? MaskinColor.danger : MaskinColor.ink5)
						.accessibilityHidden(true)
					Text(turn.collapsedLabel).maskinText(.caption)
						.foregroundStyle(turn.failed ? MaskinColor.danger : MaskinColor.ink4)
						.lineLimit(1)
					Spacer(minLength: 0)
				}
				.frame(minHeight: MaskinSpace.touchMin - MaskinSpace.s8, alignment: .leading)
				.contentShape(Rectangle())
			}
			.buttonStyle(.plain)
			.disabled(turn.steps.isEmpty)
			.accessibilityLabel("Agent activity, \(turn.summary)")
			.accessibilityHint(turn.steps.isEmpty ? "" : (expanded ? "Collapse steps" : "Show steps"))
			.accessibilityAddTraits(.isButton)

			if expanded {
				VStack(alignment: .leading, spacing: MaskinSpace.s2) {
					ForEach(turn.steps) { ActivityStepRow(step: $0) }
					if turn.stepsTruncated {
						Text("Earlier steps not shown").maskinText(.caption).foregroundStyle(MaskinColor.ink5)
					}
				}
				.padding(.leading, MaskinSpace.s5)
				.transition(.opacity)
			}
		}
	}
}
