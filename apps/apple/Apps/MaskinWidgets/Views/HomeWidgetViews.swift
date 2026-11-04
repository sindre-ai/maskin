import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI
import WidgetKit

/// The three home-screen sizes. Our own enum (not `WidgetFamily`) so the views take their size as a
/// plain value and render on any host in tests.
enum HomeSize: Sendable {
	case small, medium, large
}

/// The home-screen widget body (no container background: the widget adds that, tests add their
/// own).
struct NeedsYouHomeView: View {
	let entry: MaskinWidgetEntry
	let size: HomeSize

	var body: some View {
		switch entry.state {
		case .signedOut:
			NoticeView(
				symbol: nil, title: "Open Maskin to sign in",
				detail: "Decisions that need you show up here.", compact: size == .small)
		case .unavailable:
			NoticeView(
				symbol: "wifi.slash", title: "Can't refresh",
				detail: "Open Maskin to check what needs you.", compact: size == .small)
		case .content(let snapshot):
			if size == .medium, let chosen = entry.chosen, chosen.isShown(at: entry.date) {
				ChosenView(record: chosen, now: entry.date)
			} else if snapshot.isEmpty {
				AllClearView(snapshot: snapshot, now: entry.date, size: size)
			} else {
				switch size {
				case .medium: MediumView(snapshot: snapshot, now: entry.date)
				case .large: LargeView(snapshot: snapshot, now: entry.date)
				case .small: SmallView(snapshot: snapshot, now: entry.date)
				}
			}
		}
	}
}

// MARK: - Shared pieces

/// "Updated 40m ago", only once the data is stale: a healthy widget stays quiet.
struct UpdatedNote: View {
	let snapshot: WidgetSnapshot
	let now: Date

	var body: some View {
		if WidgetPolicy.isStale(snapshot, at: now) {
			(Text("Updated ") + Text(snapshot.updatedAt, style: .relative) + Text(" ago"))
				.font(.caption2)
				.foregroundStyle(MaskinColor.sigInk)
				.lineLimit(1)
				.accessibilityLabel("Updated \(accessibleAge) ago")
		}
	}

	private var accessibleAge: String {
		RelativeTimeFormatter.string(for: snapshot.updatedAt, now: now, style: .relative)
			.replacingOccurrences(of: " ago", with: "")
	}
}

private struct HeaderLabel: View {
	var body: some View {
		HStack(spacing: MaskinSpace.s3) {
			MaskinLogoTile(size: 16)
			MonoLabel("Needs you")
		}
		.widgetAccentable()
	}
}

/// Sentence VoiceOver reads for a decision. Titles are withheld while the system redacts
/// private content (a locked device), exactly as they are on screen.
func decisionAccessibilityLabel(
	_ decision: WidgetSnapshot.Decision, redacted: Bool
) -> String {
	if redacted { return "A decision needs you" }
	var parts = [decision.title]
	if let agent = decision.agentName { parts.append("from \(agent)") }
	return parts.joined(separator: ", ")
}

private struct DecisionTitle: View {
	let decision: WidgetSnapshot.Decision
	var lines: Int = 2
	var font: Font = MaskinTypeface.sans(MaskinFontSize.t13, weight: .semibold, relativeTo: .footnote)
	var color: Color = MaskinColor.ink

	var body: some View {
		Text(decision.title)
			.font(font)
			.foregroundStyle(color)
			.lineLimit(lines)
			.multilineTextAlignment(.leading)
			.privacySensitive()
	}
}

private struct OptionChip: View {
	let label: String
	let recommended: Bool
	@Environment(\.widgetRenderingMode) private var renderingMode

	var body: some View {
		let shape = RoundedRectangle(cornerRadius: MaskinRadius.btn, style: .continuous)
		Text(label)
			.font(MaskinTypeface.sans(MaskinFontSize.t11, weight: .semibold, relativeTo: .caption2))
			.lineLimit(1)
			.foregroundStyle(recommended ? MaskinSurface.onInverse : MaskinColor.ink3)
			.padding(.horizontal, MaskinSpace.s4)
			.padding(.vertical, MaskinSpace.s1 + 1)
			// Tinted modes (iOS 18) recolour accentable content with the user's tint: the custom
			// fills would fight it, so the recommended chip becomes an accentable outline.
			.background {
				if renderingMode == .fullColor {
					shape.fill(recommended ? MaskinSurface.inverse : MaskinSurface.fill)
				} else if recommended {
					shape.stroke(lineWidth: 1)
				}
			}
			.widgetAccentable(recommended)
			.privacySensitive()
	}
}

/// "Chief of Staff · 9:12": who asked and when. Today it is a clock time; older, how long it has
/// been held ("held 3 days"), in the signal colour.
private struct AgentLine: View {
	let decision: WidgetSnapshot.Decision
	let now: Date
	var showHeld = true

	var body: some View {
		HStack(spacing: MaskinSpace.s2) {
			if let agent = decision.agentName {
				Text(agent).privacySensitive()
			}
			if showHeld, let since = decision.since {
				if decision.agentName != nil { Text("\u{00B7}") }
				if Calendar.current.isDate(since, inSameDayAs: now) {
					Text(since, style: .time)
				} else if let held = ForYouFormat.heldNote(since: since, now: now) {
					Text(held).foregroundStyle(MaskinColor.sigInk)
				}
			}
		}
		.font(MaskinTypeface.sans(MaskinFontSize.t11, relativeTo: .caption2))
		.foregroundStyle(MaskinColor.ink4)
		.lineLimit(1)
	}
}

// MARK: - Small

private struct SmallView: View {
	let snapshot: WidgetSnapshot
	let now: Date
	@Environment(\.redactionReasons) private var redaction
	@Environment(\.accessibilityReduceMotion) private var reduceMotion

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s2) {
			HeaderLabel()
			Text("\(snapshot.needsCount)")
				.font(MaskinTypeface.sans(56, weight: MaskinFontWeight.w750, relativeTo: .largeTitle))
				.foregroundStyle(MaskinColor.ink)
				.minimumScaleFactor(0.5)
				.lineLimit(1)
				.widgetAccentable()
				.contentTransition(reduceMotion ? .identity : .numericText())
			if let top = snapshot.top {
				VStack(alignment: .leading, spacing: MaskinSpace.s1) {
					DecisionTitle(
						decision: top, lines: 2,
						font: MaskinTypeface.sans(MaskinFontSize.t14, weight: .semibold, relativeTo: .footnote),
						color: MaskinColor.ink3)
					AgentLine(decision: top, now: now)
				}
			}
			Spacer(minLength: 0)
			UpdatedNote(snapshot: snapshot, now: now)
		}
		.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
		.accessibilityElement(children: .ignore)
		.accessibilityLabel(summary)
	}

	private var summary: String {
		let count = "\(snapshot.needsCount) \(snapshot.needsCount == 1 ? "decision needs" : "decisions need") you."
		guard let top = snapshot.top else { return count }
		return count + " Most urgent: " + decisionAccessibilityLabel(top, redacted: redaction.contains(.privacy))
	}
}

// MARK: - Medium

private struct MediumView: View {
	let snapshot: WidgetSnapshot
	let now: Date
	@Environment(\.redactionReasons) private var redaction
	@Environment(\.dynamicTypeSize) private var typeSize

	private var decision: WidgetSnapshot.Decision? { snapshot.top }

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s5) {
			header
			if let decision {
				Link(destination: snapshot.url(for: decision)) {
					Text(decision.title)
						.font(MaskinTypeface.sans(MaskinFontSize.t15, weight: .semibold, relativeTo: .subheadline))
						.foregroundStyle(MaskinColor.ink)
						.lineLimit(typeSize.isAccessibilitySize ? 2 : 3)
						.multilineTextAlignment(.leading)
						.frame(maxWidth: .infinity, alignment: .leading)
						.privacySensitive()
				}
				Spacer(minLength: 0)
				buttons(for: decision)
			}
			UpdatedNote(snapshot: snapshot, now: now)
		}
		.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
		.accessibilityElement(children: .contain)
		.accessibilityLabel(summary)
	}

	/// Chief of Staff on the left, the count as a badge on the right.
	private var header: some View {
		HStack(spacing: MaskinSpace.s4) {
			ActorAvatar(name: decision?.agentName ?? "Chief of Staff", kind: .agent, size: 22)
			Text(decision?.agentName ?? "Chief of Staff")
				.font(MaskinTypeface.sans(MaskinFontSize.t13, weight: .semibold, relativeTo: .footnote))
				.foregroundStyle(MaskinColor.ink)
				.lineLimit(1)
				.privacySensitive()
			Spacer(minLength: MaskinSpace.s3)
			Text("\(snapshot.needsCount)")
				.font(MaskinTypeface.mono(MaskinFontSize.t11, weight: .semibold, relativeTo: .caption2))
				.foregroundStyle(MaskinColor.badgeFg)
				.frame(minWidth: 20, minHeight: 20)
				.padding(.horizontal, MaskinSpace.s2)
				.background(MaskinGradient.badge, in: Capsule())
				.widgetAccentable()
				.accessibilityLabel("\(snapshot.needsCount) need you")
		}
		.widgetAccentable()
	}

	/// The agent's recommendation (ink) and Hold. A button decides in place only when the answer
	/// can be sent as it stands; Hold needs a reason and irreversible options need the confirm
	/// sheet, so those open the card in the app instead.
	@ViewBuilder
	private func buttons(for decision: WidgetSnapshot.Decision) -> some View {
		HStack(spacing: MaskinSpace.s4) {
			if let primary = decision.primaryLabel {
				action(primary, on: decision, recommended: true)
			}
			if let secondary = decision.secondaryLabel {
				action(secondary, on: decision, recommended: false)
			}
		}
	}

	@ViewBuilder
	private func action(_ label: String, on decision: WidgetSnapshot.Decision, recommended: Bool) -> some View {
		if decision.decidesInPlace(label) {
			Button(intent: DecideInWidgetIntent(objectId: decision.objectId, label: label)) {
				OptionButtonLabel(label: label, recommended: recommended)
			}
			.buttonStyle(.plain)
		} else {
			Link(destination: snapshot.url(for: decision)) {
				OptionButtonLabel(label: label, recommended: recommended)
			}
		}
	}

	private var summary: String {
		let count = "\(snapshot.needsCount) \(snapshot.needsCount == 1 ? "decision needs" : "decisions need") you."
		guard let decision else { return count }
		return count + " " + decisionAccessibilityLabel(decision, redacted: redaction.contains(.privacy))
	}
}

/// A medium-widget button: the recommended one is the ink capsule (a light one in dark mode), the
/// other a quiet fill. 38pt tall, fully round, as in the mockup.
private struct OptionButtonLabel: View {
	let label: String
	let recommended: Bool
	@Environment(\.widgetRenderingMode) private var renderingMode

	var body: some View {
		Text(label)
			.font(MaskinTypeface.sans(MaskinFontSize.t14, weight: .semibold, relativeTo: .footnote))
			.foregroundStyle(recommended ? MaskinPatina.decisionInkText : MaskinColor.ink3)
			.lineLimit(1)
			.minimumScaleFactor(0.8)
			.frame(maxWidth: .infinity, minHeight: 38)
			.background {
				if renderingMode == .fullColor {
					if recommended {
						Capsule().fill(MaskinGradient.decisionInk)
					} else {
						Capsule().fill(MaskinSurface.fill)
					}
				} else if recommended {
					Capsule().stroke(lineWidth: 1)
				}
			}
			.widgetAccentable(recommended)
			.privacySensitive()
	}
}

/// After deciding: "✓ You chose Send all 7", a result line, and Undo while the answer is still
/// inside its window (before it leaves the device).
private struct ChosenView: View {
	let record: WidgetDecisionRecord
	let now: Date

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s4) {
			HStack(spacing: MaskinSpace.s4) {
				ActorAvatar(name: record.agentName ?? "Chief of Staff", kind: .agent, size: 22)
				Text(record.agentName ?? "Chief of Staff")
					.font(MaskinTypeface.sans(MaskinFontSize.t13, weight: .semibold, relativeTo: .footnote))
					.foregroundStyle(MaskinColor.ink)
					.lineLimit(1)
					.privacySensitive()
			}
			.widgetAccentable()
			Spacer(minLength: 0)
			HStack(alignment: .firstTextBaseline, spacing: MaskinSpace.s4) {
				Image(systemName: record.phase == .failed ? "exclamationmark.circle" : "checkmark.circle.fill")
					.foregroundStyle(MaskinColor.ink)
					.accessibilityHidden(true)
				Text(record.phase == .failed ? "Couldn\u{2019}t send" : "You chose \(record.label)")
					.font(MaskinTypeface.sans(MaskinFontSize.t15, weight: .semibold, relativeTo: .subheadline))
					.foregroundStyle(MaskinColor.ink)
					.lineLimit(2)
					.privacySensitive()
			}
			Text(resultLine)
				.font(MaskinTypeface.sans(MaskinFontSize.t12, relativeTo: .caption))
				.foregroundStyle(MaskinColor.ink4)
				.lineLimit(2)
			Spacer(minLength: 0)
			if record.canUndo(at: now) {
				Button(intent: UndoWidgetDecisionIntent(objectId: record.objectId)) {
					Text("Undo")
						.font(MaskinTypeface.sans(MaskinFontSize.t13, weight: .semibold, relativeTo: .footnote))
						.underline()
						.foregroundStyle(MaskinColor.ink)
						.frame(minHeight: 32, alignment: .leading)
						.contentShape(Rectangle())
				}
				.buttonStyle(.plain)
			}
		}
		.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
		.accessibilityElement(children: .contain)
	}

	/// Honest about timing: a held answer has not been sent yet, and Undo is only real until then.
	private var resultLine: String {
		switch record.phase {
		case .held, .sending: record.canUndo(at: now) ? "Sending in a moment. Undo to take it back." : "Sending\u{2026}"
		case .sent: "Sent. Open Maskin to see what happens next."
		case .failed: record.message ?? "Open Maskin to answer."
		}
	}
}

// MARK: - Large

private struct LargeView: View {
	let snapshot: WidgetSnapshot
	let now: Date
	@Environment(\.redactionReasons) private var redaction
	@Environment(\.dynamicTypeSize) private var typeSize

	/// Up to two rows (spec), one at accessibility sizes, so the flows below still fit.
	private var shown: [WidgetSnapshot.Decision] {
		Array(snapshot.decisions.prefix(typeSize.isAccessibilitySize ? 1 : Self.maxRows))
	}

	static let maxRows = 2

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s5) {
			MonoLabel("Needs you \u{00B7} \(snapshot.needsCount)")
				.widgetAccentable()
			VStack(spacing: 0) {
				ForEach(Array(shown.enumerated()), id: \.element.id) { index, decision in
					if index > 0 { Rectangle().fill(MaskinSurface.separator).frame(height: 1) }
					row(decision, first: index == 0)
				}
			}
			if snapshot.needsCount > shown.count {
				Text("+\(snapshot.needsCount - shown.count) more in Maskin")
					.font(.caption2)
					.foregroundStyle(MaskinColor.ink4)
			}
			if !snapshot.flows.isEmpty {
				FlowTiles(flows: snapshot.flows)
			}
			Spacer(minLength: 0)
			HStack {
				if snapshot.unreadCount > 0 {
					Label("\(snapshot.unreadLabel) unread", systemImage: "bell.badge")
						.font(MaskinTypeface.sans(MaskinFontSize.t11, weight: .semibold, relativeTo: .caption2))
						.foregroundStyle(MaskinColor.ink3)
				}
				Spacer()
				UpdatedNote(snapshot: snapshot, now: now)
			}
		}
		.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
	}

	/// Title on the left, one capsule on the right: the agent's answer when it can be sent from
	/// here, otherwise "Review" (opens the card).
	private func row(_ decision: WidgetSnapshot.Decision, first: Bool) -> some View {
		HStack(alignment: .center, spacing: MaskinSpace.s5) {
			Link(destination: snapshot.url(for: decision)) {
				VStack(alignment: .leading, spacing: MaskinSpace.s1) {
					DecisionTitle(decision: decision, lines: 2, font: MaskinTypeface.sans(MaskinFontSize.t15, weight: .semibold, relativeTo: .subheadline))
					if typeSize < .accessibility1 { AgentLine(decision: decision, now: now) }
				}
				.frame(maxWidth: .infinity, alignment: .leading)
			}
			.accessibilityLabel(decisionAccessibilityLabel(decision, redacted: redaction.contains(.privacy)))
			capsule(for: decision)
		}
		.padding(.vertical, MaskinSpace.s4)
		.frame(maxWidth: .infinity, alignment: .leading)
	}

	@ViewBuilder
	private func capsule(for decision: WidgetSnapshot.Decision) -> some View {
		if let label = decision.primaryLabel, decision.decidesInPlace(label) {
			Button(intent: DecideInWidgetIntent(objectId: decision.objectId, label: label)) {
				RowCapsule(label: label, recommended: true)
			}
			.buttonStyle(.plain)
		} else {
			Link(destination: snapshot.url(for: decision)) {
				RowCapsule(label: "Review", recommended: false)
			}
		}
	}
}

/// The large widget's per-row action pill.
private struct RowCapsule: View {
	let label: String
	let recommended: Bool
	@Environment(\.widgetRenderingMode) private var renderingMode

	var body: some View {
		let shape = RoundedRectangle(cornerRadius: MaskinRadius.btnLg, style: .continuous)
		Text(label)
			.font(MaskinTypeface.sans(MaskinFontSize.t13, weight: .semibold, relativeTo: .footnote))
			.foregroundStyle(recommended ? MaskinPatina.decisionInkText : MaskinColor.ink3)
			.lineLimit(1)
			.frame(maxWidth: 96)
			.padding(.horizontal, MaskinSpace.s6)
			.frame(minHeight: MaskinSpace.touchMin)
			.background {
				if renderingMode == .fullColor {
					if recommended {
						shape.fill(MaskinGradient.decisionInk)
					} else {
						shape.fill(MaskinSurface.fill)
					}
				} else if recommended {
					shape.stroke(lineWidth: 1)
				}
			}
			.widgetAccentable(recommended)
			.privacySensitive()
	}
}

/// "FLOWS" and up to three ring tiles: how far each running flow is, and whether it is waiting on
/// the reader.
private struct FlowTiles: View {
	let flows: [WidgetSnapshot.Flow]

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s4) {
			MonoLabel("Flows")
			HStack(spacing: MaskinSpace.s5) {
				ForEach(flows) { flow in
					FlowTile(flow: flow)
				}
				// Keep tiles the same width when fewer than three.
				ForEach(0..<max(0, WidgetSnapshot.maxFlows - flows.count), id: \.self) { _ in
					Color.clear.frame(maxWidth: .infinity)
				}
			}
		}
	}
}

private struct FlowTile: View {
	let flow: WidgetSnapshot.Flow
	@Environment(\.widgetRenderingMode) private var renderingMode

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s3) {
			ring
			Text(flow.name)
				.font(MaskinTypeface.sans(MaskinFontSize.t13, weight: .bold, relativeTo: .footnote))
				.foregroundStyle(MaskinColor.ink)
				.lineLimit(1)
				.privacySensitive()
			Text(flow.needsYou ? "Needs you" : "On track")
				.font(MaskinTypeface.sans(MaskinFontSize.t11, weight: flow.needsYou ? .semibold : .regular, relativeTo: .caption2))
				.foregroundStyle(flow.needsYou ? MaskinColor.sigInk : MaskinColor.ink4)
				.lineLimit(1)
		}
		.padding(MaskinSpace.s5)
		.frame(maxWidth: .infinity, alignment: .leading)
		.background(MaskinSurface.fill, in: RoundedRectangle(cornerRadius: MaskinRadius.btnLg, style: .continuous))
		.accessibilityElement(children: .ignore)
		.accessibilityLabel("\(flow.name), \(Int((flow.progress * 100).rounded())) percent, \(flow.needsYou ? "needs you" : "on track")")
	}

	private var ring: some View {
		ZStack {
			Circle().stroke(MaskinColor.doneBd, lineWidth: 4)
			Circle()
				.trim(from: 0, to: flow.progress)
				.stroke(MaskinColor.sig, style: StrokeStyle(lineWidth: 4, lineCap: .round))
				.rotationEffect(.degrees(-90))
				.widgetAccentable()
		}
		.frame(width: 36, height: 36)
	}
}

// MARK: - Empty and notices

private struct AllClearView: View {
	let snapshot: WidgetSnapshot
	let now: Date
	let size: HomeSize

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s3) {
			MonoLabel("Needs you")
				.widgetAccentable()
			Image(systemName: "checkmark")
				.font(.system(size: 18, weight: .regular))
				.foregroundStyle(MaskinColor.doneFg)
				.frame(width: 34, height: 34)
				.background(MaskinColor.ink.opacity(0.06), in: Circle())
				.padding(.top, MaskinSpace.s3)
				.accessibilityHidden(true)
			Spacer(minLength: 0)
			Text("You\u{2019}re caught up")
				.font(MaskinTypeface.sans(MaskinFontSize.t15, weight: .semibold, relativeTo: .subheadline))
				.foregroundStyle(MaskinColor.ink)
			do {
				Text(snapshot.caughtUpDetail)
					.font(MaskinTypeface.sans(MaskinFontSize.t12, relativeTo: .caption))
					.foregroundStyle(MaskinColor.ink4)
					.lineLimit(size == .small ? 2 : 3)
			}
			UpdatedNote(snapshot: snapshot, now: now)
		}
		.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
		.accessibilityElement(children: .combine)
	}
}

private struct NoticeView: View {
	let symbol: String?
	let title: String
	let detail: String
	let compact: Bool

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s3) {
			if let symbol {
				Image(systemName: symbol)
					.font(.title3)
					.foregroundStyle(MaskinColor.ink4)
					.accessibilityHidden(true)
			} else {
				MaskinLogoTile(size: compact ? 28 : 34)
			}
			Spacer(minLength: 0)
			Text(title)
				.font(compact ? .subheadline.weight(.semibold) : .headline)
				.foregroundStyle(MaskinColor.ink)
				.lineLimit(2)
			Text(detail)
				.font(.caption)
				.foregroundStyle(MaskinColor.ink4)
				.lineLimit(compact ? 2 : 3)
		}
		.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
		.accessibilityElement(children: .combine)
	}
}
