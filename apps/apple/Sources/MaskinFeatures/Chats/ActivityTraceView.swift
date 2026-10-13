import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// The mono label for a step: what the agent thought, did (a tool call, worded by its category:
/// READ / EDIT / RUN / FIND ...), wrote (its own words) or failed at. The web says "Using <tool>"
/// for every call; this keeps the mockup's step-label column and says what the call was.
extension ActivityStep {
	var traceLabel: String {
		if status == .failed { return "FAILED" }
		switch kind {
		case .thinking: return "THOUGHT"
		case .toolUse: return (category ?? .other).word
		case .text: return "WROTE"
		case .error: return "FAILED"
		}
	}

	var isFailure: Bool { status == .failed || kind == .error }
}

/// One line of the trace: a mono label column, then the step and, at the trailing edge, where it
/// stands (a spinner while it runs, a check once done, a warning mark if it failed). The step
/// still going is in full ink, earlier ones grey; a failure takes the warning colour. The detail
/// (a path, a command) sits under the label in the muted role, never an id. A step that has more
/// to say (full command, what the tool returned) opens on tap.
struct ActivityStepRow: View {
	let step: ActivityStep
	var emphasized = false
	@State private var open: Bool

	init(step: ActivityStep, emphasized: Bool = false, expanded: Bool = false) {
		self.step = step
		self.emphasized = emphasized
		_open = State(initialValue: expanded)
	}

	/// The kind column: wide enough for "THOUGHT".
	static let labelWidth: CGFloat = MaskinSpace.s14 + MaskinSpace.s11 + MaskinSpace.s5

	/// Lines of detail / output shown when a step is opened.
	static let openLines = 8

	private var hasMore: Bool {
		(step.detail?.isEmpty == false) || (step.output?.isEmpty == false)
	}

	var body: some View {
		HStack(alignment: .firstTextBaseline, spacing: MaskinSpace.s4) {
			Text(step.traceLabel)
				.maskinText(.microLabel).fontWeight(.bold)
				.foregroundStyle(labelColor)
				.lineLimit(1).minimumScaleFactor(0.8)
				.frame(width: Self.labelWidth, alignment: .leading)
				.accessibilityHidden(true)
			VStack(alignment: .leading, spacing: MaskinSpace.s1) {
				Text(step.label)
					.maskinText(.subhead).fontWeight(emphasized ? .semibold : .regular)
					.foregroundStyle(color)
					.lineLimit(emphasized || open ? 3 : 1)
				if let detail = step.detail, !detail.isEmpty {
					Text(detail).maskinText(open ? .mono : .caption).foregroundStyle(MaskinColor.ink5)
						.lineLimit(open ? Self.openLines : (emphasized ? 3 : 1)).truncationMode(.middle)
				}
				if open, let output = step.output, !output.isEmpty {
					Text(output).maskinText(.mono)
						.foregroundStyle(step.status == .failed ? MaskinColor.warningStrong : MaskinColor.ink4)
						.lineLimit(Self.openLines).truncationMode(.tail)
				}
			}
			Spacer(minLength: 0)
			statusMark
		}
		.contentShape(Rectangle())
		.onTapGesture {
			guard hasMore else { return }
			withAnimation(MaskinMotion.quick) { open.toggle() }
		}
		.accessibilityElement(children: .combine)
		.accessibilityLabel(accessibilityText)
		.accessibilityHint(hasMore ? (open ? "Hide details" : "Show details") : "")
		.accessibilityAddTraits(hasMore ? .isButton : [])
	}

	@ViewBuilder private var statusMark: some View {
		switch step.status {
		case .running:
			ProgressView().controlSize(.mini).accessibilityHidden(true)
		case .failed:
			Image(systemName: "xmark.circle.fill").font(.caption)
				.foregroundStyle(MaskinColor.warning).accessibilityHidden(true)
		case .completed:
			if step.kind == .toolUse {
				Image(systemName: "checkmark").font(.caption2.weight(.semibold))
					.foregroundStyle(MaskinColor.ink5).accessibilityHidden(true)
			}
		}
	}

	private var isFailure: Bool { step.isFailure }

	private var color: Color {
		if isFailure { return MaskinColor.warningStrong }
		return emphasized ? MaskinColor.ink : MaskinColor.ink4
	}

	private var labelColor: Color { isFailure ? MaskinColor.warning : MaskinColor.ink5 }

	private var accessibilityText: String {
		let state =
			switch step.status {
			case .running: "in progress"
			case .failed: "failed"
			case .completed: "done"
			}
		return "\(step.traceLabel.capitalized), \(step.label), \(state)"
	}
}

/// Steps hung off a 1pt rule on the left.
struct ActivitySteps<Content: View>: View {
	@ViewBuilder var content: Content

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s3) { content }
			.padding(.leading, MaskinSpace.s7)
			.overlay(alignment: .leading) {
				Rectangle().fill(MaskinSurface.line).frame(width: 1)
			}
	}
}

/// The agent's working row: avatar, name, pulsing dots and what it is doing, an elapsed time on
/// the right, then the live steps with the current one in full ink. There is no Stop here: the
/// composer's Stop button ends the activity (7-Chat §3). Without step data
/// (older server, first poll) it degrades to the session's one-line activity.
struct LiveActivityView: View {
	let agent: ChatParticipant
	/// The session's own one-line status, used until steps arrive.
	var fallbackActivity: String?
	var turn: ActivityTurn?
	/// Where the elapsed timer starts when the turn doesn't say.
	var startedAt: Date?
	@Environment(\.accessibilityReduceMotion) private var reduceMotion

	/// Steps shown while live: the newest few, so the card doesn't grow without bound.
	static let visibleSteps = 5

	/// Indent of the steps: past the 26pt avatar.
	static let stepIndent: CGFloat = MaskinSpace.s13 + MaskinSpace.s4

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s3) {
			header
			Group {
				if let turn, !turn.steps.isEmpty {
					let shown = Array(turn.steps.suffix(Self.visibleSteps))
					ActivitySteps {
						if turn.steps.count > shown.count {
							Text("\(turn.steps.count - shown.count) earlier")
								.maskinText(.caption).foregroundStyle(MaskinColor.ink5)
						}
						ForEach(shown) { step in
							ActivityStepRow(step: step, emphasized: step.id == turn.currentStep?.id)
						}
					}
				} else if let fallbackActivity, !fallbackActivity.isEmpty {
					Text(fallbackActivity).maskinText(.caption).foregroundStyle(MaskinColor.ink5).lineLimit(2)
				}
			}
			.padding(.leading, Self.stepIndent)
		}
		.animation(MaskinMotion.quick, value: turn?.steps.map(\.id))
		.accessibilityElement(children: .contain)
	}

	/// "is writing a reply" while the newest step is the agent's own words, else "is working on it".
	private var verb: String {
		turn?.currentStep?.kind == .text ? "is writing a reply" : "is working on it"
	}

	private var header: some View {
		HStack(spacing: MaskinSpace.s4) {
			ActorAvatar(
				name: agent.name, kind: .agent, size: MaskinSpace.s13 - MaskinSpace.s1, seed: agent.id,
				working: true)
			Text(agent.name).maskinText(.subhead).fontWeight(.bold).foregroundStyle(MaskinColor.ink)
				.lineLimit(1)
			WorkingBars()
			Text(verb).maskinText(.subhead).foregroundStyle(MaskinColor.ink4).lineLimit(1)
			Spacer(minLength: 0)
			if let start = turn?.startedAt ?? startedAt { ElapsedLabel(since: start) }
		}
		.accessibilityElement(children: .combine)
		.accessibilityLabel("\(agent.name) \(verb)")
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

/// A finished turn: one muted line (the last thing the agent did, "· 3 steps · 8s"), indented under
/// the agent's avatar, that opens to the full trace ("Hide work" while open). A failed turn leads
/// with a warning triangle in the warning colour and opens by itself so the reason is on screen.
struct FinishedTraceView: View {
	let turn: ActivityTurn
	@State private var expanded = false

	init(turn: ActivityTurn, expanded: Bool? = nil) {
		self.turn = turn
		_expanded = State(initialValue: expanded ?? turn.failed)
	}

	/// 36pt: under the agent's name, past its avatar.
	static let indent: CGFloat = MaskinSpace.s12 + MaskinSpace.s7

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s2) {
			Button {
				withAnimation(MaskinMotion.quick) { expanded.toggle() }
			} label: {
				HStack(spacing: MaskinSpace.s3) {
					if turn.failed {
						Image(systemName: "exclamationmark.triangle.fill")
							.foregroundStyle(MaskinColor.danger)
							.accessibilityHidden(true)
					}
					Text(expanded && !turn.failed ? "Hide work" : turn.collapsedLabel)
						.maskinText(.caption)
						.foregroundStyle(turn.failed ? MaskinColor.danger : MaskinColor.ink4)
						.lineLimit(1)
					Image(systemName: "chevron.down")
						.font(.caption2)
						.rotationEffect(.degrees(expanded ? 180 : 0))
						.foregroundStyle(MaskinColor.ink5)
						.accessibilityHidden(true)
					Spacer(minLength: 0)
				}
				.frame(minHeight: MaskinSpace.touchMin - MaskinSpace.s8, alignment: .leading)
				.contentShape(Rectangle())
			}
			.buttonStyle(.maskinPressed)
			.disabled(turn.steps.isEmpty)
			.accessibilityLabel("Agent activity, \(turn.summary)")
			.accessibilityHint(turn.steps.isEmpty ? "" : (expanded ? "Collapse steps" : "Show steps"))
			.accessibilityAddTraits(.isButton)

			if expanded {
				ActivitySteps {
					ForEach(turn.steps) { ActivityStepRow(step: $0) }
					if turn.stepsTruncated {
						Text("Earlier steps not shown").maskinText(.caption).foregroundStyle(MaskinColor.ink5)
					}
				}
				.transition(.opacity)
			}
		}
		.padding(.leading, Self.indent)
	}
}
