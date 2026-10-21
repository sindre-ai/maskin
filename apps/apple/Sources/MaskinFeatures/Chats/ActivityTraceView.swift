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
	/// When the reader sent the message this card is waiting on, while a reply is owed.
	var sentAt: Date?
	/// The session's own start: the last resort for the elapsed timer (a chat session outlives its turns).
	var startedAt: Date?
	@Environment(\.accessibilityReduceMotion) private var reduceMotion

	/// The newest turn seen. A poll that momentarily has no running turn must not blank the card back
	/// to "Still working…" and drag the timer to another start; the card is dropped (and this with
	/// it) when the agent stops working.
	@State private var heldTurn: ActivityTurn?
	private var shownTurn: ActivityTurn? { turn ?? heldTurn }
	private var since: Date? {
		LiveActivityClock.since(
			sentAt: sentAt, turnStartedAt: shownTurn?.startedAt, sessionStartedAt: startedAt)
	}

	/// Steps shown while live: the newest few, so the card doesn't grow without bound.
	static let visibleSteps = 5

	/// Indent of the steps: past the 24pt avatar.
	static let stepIndent: CGFloat = MaskinSpace.s12 + MaskinSpace.s4

	/// The turn whose step list is open; opening is remembered per turn while it is live.
	@State private var openTurnID: String?

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s4) {
			header
			TimelineView(.periodic(from: .now, by: 5)) { context in
				line(LiveActivityLine.resolve(
					turn: shownTurn, fallbackActivity: fallbackActivity, startedAt: since, now: context.date))
			}
			.padding(.leading, Self.stepIndent)
			if isOpen, let turn = shownTurn, !turn.steps.isEmpty {
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
				.padding(.leading, Self.stepIndent)
				.transition(.opacity)
			}
		}
		.padding(.vertical, BubbleShape.theirVertical)
		.padding(.horizontal, BubbleShape.horizontal)
		.frame(maxWidth: .infinity, alignment: .leading)
		.background(MaskinSurface.card, in: BubbleShape.agent)
		.animation(MaskinMotion.quick, value: shownTurn?.steps.map(\.id))
		.onAppear { if let turn { heldTurn = turn } }
		.onChange(of: turn) { _, new in if let new { heldTurn = new } }
		.accessibilityElement(children: .contain)
	}

	private var turnKey: String { shownTurn?.id ?? "none" }
	private var canOpen: Bool { shownTurn?.steps.isEmpty == false }
	private var isOpen: Bool { canOpen && openTurnID == turnKey }

	/// One line: the newest step (or Starting… / Still working…), a chevron once there is a list to
	/// open. Tap opens the steps in place; tap again closes.
	private func line(_ line: LiveActivityLine) -> some View {
		Button {
			withAnimation(MaskinMotion.quick) { openTurnID = isOpen ? nil : turnKey }
		} label: {
			HStack(spacing: MaskinSpace.s3) {
				Text(line.text).maskinText(.caption)
					.foregroundStyle(line.phase == .stalled ? MaskinColor.ink5 : MaskinColor.ink4)
					.lineLimit(1).truncationMode(.tail)
				if canOpen {
					Image(systemName: "chevron.down").font(.caption2)
						.rotationEffect(.degrees(isOpen ? 180 : 0))
						.foregroundStyle(MaskinColor.ink5).accessibilityHidden(true)
				}
				Spacer(minLength: 0)
			}
			.frame(minHeight: MaskinSpace.touchMin - MaskinSpace.s8, alignment: .leading)
			.contentShape(Rectangle())
		}
		.buttonStyle(.maskinPressed)
		.disabled(!canOpen)
		.accessibilityLabel("Latest activity, \(line.text)")
		.accessibilityHint(canOpen ? (isOpen ? "Hide steps" : "Show steps") : "")
	}

	/// "is writing a reply" while the newest step is the agent's own words, else "is working on it".
	private var verb: String {
		let current = shownTurn?.steps.last(where: \.isRunning) ?? shownTurn?.currentStep
		return current?.kind == .text || current?.kind == .thinking ? "is writing a reply" : "is working on it"
	}

	private var header: some View {
		HStack(spacing: MaskinSpace.s4) {
			ActorAvatar(name: agent.name, kind: .agent, size: MaskinSpace.s12, seed: agent.id, working: true)
			Text(agent.name).maskinText(.subhead).fontWeight(.semibold).foregroundStyle(MaskinColor.ink)
				.lineLimit(1)
			Text(verb).maskinText(.subhead).foregroundStyle(MaskinColor.ink4).lineLimit(1)
			Spacer(minLength: 0)
			if let start = since { ElapsedLabel(since: start) }
		}
		.accessibilityElement(children: .combine)
		.accessibilityLabel("\(agent.name) \(verb)")
	}
}

/// Three small dots that pulse in turn (still under Reduce Motion). Dots mean "composing a
/// reply"; work is shown with `EqualiserBars`.
struct PulsingDots: View {
	@Environment(\.accessibilityReduceMotion) private var reduceMotion

	var body: some View {
		HStack(spacing: MaskinSpace.s1 + MaskinSpace.s1) {
			ForEach(0..<3, id: \.self) { i in
				Circle().fill(MaskinColor.ink5).frame(width: MaskinSpace.s3, height: MaskinSpace.s3)
					.phaseAnimator([0.3, 1.0], trigger: reduceMotion) { view, phase in
						view.opacity(reduceMotion ? 0.7 : phase)
					} animation: { _ in
						.easeInOut(duration: 0.6).delay(Double(i) * 0.2)
					}
			}
		}
		.accessibilityHidden(true)
	}
}

/// "12s" / "1m 04s" in mono 11pt, ticking once a second. Hidden from VoiceOver (it would re-announce).
struct ElapsedLabel: View {
	let since: Date

	var body: some View {
		TimelineView(.periodic(from: since, by: 1)) { context in
			Text(Self.text(from: since, to: context.date))
				.font(MaskinTypeface.mono(MaskinFontSize.t11, relativeTo: .caption)).monospacedDigit()
				.foregroundStyle(MaskinColor.ink5)
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
/// with a warning triangle and opens by itself so the reason is on screen.
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
							.foregroundStyle(MaskinColor.warning)
							.accessibilityHidden(true)
					}
					Text(expanded && !turn.failed ? "Hide work" : turn.collapsedLabel)
						.maskinText(.caption)
						.foregroundStyle(turn.failed ? MaskinColor.warningStrong : MaskinColor.ink4)
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
