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
			if snapshot.isEmpty {
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
				.foregroundStyle(MaskinColor.warningStrong)
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
			BrandGlyph(size: 16)
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
	var font: Font = .footnote.weight(.semibold)

	var body: some View {
		Text(decision.title)
			.font(font)
			.foregroundStyle(MaskinColor.ink)
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
			.font(.caption2.weight(.medium))
			.lineLimit(1)
			.foregroundStyle(recommended ? MaskinColor.accentFgStrong : MaskinColor.ink3)
			.padding(.horizontal, MaskinSpace.s4)
			.padding(.vertical, MaskinSpace.s1 + 1)
			// Tinted modes (iOS 18) recolour accentable content with the user's tint: the custom
			// fills would fight it, so the recommended chip becomes an accentable outline.
			.background {
				if renderingMode == .fullColor {
					shape.fill(recommended ? MaskinColor.accentTint2 : MaskinSurface.fill)
				} else if recommended {
					shape.stroke(lineWidth: 1)
				}
			}
			.widgetAccentable(recommended)
			.privacySensitive()
	}
}

private struct AgentLine: View {
	let decision: WidgetSnapshot.Decision
	let now: Date
	var showHeld = true

	var body: some View {
		HStack(spacing: MaskinSpace.s2) {
			if let agent = decision.agentName {
				Text(agent).privacySensitive()
			}
			if showHeld, let held = ForYouFormat.heldNote(since: decision.since, now: now) {
				if decision.agentName != nil { Text("·") }
				Text(held).foregroundStyle(MaskinColor.warningStrong)
			}
		}
		.font(.caption2)
		.foregroundStyle(MaskinColor.ink4)
		.lineLimit(1)
	}
}

// MARK: - Small

private struct SmallView: View {
	let snapshot: WidgetSnapshot
	let now: Date
	@Environment(\.redactionReasons) private var redaction

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s2) {
			HeaderLabel()
			HStack(alignment: .firstTextBaseline, spacing: MaskinSpace.s2) {
				Text("\(snapshot.needsCount)")
					.font(.system(size: 40, weight: .bold, design: .rounded))
					.foregroundStyle(MaskinColor.accent)
					.widgetAccentable()
					.contentTransition(.numericText())
				Text(snapshot.needsCount == 1 ? "decision" : "decisions")
					.font(.footnote)
					.foregroundStyle(MaskinColor.ink4)
			}
			.minimumScaleFactor(0.7)
			.lineLimit(1)
			if let top = snapshot.top {
				VStack(alignment: .leading, spacing: MaskinSpace.s1) {
					DecisionTitle(decision: top, lines: 2, font: .caption.weight(.semibold))
					AgentLine(decision: top, now: now, showHeld: false)
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

	/// Two asks fit at normal sizes; at accessibility sizes one, so nothing is clipped.
	private var asks: [WidgetSnapshot.Decision] {
		Array(snapshot.decisions.prefix(typeSize.isAccessibilitySize ? 1 : 2))
	}

	var body: some View {
		HStack(alignment: .top, spacing: MaskinSpace.s7) {
			countColumn
				// A share of the widget, not a fixed 118 pt: it follows the device's widget size.
				.containerRelativeFrame(.horizontal) { width, _ in width * 0.3 }

			Rectangle().fill(MaskinSurface.line).frame(width: 1)

			VStack(alignment: .leading, spacing: MaskinSpace.s3) {
				ForEach(Array(asks.enumerated()), id: \.element.id) { index, decision in
					if index > 0 { Rectangle().fill(MaskinSurface.separator).frame(height: 1) }
					Link(destination: snapshot.url(for: decision)) { ask(decision) }
				}
				Spacer(minLength: 0)
				UpdatedNote(snapshot: snapshot, now: now)
			}
			.frame(maxWidth: .infinity, alignment: .leading)
		}
		.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
		.accessibilityElement(children: .ignore)
		.accessibilityLabel(summary)
	}

	private var countColumn: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s2) {
			HeaderLabel()
			Text("\(snapshot.needsCount)")
				.font(.system(size: 44, weight: .bold, design: .rounded))
				.foregroundStyle(MaskinColor.accent)
				.widgetAccentable()
				.minimumScaleFactor(0.5)
				.lineLimit(1)
			Text(snapshot.needsCount == 1 ? "decision needs you" : "decisions need you")
				.font(.caption)
				.foregroundStyle(MaskinColor.ink4)
				.lineLimit(3)
				.minimumScaleFactor(0.8)
			Spacer(minLength: 0)
			if snapshot.unreadCount > 0 {
				Label("\(snapshot.unreadLabel) unread", systemImage: "bell.badge")
					.font(.caption2.weight(.medium))
					.foregroundStyle(MaskinColor.ink3)
					.lineLimit(1)
			}
		}
	}

	private func ask(_ decision: WidgetSnapshot.Decision) -> some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s1) {
			DecisionTitle(decision: decision, lines: 2, font: .footnote.weight(.semibold))
			HStack(spacing: MaskinSpace.s3) {
				AgentLine(decision: decision, now: now)
				if let label = decision.recommendedLabel, !typeSize.isAccessibilitySize {
					OptionChip(label: label, recommended: true)
				}
			}
		}
		.frame(maxWidth: .infinity, alignment: .leading)
	}

	private var summary: String {
		let count = "\(snapshot.needsCount) \(snapshot.needsCount == 1 ? "decision needs" : "decisions need") you."
		guard !asks.isEmpty else { return count }
		let hidden = redaction.contains(.privacy)
		return count + " Most urgent: "
			+ asks.map { decisionAccessibilityLabel($0, redacted: hidden) }.joined(separator: ". ")
	}
}

// MARK: - Large

private struct LargeView: View {
	let snapshot: WidgetSnapshot
	let now: Date
	@Environment(\.redactionReasons) private var redaction
	@Environment(\.dynamicTypeSize) private var typeSize

	/// Accessibility sizes show fewer, simpler rows instead of clipping three crowded ones.
	private var shown: [WidgetSnapshot.Decision] {
		Array(snapshot.decisions.prefix(typeSize.isAccessibilitySize ? 2 : snapshot.decisions.count))
	}

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s5) {
			HStack {
				HeaderLabel()
				Spacer()
				Text("\(snapshot.needsCount)")
					.font(.system(.subheadline, design: .rounded).weight(.bold))
					.foregroundStyle(MaskinColor.accentFgStrong)
					.padding(.horizontal, MaskinSpace.s4)
					.padding(.vertical, MaskinSpace.s1)
					.background(MaskinColor.accentTint2, in: Capsule())
					.widgetAccentable()
			}
			VStack(spacing: 0) {
				ForEach(Array(shown.enumerated()), id: \.element.id) { index, decision in
					if index > 0 { Rectangle().fill(MaskinSurface.separator).frame(height: 1) }
					Link(destination: snapshot.url(for: decision)) {
						row(decision)
					}
					.accessibilityLabel(decisionAccessibilityLabel(decision, redacted: redaction.contains(.privacy)))
				}
			}
			if snapshot.needsCount > shown.count {
				Text("+\(snapshot.needsCount - shown.count) more in Maskin")
					.font(.caption2)
					.foregroundStyle(MaskinColor.ink4)
			}
			Spacer(minLength: 0)
			HStack {
				if snapshot.unreadCount > 0 {
					Label("\(snapshot.unreadLabel) unread", systemImage: "bell.badge")
						.font(.caption2.weight(.medium))
						.foregroundStyle(MaskinColor.ink3)
				}
				Spacer()
				UpdatedNote(snapshot: snapshot, now: now)
			}
		}
		.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
	}

	private func row(_ decision: WidgetSnapshot.Decision) -> some View {
		HStack(alignment: .top, spacing: MaskinSpace.s5) {
			if !typeSize.isAccessibilitySize {
				if let agent = decision.agentName {
					ActorAvatar(name: agent, kind: .agent, size: 24).privacySensitive()
				} else {
					Circle().fill(MaskinSurface.fill).frame(width: 24, height: 24)
				}
			}
			VStack(alignment: .leading, spacing: MaskinSpace.s1) {
				DecisionTitle(decision: decision, lines: 2, font: .subheadline.weight(.semibold))
				AgentLine(decision: decision, now: now)
				if !decision.optionLabels.isEmpty && !typeSize.isAccessibilitySize {
					HStack(spacing: MaskinSpace.s2) {
						ForEach(Array(decision.optionLabels.prefix(2).enumerated()), id: \.offset) { _, label in
							OptionChip(label: label, recommended: label == decision.recommendedLabel)
						}
					}
					.padding(.top, MaskinSpace.s1)
				}
			}
			Spacer(minLength: 0)
		}
		.padding(.vertical, MaskinSpace.s4)
		.frame(maxWidth: .infinity, alignment: .leading)
	}
}

// MARK: - Empty and notices

private struct AllClearView: View {
	let snapshot: WidgetSnapshot
	let now: Date
	let size: HomeSize

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s3) {
			HeaderLabel()
			Spacer(minLength: 0)
			Image(systemName: "checkmark.circle")
				.font(.system(size: size == .small ? 26 : 32, weight: .regular))
				.foregroundStyle(MaskinColor.success)
				.accessibilityHidden(true)
			Text("Nothing needs you")
				.font(size == .small ? .subheadline.weight(.semibold) : .headline)
				.foregroundStyle(MaskinColor.ink)
			if snapshot.unreadCount > 0 {
				Text("\(snapshot.unreadLabel) unread \(snapshot.unreadCount == 1 ? "notification" : "notifications")")
					.font(.caption)
					.foregroundStyle(MaskinColor.ink4)
			} else {
				Text("Agents are working. We'll tell you when they need a call.")
					.font(.caption)
					.foregroundStyle(MaskinColor.ink4)
					.lineLimit(size == .small ? 2 : 3)
			}
			Spacer(minLength: 0)
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
				BrandGlyph(size: compact ? 28 : 34)
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
