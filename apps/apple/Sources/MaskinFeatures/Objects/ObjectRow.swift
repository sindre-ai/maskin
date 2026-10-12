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

/// "Needs you": the Patina marker the lists use, a dot on rows and the words on board cards.
struct NeedsYouDot: View {
	var body: some View {
		Circle().fill(MaskinColor.sig)
			.frame(width: MaskinSpace.s4, height: MaskinSpace.s4)
			.accessibilityLabel("Needs you")
	}
}

/// The driver's coded avatar (people are circles, agents their own shapes). Nothing when the
/// driver can't be resolved: no initials of an id.
struct ObjectDriverAvatar: View {
	let name: String?
	let isAgent: Bool
	let seed: String?
	var working = false
	var size: CGFloat = MaskinSpace.s11

	var body: some View {
		if let name {
			ActorAvatar(name: name, kind: isAgent ? .agent : .human, size: size, seed: seed, working: working)
		}
	}
}

/// Three pulsing bars: an agent is working on this object right now.
struct ObjectWorkingGlyph: View {
	@Environment(\.accessibilityReduceMotion) private var reduceMotion

	var body: some View {
		Image(systemName: "waveform")
			.maskinSymbol(MaskinFontSize.t11, weight: .bold)
			.foregroundStyle(MaskinColor.sigInk)
			.symbolEffect(.variableColor.iterative, isActive: !reduceMotion)
			.accessibilityHidden(true)
	}
}

/// One object in the list (handoff 8): a type glyph (only when the list mixes types) and the title,
/// the agent's ask in Patina only when it needs the person, then driver, working bars, status and
/// time. No type tag, no ID, no flow, no due date or priority: those live on the object page. Pure
/// values in, so it renders in previews and snapshots; the surrounding card belongs to the list.
struct ObjectRow: View {
	let object: WorkObject
	let typeName: String
	/// The driver's resolved name; no avatar when it can't be resolved.
	let ownerName: String?
	var ownerIsAgent = false
	/// The open ask, as "Strategist: Post text only…". Only passed while it needs the person.
	var ask: ObjectAsk?
	/// Whether the object wants the person (the ask, or a status that does).
	var needsYou = false
	/// The type glyph shows only when the list mixes types.
	var showsTypeGlyph = false
	var showsStatus = true
	var showsDriver = true
	var showsUpdated = true
	/// Regular width: the driver's name beside the avatar, for the extra room.
	var showsDriverName = false

	var body: some View {
		HStack(alignment: .top, spacing: MaskinSpace.s7) {
			if showsTypeGlyph {
				Image(systemName: ObjectTypeOrder.symbol(for: object.type))
					.maskinSymbol(MaskinFontSize.t16)
					.foregroundStyle(MaskinColor.ink4)
					.frame(width: MaskinSpace.s11, height: MaskinSpace.s11)
					.accessibilityHidden(true)
			}
			VStack(alignment: .leading, spacing: MaskinSpace.s2) {
				HStack(alignment: .firstTextBaseline, spacing: MaskinSpace.s3) {
					Text(object.displayTitle)
						.maskinText(.headline)
						.fontWeight(object.unreadCount > 0 ? .bold : .semibold)
						.foregroundStyle(MaskinColor.ink)
						.lineLimit(2)
						.multilineTextAlignment(.leading)
					if object.isStarred {
						Image(systemName: "star.fill")
							.maskinSymbol(MaskinFontSize.t11)
							.foregroundStyle(MaskinColor.ink5)
							.accessibilityHidden(true)
					}
					if object.unreadCount > 0 {
						Circle().fill(MaskinColor.sig)
							.frame(width: MaskinSpace.s3 + MaskinSpace.s1 / 2, height: MaskinSpace.s3 + MaskinSpace.s1 / 2)
							.accessibilityLabel("Changed since you last looked")
					}
				}
				if let ask {
					askLine(ask)
				}
				footer
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
			if let by = ask.by {
				Text(by).fontWeight(.bold) + Text(": \(ask.text)")
			} else {
				Text(ask.text)
			}
		}
		.maskinText(.subhead)
		.foregroundStyle(MaskinColor.sigInk)
		.lineLimit(1)
	}

	@ViewBuilder private var footer: some View {
		let hasDriver = showsDriver && ownerName != nil
		if hasDriver || showsStatus || showsUpdated || object.hasActiveSession {
			HStack(alignment: .center, spacing: MaskinSpace.s4) {
				if showsDriver {
					ObjectDriverAvatar(
						name: ownerName, isAgent: ownerIsAgent, seed: object.driverId,
						working: object.hasActiveSession, size: MaskinSpace.s10)
					if showsDriverName, let ownerName {
						Text(ownerName)
							.maskinText(.caption)
							.foregroundStyle(MaskinColor.ink3)
							.lineLimit(1)
					}
				}
				if object.hasActiveSession { ObjectWorkingGlyph() }
				if showsStatus {
					StatusWord(status: object.status, tone: ObjectsStatusTone.of(object).color)
				}
				Spacer(minLength: MaskinSpace.s3)
				if showsUpdated {
					RelativeTime(object.updatedAt, style: .compact)
						.maskinText(.caption)
						.foregroundStyle(MaskinColor.ink5)
				}
			}
		}
	}

	private var accessibilityLabel: String {
		var parts = [typeName, object.displayTitle, MaskinStatus.label(for: object.status)]
		if let ownerName, showsDriver { parts.append("driven by \(ownerName)") }
		if let ask { parts.append("Needs you: \(ask.line)") } else if needsYou { parts.append("Needs you") }
		if object.isStarred { parts.append("Starred") }
		if object.hasActiveSession { parts.append("Agents working") }
		if object.unreadCount > 0 { parts.append("Changed since you last looked") }
		return parts.joined(separator: ", ")
	}
}

/// Section header for a group (handoff 8): the status mark, the name in sentence case, the count,
/// and a chevron; tapping folds the group. A type or driver group shows its name alone.
struct ObjectGroupHeader: View {
	let group: ObjectGroup
	var isCollapsed = false
	/// Nil makes the header static (snapshots).
	var toggle: (() -> Void)?

	var body: some View {
		let label = HStack(spacing: MaskinSpace.s4) {
			if group.isType {
				Image(systemName: ObjectTypeOrder.symbol(for: group.id))
					.maskinSymbol(MaskinFontSize.t13)
					.foregroundStyle(MaskinColor.ink4)
					.accessibilityHidden(true)
			} else if !group.isAttention, !group.id.isEmpty, Self.isStatus(group) {
				StatusCategoryGlyph(category: StatusCategory.of(group.id), size: MaskinSpace.s8)
			}
			Text(Self.title(group))
				.maskinText(.subhead).fontWeight(.semibold)
				.foregroundStyle(MaskinColor.ink2)
			Text("\(group.objects.count)")
				.maskinText(.caption)
				.foregroundStyle(MaskinColor.ink5)
			Spacer()
			if toggle != nil {
				Image(systemName: "chevron.down")
					.maskinSymbol(MaskinFontSize.t11, weight: .semibold)
					.foregroundStyle(MaskinColor.ink5)
					.rotationEffect(.degrees(isCollapsed ? -90 : 0))
					.accessibilityHidden(true)
			}
		}
		.textCase(nil)
		.frame(minHeight: MaskinSpace.touchMin)
		.contentShape(Rectangle())
		if let toggle {
			Button(action: toggle) { label }
				.buttonStyle(.maskinPressed)
				.accessibilityHint(isCollapsed ? "Shows the group" : "Folds the group")
				.accessibilityAddTraits(.isHeader)
		} else {
			label
				.accessibilityElement(children: .combine)
				.accessibilityAddTraits(.isHeader)
		}
	}

	/// A status group's `id` is the raw status key, and its title the key with spaces.
	private static func isStatus(_ group: ObjectGroup) -> Bool {
		group.title == group.id.replacingOccurrences(of: "_", with: " ")
	}

	/// "in progress" -> "In progress": sentence case through the shared label table.
	static func title(_ group: ObjectGroup) -> String {
		if isStatus(group) { return MaskinStatus.label(for: group.id) }
		return group.title ?? group.id
	}
}
