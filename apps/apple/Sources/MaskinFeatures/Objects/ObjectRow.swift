import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

extension ObjectsStatusTone {
	/// Patina for running and needs-you, ink for done, grey for paused.
	var color: Color {
		switch self {
		case .patina: MaskinColor.sigInk
		case .ink: MaskinColor.doneFg
		case .quiet: MaskinColor.ink4
		case .neutral: MaskinColor.ink3
		}
	}
}

/// The type as a mono pill with its dot (the one place a type keeps its hue). Kept for the
/// detail header; rows no longer carry it (handoff spec 8).
struct ObjectTypeTag: View {
	let type: String
	let name: String

	var body: some View {
		HStack(spacing: MaskinSpace.s3) {
			RoundedRectangle(cornerRadius: MaskinRadius.tag2, style: .continuous)
				.fill(MaskinObjectType.dotColor(for: type))
				.frame(width: MaskinSpace.s4, height: MaskinSpace.s4)
				.accessibilityHidden(true)
			MonoLabel(name, color: MaskinColor.ink2, size: .chip)
				.padding(.horizontal, MaskinSpace.s3)
				.padding(.vertical, MaskinSpace.s1)
				.background(MaskinSurface.fill, in: RoundedRectangle(cornerRadius: MaskinRadius.inputSm, style: .continuous))
				.lineLimit(1)
		}
		.fixedSize()
	}
}

/// "Needs you": the Patina marker the lists use.
struct NeedsYouDot: View {
	var body: some View {
		Circle().fill(MaskinColor.sig)
			.frame(width: MaskinSpace.s4, height: MaskinSpace.s4)
			.accessibilityLabel("Needs you")
	}
}

/// The driver's coded avatar (people are circles, agents their own shapes), with the Patina
/// working ring while an agent runs on the object. An empty quiet slot when the driver can't be
/// resolved: no initials of an id.
struct ObjectDriverAvatar: View {
	let name: String?
	let isAgent: Bool
	let seed: String?
	var working = false
	var size: CGFloat = MaskinSpace.s10

	var body: some View {
		if let name, !name.isEmpty {
			ActorAvatar(name: name, kind: isAgent ? .agent : .human, size: size, seed: seed, working: working)
		} else {
			Circle()
				.fill(MaskinSurface.fill)
				.frame(width: size, height: size)
				.overlay {
					Image(systemName: "person")
						.maskinSymbol(MaskinFontSize.t10, weight: .semibold)
						.foregroundStyle(MaskinColor.ink5)
				}
				.accessibilityLabel("No driver")
		}
	}
}

/// Three small Patina bars that say "an agent is working here now". Still under Reduce Motion.
struct ObjectWorkingBars: View {
	@Environment(\.accessibilityReduceMotion) private var reduceMotion
	@State private var phase = false

	private let heights: [CGFloat] = [5, 11, 7]

	var body: some View {
		HStack(alignment: .center, spacing: 1.5) {
			ForEach(0..<3, id: \.self) { i in
				RoundedRectangle(cornerRadius: 1, style: .continuous)
					.fill(MaskinColor.sigInk)
					.frame(width: 2, height: phase && !reduceMotion ? heights[(i + 1) % 3] : heights[i])
			}
		}
		.frame(height: 11)
		.onAppear {
			guard !reduceMotion else { return }
			withAnimation(.easeInOut(duration: 0.6).repeatForever(autoreverses: true)) { phase = true }
		}
		.accessibilityLabel("Agent working")
	}
}

/// One object in the list or on the board, to the handoff's anatomy (`specs/8-Objects.md`):
/// - line 1: type glyph (only when the list mixes types) + title (2 lines) + unseen dot
/// - line 2: the ask in Patina, "Strategist: …", only when it needs you
/// - line 3: driver avatar 18 (Patina ring while an agent works) · working bars · status · time
/// No type tag, mono id, flow, due or priority: those live on the object page.
/// Pure values in, so it renders in previews and snapshots; the card belongs to the list.
struct ObjectRow: View {
	let object: WorkObject
	let typeName: String
	/// The list mixes types, so the row says which one this is.
	var showsGlyph = true
	/// An open ask for the reader, when the object needs them.
	var ask: ObjectAsk?
	/// The driver's resolved name; an empty slot when it can't be resolved.
	var ownerName: String?
	var ownerIsAgent = false
	var showsStatus = true
	var showsDriver = true
	var showsUpdated = true

	private var unseen: Bool { object.unreadCount > 0 }
	private var needsYou: Bool { ask != nil || ObjectsUrgency.needsYou(object) }

	var body: some View {
		HStack(alignment: .top, spacing: MaskinSpace.s7) {
			if showsGlyph {
				Image(systemName: MaskinObjectType.glyph(for: object.type))
					.maskinSymbol(MaskinFontSize.t17, weight: .regular)
					.foregroundStyle(MaskinColor.ink4)
					.frame(width: MaskinSpace.s11 + MaskinSpace.s1, height: MaskinSpace.s11 + MaskinSpace.s1)
					.accessibilityHidden(true)
			}
			VStack(alignment: .leading, spacing: MaskinSpace.s1) {
				HStack(alignment: .top, spacing: MaskinSpace.s3) {
					Text(object.displayTitle)
						.maskinText(.headline)
						.fontWeight(unseen ? .bold : .semibold)
						.foregroundStyle(MaskinColor.ink)
						.lineLimit(2)
						.multilineTextAlignment(.leading)
						.frame(maxWidth: .infinity, alignment: .leading)
					if unseen {
						Circle()
							.fill(MaskinColor.sig)
							.frame(width: MaskinSpace.s3 + 1, height: MaskinSpace.s3 + 1)
							.padding(.top, MaskinSpace.s3)
							.accessibilityHidden(true)
					}
				}
				if let ask {
					askLine(ask)
				}
				metaLine
			}
		}
		.frame(maxWidth: .infinity, alignment: .leading)
		.contentShape(Rectangle())
		.maskinHover()
		.accessibilityElement(children: .combine)
		.accessibilityLabel(accessibilityLabel)
	}

	private func askLine(_ ask: ObjectAsk) -> some View {
		Group {
			if let who = ask.askedBy, !who.isEmpty {
				Text("\(who): ").fontWeight(.bold) + Text(ask.text)
			} else {
				Text(ask.text)
			}
		}
		.maskinText(.subhead)
		.foregroundStyle(MaskinColor.sigInk)
		.lineLimit(1)
		.padding(.top, MaskinSpace.s1)
	}

	@ViewBuilder private var metaLine: some View {
		if showsDriver || showsStatus || showsUpdated || object.hasActiveSession {
			HStack(spacing: MaskinSpace.s3 + 1) {
				if showsDriver {
					ObjectDriverAvatar(
						name: ownerName, isAgent: ownerIsAgent, seed: object.driverId,
						working: object.hasActiveSession)
				}
				if object.hasActiveSession {
					ObjectWorkingBars()
				}
				if showsStatus {
					Text(MaskinStatus.sentenceLabel(for: object.status))
						.maskinText(.caption)
						.foregroundStyle(ObjectsStatusTone.of(object).color)
						.lineLimit(1)
				}
				Spacer(minLength: 0)
				if showsUpdated {
					RelativeTime(object.updatedAt, style: .compact)
						.maskinText(.caption)
						.monospacedDigit()
						.foregroundStyle(MaskinColor.ink5)
				}
			}
			.padding(.top, MaskinSpace.s2)
		}
	}

	private var accessibilityLabel: String {
		var parts = [typeName, object.displayTitle]
		if unseen { parts.append("Changed since you last looked") }
		if let ask { parts.append("Needs you. \(ask.line)") } else if needsYou { parts.append("Needs you") }
		if let ownerName, showsDriver { parts.append("driven by \(ownerName)") }
		if object.hasActiveSession { parts.append("Agent working") }
		parts.append(MaskinStatus.sentenceLabel(for: object.status))
		return parts.joined(separator: ", ")
	}
}

/// One object in the v5 list: a type square, the title (2 lines), "Type · driver · age" under it
/// and the status as a tinted pill. The ask and the unseen dot stay for rows that need the reader.
/// The board keeps `ObjectRow`; this is the list's alone.
struct ObjectListRow: View {
	let object: WorkObject
	let typeName: String
	/// "Task · Forge · 5m", already shaped by the Display's "Show on each row".
	let subtitle: String
	var ask: ObjectAsk?
	var showsStatus = true

	private var unseen: Bool { object.unreadCount > 0 }

	var body: some View {
		HStack(alignment: .center, spacing: MaskinSpace.s7) {
			RoundedRectangle(cornerRadius: MaskinRadius.tag2, style: .continuous)
				.fill(ObjectTypeSquare.color(for: object.type))
				.frame(width: MaskinSpace.s4 + 1, height: MaskinSpace.s4 + 1)
				.accessibilityHidden(true)
			VStack(alignment: .leading, spacing: MaskinSpace.s1) {
				HStack(alignment: .firstTextBaseline, spacing: MaskinSpace.s3) {
					Text(object.displayTitle)
						.maskinText(.subhead)
						.fontWeight(unseen ? .bold : .semibold)
						.foregroundStyle(MaskinColor.ink)
						.lineLimit(2)
						.multilineTextAlignment(.leading)
					if unseen {
						Circle().fill(MaskinColor.sig)
							.frame(width: MaskinSpace.s3, height: MaskinSpace.s3)
							.accessibilityHidden(true)
					}
				}
				if let ask {
					Group {
						if let who = ask.askedBy, !who.isEmpty {
							Text("\(who): ").fontWeight(.bold) + Text(ask.text)
						} else {
							Text(ask.text)
						}
					}
					.maskinText(.caption)
					.foregroundStyle(MaskinColor.sigInk)
					.lineLimit(1)
				}
				Text(subtitle)
					.maskinText(.caption)
					.foregroundStyle(MaskinColor.ink3)
					.lineLimit(1)
			}
			.frame(maxWidth: .infinity, alignment: .leading)
			if showsStatus {
				ObjectStatusPill(status: object.status)
			}
		}
		.frame(maxWidth: .infinity, alignment: .leading)
		.contentShape(Rectangle())
		.maskinHover()
		.accessibilityElement(children: .combine)
		.accessibilityLabel(accessibilityLabel)
	}

	private var accessibilityLabel: String {
		var parts = [typeName, object.displayTitle]
		if unseen { parts.append("Changed since you last looked") }
		if let ask { parts.append("Needs you. \(ask.line)") }
		if subtitle != typeName { parts.append(subtitle) }
		if object.hasActiveSession { parts.append("Agent working") }
		if showsStatus { parts.append(MaskinStatus.sentenceLabel(for: object.status)) }
		return parts.joined(separator: ", ")
	}
}

/// The type's square in the list: the Patina family, light to dark, so the types read apart
/// without a second hue.
enum ObjectTypeSquare {
	static func color(for type: String) -> Color {
		switch type {
		case "bet": MaskinColor.patina900
		case "task": MaskinColor.patina300
		case "insight": MaskinColor.patina400
		case "content": MaskinColor.patina200
		default: MaskinColor.ink5
		}
	}
}

/// The status as a pill in one hue family: running and asking in the teal tint, done a step
/// deeper, everything else quiet grey.
struct ObjectStatusPill: View {
	let status: String

	private var colors: (bg: Color, fg: Color) {
		switch StatusCategory.of(status) {
		case .active, .needsYou: (MaskinColor.sigTint, MaskinColor.patina700)
		case .done: (MaskinColor.patina100, MaskinColor.patina900)
		case .backlog, .cancelled: (MaskinSurface.fill, MaskinColor.ink3)
		}
	}

	var body: some View {
		Text(MaskinStatus.sentenceLabel(for: status))
			.maskinText(.caption)
			.fontWeight(.semibold)
			.foregroundStyle(colors.fg)
			.lineLimit(1)
			.padding(.horizontal, MaskinSpace.s4 + 1)
			.frame(height: MaskinSpace.s11 + MaskinSpace.s1)
			.background(colors.bg, in: Capsule())
			.fixedSize()
	}
}

/// Foldable header for a group, as the v5 list draws it: a chevron, the name, the count at the
/// end. Tap to fold.
struct ObjectGroupHeader: View {
	let group: ObjectGroup
	var collapsed = false
	var onToggle: (() -> Void)?

	var body: some View {
		Button {
			onToggle?()
		} label: {
			HStack(spacing: MaskinSpace.s4) {
				if onToggle != nil {
					Image(systemName: "chevron.down")
						.maskinSymbol(MaskinFontSize.t12, weight: .heavy)
						.foregroundStyle(MaskinColor.ink3)
						.rotationEffect(.degrees(collapsed ? -90 : 0))
						.frame(width: MaskinSpace.s7)
				}
				Text(group.title ?? "")
					.maskinText(.subhead)
					.fontWeight(.bold)
					.foregroundStyle(MaskinColor.ink2)
					.lineLimit(1)
				Spacer(minLength: 0)
				Text("\(group.objects.count)")
					.maskinText(.caption)
					.monospacedDigit()
					.foregroundStyle(MaskinColor.ink5)
			}
			.padding(.horizontal, MaskinSpace.s2)
			.frame(minHeight: MaskinSpace.touchMin)
			.contentShape(Rectangle())
		}
		.buttonStyle(.plain)
		.disabled(onToggle == nil)
		.textCase(nil)
		.accessibilityAddTraits(.isHeader)
		.accessibilityLabel("\(group.title ?? ""), \(group.objects.count)")
		.accessibilityHint(onToggle == nil ? "" : (collapsed ? "Expands the group" : "Folds the group"))
	}
}
