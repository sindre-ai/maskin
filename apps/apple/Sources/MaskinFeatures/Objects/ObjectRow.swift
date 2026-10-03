import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// One object in the list, on a single line (Linear-style): type glyph, title, then status,
/// star, unread dot and age at the trailing edge. Pure values in, so it renders in previews and
/// snapshots.
struct ObjectRow: View {
	let object: WorkObject
	let typeName: String
	/// The driver's resolved name; the avatar is omitted when it can't be resolved.
	let ownerName: String?
	var ownerIsAgent = false
	var showsStatus = false

	var body: some View {
		HStack(spacing: MaskinSpace.s5) {
			TypeBadge(object.type, label: typeName, style: .dot)
			Text(object.displayTitle)
				.maskinText(.subhead)
				.foregroundStyle(MaskinColor.ink)
				.lineLimit(1)
			if let activity = object.activeActivity, !activity.isEmpty {
				Image(systemName: "sparkles")
					.font(.caption2)
					.foregroundStyle(MaskinColor.accentFgStrong)
					.accessibilityLabel(activity)
			}
			Spacer(minLength: MaskinSpace.s3)
			if showsStatus { StatusBadge(object.status, style: .dotWord) }
			if object.isStarred {
				Image(systemName: "star.fill")
					.font(.caption2)
					.foregroundStyle(MaskinColor.accent)
					.accessibilityLabel("Starred")
			}
			if object.unreadCount > 0 {
				Circle().fill(MaskinColor.accent)
					.frame(width: MaskinSpace.s3, height: MaskinSpace.s3)
					.accessibilityLabel("\(object.unreadCount) unread")
			}
			if let ownerName {
				ActorAvatar(
					name: ownerName, kind: ownerIsAgent ? .agent : .human, size: MaskinSpace.s10,
					working: object.activeActivity?.isEmpty == false)
			}
			RelativeTime(object.updatedAt, style: .compact)
				.maskinText(.caption)
				.foregroundStyle(MaskinColor.ink5)
		}
		.padding(.vertical, MaskinSpace.s3)
		.contentShape(Rectangle())
		.accessibilityElement(children: .combine)
		.accessibilityLabel(accessibilityLabel)
	}

	private var accessibilityLabel: String {
		var parts = [typeName, object.displayTitle]
		if let ownerName { parts.append("Driver \(ownerName)") }
		return parts.joined(separator: ", ")
	}
}

/// Section header for a status group.
struct ObjectGroupHeader: View {
	let group: ObjectGroup

	var body: some View {
		HStack(spacing: MaskinSpace.s4) {
			if let status = Optional(group.id), !status.isEmpty {
				StatusBadge(status, style: .dotWord)
			}
			Text("\(group.objects.count)").maskinText(.mono).foregroundStyle(MaskinColor.ink5)
			Spacer()
		}
		.textCase(nil)
		.accessibilityAddTraits(.isHeader)
	}
}
