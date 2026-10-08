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

/// The type as the lists show it: the hued square (the one place a type keeps its colour) and a
/// neutral mono pill with the type's name.
struct ObjectTypeTag: View {
	let type: String
	let name: String

	var body: some View {
		HStack(spacing: MaskinSpace.s3) {
			RoundedRectangle(cornerRadius: MaskinRadius.tag2, style: .continuous)
				.fill(MaskinObjectType.dotColor(for: type))
				.frame(width: MaskinSpace.s4 - MaskinSpace.s1, height: MaskinSpace.s4 - MaskinSpace.s1)
				.accessibilityHidden(true)
			Text(name.uppercased())
				.maskinText(.microLabel)
				.foregroundStyle(MaskinColor.ink2)
				.padding(.horizontal, MaskinSpace.s3)
				.padding(.vertical, MaskinSpace.s1)
				.background(MaskinSurface.fill, in: RoundedRectangle(cornerRadius: MaskinRadius.inputSm, style: .continuous))
				.lineLimit(1)
		}
		.fixedSize()
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

/// One object in the list: type tag over the title over driver, status and age. Pure values in, so
/// it renders in previews and snapshots; the surrounding card belongs to the list.
struct ObjectRow: View {
	let object: WorkObject
	let typeName: String
	/// The driver's resolved name; no avatar when it can't be resolved.
	let ownerName: String?
	var ownerIsAgent = false
	var showsStatus = true
	var showsDriver = true
	var showsUpdated = true

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s4) {
			HStack(alignment: .center, spacing: MaskinSpace.s4) {
				ObjectTypeTag(type: object.type, name: typeName)
				Spacer(minLength: MaskinSpace.s3)
				if object.isStarred {
					Image(systemName: "star.fill")
						.font(.system(size: MaskinFontSize.t12))
						.foregroundStyle(MaskinColor.ink4)
						.accessibilityHidden(true)
				}
				if ObjectsUrgency.needsYou(object) { NeedsYouDot() }
			}
			Text(object.displayTitle)
				.maskinText(.headline)
				.fontWeight(object.unreadCount > 0 ? .bold : .semibold)
				.foregroundStyle(MaskinColor.ink)
				.lineLimit(2)
				.multilineTextAlignment(.leading)
			if let activity = object.activeActivity, !activity.isEmpty {
				Label(activity, systemImage: "sparkles")
					.maskinText(.subhead)
					.foregroundStyle(MaskinColor.sigInk)
					.lineLimit(1)
			}
			footer
		}
		.frame(maxWidth: .infinity, alignment: .leading)
		.contentShape(Rectangle())
		.accessibilityElement(children: .combine)
		.accessibilityLabel(accessibilityLabel)
	}

	@ViewBuilder private var footer: some View {
		let hasDriver = showsDriver && ownerName != nil
		if hasDriver || showsStatus || showsUpdated || object.unreadCount > 0 {
			HStack(alignment: .center, spacing: MaskinSpace.s4) {
				if showsDriver {
					ObjectDriverAvatar(
						name: ownerName, isAgent: ownerIsAgent, seed: object.driverId,
						working: object.hasActiveSession)
				}
				if showsStatus {
					StatusWord(status: object.status, tone: ObjectsStatusTone.of(object).color)
				}
				Spacer(minLength: MaskinSpace.s3)
				if object.unreadCount > 0 { UnreadBadge(count: object.unreadCount) }
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
		if ObjectsUrgency.needsYou(object) { parts.append("Needs you") }
		if object.isStarred { parts.append("Starred") }
		if object.hasActiveSession { parts.append("Agents working") }
		if object.unreadCount > 0 { parts.append("\(object.unreadCount) unread") }
		return parts.joined(separator: ", ")
	}
}

/// Section header for a group: a type (colour square, mono label, count) or a status.
struct ObjectGroupHeader: View {
	let group: ObjectGroup

	var body: some View {
		HStack(spacing: MaskinSpace.s4) {
			if group.isType {
				RoundedRectangle(cornerRadius: MaskinRadius.tag2, style: .continuous)
					.fill(MaskinObjectType.dotColor(for: group.id))
					.frame(width: MaskinSpace.s4, height: MaskinSpace.s4)
					.accessibilityHidden(true)
				Text((group.title ?? group.id).uppercased())
					.maskinText(.microLabelLarge)
					.foregroundStyle(MaskinColor.ink4)
			} else if !group.id.isEmpty {
				Text(MaskinStatus.label(for: group.id).uppercased())
					.maskinText(.microLabelLarge)
					.foregroundStyle(MaskinColor.ink4)
			}
			Text("\(group.objects.count)").maskinText(.microLabelLarge).foregroundStyle(MaskinColor.ink5)
			Spacer()
		}
		.textCase(nil)
		.accessibilityElement(children: .combine)
		.accessibilityAddTraits(.isHeader)
	}
}
