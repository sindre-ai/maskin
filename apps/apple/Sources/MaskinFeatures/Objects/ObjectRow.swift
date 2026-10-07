import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// One object in the list, laid out like a conversation row: a type glyph, the title over a
/// quiet line of type, status and driver, then age, star and unread state at the trailing edge.
/// Pure values in, so it renders in previews and snapshots.
struct ObjectRow: View {
	let object: WorkObject
	let typeName: String
	/// The driver's resolved name; left out of the subtitle when it can't be resolved.
	let ownerName: String?
	var ownerIsAgent = false
	var showsStatus = false

	var body: some View {
		HStack(alignment: .center, spacing: MaskinSpace.s7) {
			typeGlyph
			VStack(alignment: .leading, spacing: MaskinSpace.s1) {
				HStack(alignment: .firstTextBaseline, spacing: MaskinSpace.s3) {
					Text(object.displayTitle)
						.maskinText(.headline)
						.fontWeight(object.unreadCount > 0 ? .bold : .semibold)
						.foregroundStyle(MaskinColor.ink)
						.lineLimit(1)
					Spacer(minLength: MaskinSpace.s3)
					RelativeTime(object.updatedAt, style: .compact)
						.maskinText(.caption)
						.foregroundStyle(object.unreadCount > 0 ? MaskinColor.sigInk : MaskinColor.ink4)
				}
				HStack(alignment: .center, spacing: MaskinSpace.s4) {
					if let activity = object.activeActivity, !activity.isEmpty {
						Label(activity, systemImage: "sparkles")
							.maskinText(.subhead)
							.foregroundStyle(MaskinColor.sigInk)
							.lineLimit(1)
					} else {
						Text(subtitle)
							.maskinText(.subhead)
							.foregroundStyle(MaskinColor.ink4)
							.lineLimit(1)
					}
					Spacer(minLength: 0)
					if object.unreadCount > 0 { UnreadBadge(count: object.unreadCount) }
				}
			}
		}
		.padding(.vertical, MaskinSpace.s2)
		.contentShape(Rectangle())
		.accessibilityElement(children: .combine)
		.accessibilityLabel(accessibilityLabel)
	}

	/// The type's glyph on its tint, the size of a chat avatar so the lists line up. A starred
	/// object shows a star in that slot instead, so the title doesn't need a star of its own.
	private var typeGlyph: some View {
		let colors = object.isStarred ? MaskinColorPair(bg: MaskinSurface.fill, fg: MaskinColor.ink) : MaskinObjectType.colors(for: object.type)
		let size = MaskinSpace.s14 + MaskinSpace.s4
		return Circle()
			.fill(colors.bg)
			.frame(width: size, height: size)
			.overlay {
				Image(systemName: object.isStarred ? "star.fill" : MaskinObjectType.symbol(for: object.type) ?? "circle.fill")
					.font(.system(size: MaskinFontSize.t15, weight: .semibold))
					.foregroundStyle(colors.fg)
			}
			.accessibilityHidden(true)
	}

	private var subtitle: String {
		var parts = [typeName]
		if showsStatus { parts.append(MaskinStatus.label(for: object.status)) }
		if object.hasActiveSession { parts.append("Agents working") }
		return parts.joined(separator: " · ")
	}

	private var accessibilityLabel: String {
		var parts = [typeName, object.displayTitle]
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
					.fill(MaskinObjectType.colors(for: group.id).fg)
					.frame(width: MaskinSpace.s4, height: MaskinSpace.s4)
					.accessibilityHidden(true)
				Text((group.title ?? group.id).uppercased())
					.maskinText(.mono)
					.foregroundStyle(MaskinColor.ink3)
			} else if !group.id.isEmpty {
				StatusBadge(group.id, style: .dotWord)
			}
			Text("\(group.objects.count)").maskinText(.mono).foregroundStyle(MaskinColor.ink5)
			Spacer()
		}
		.textCase(nil)
		.accessibilityElement(children: .combine)
		.accessibilityAddTraits(.isHeader)
	}
}
