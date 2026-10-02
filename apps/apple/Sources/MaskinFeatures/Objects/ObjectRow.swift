import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// One object in the list. Pure values in, so it renders in previews and snapshots.
struct ObjectRow: View {
	let object: WorkObject
	let typeName: String
	let ownerName: String?
	var showsStatus = false

	var body: some View {
		HStack(alignment: .top, spacing: MaskinSpace.s7) {
			TypeBadge(object.type, style: .tile)
			VStack(alignment: .leading, spacing: MaskinSpace.s2) {
				Text(object.displayTitle)
					.maskinText(.headline)
					.foregroundStyle(MaskinColor.ink)
					.lineLimit(2)
					.multilineTextAlignment(.leading)
				HStack(spacing: MaskinSpace.s3) {
					MonoLabel(typeName)
					if let ownerName {
						Text("·")
						Text(ownerName).lineLimit(1)
					}
					if object.updatedAt != nil {
						Text("·")
						RelativeTime(object.updatedAt, style: .compact)
					}
				}
				.maskinText(.caption)
				.foregroundStyle(MaskinColor.ink4)
				if let activity = object.activeActivity, !activity.isEmpty {
					Label(activity, systemImage: "sparkles")
						.maskinText(.caption)
						.foregroundStyle(MaskinColor.accentFgStrong)
						.lineLimit(1)
				}
				if showsStatus { StatusBadge(object.status, style: .dotWord) }
			}
			Spacer(minLength: MaskinSpace.s2)
			VStack(alignment: .trailing, spacing: MaskinSpace.s4) {
				if object.isStarred {
					Image(systemName: "star.fill")
						.font(.system(size: MaskinFontSize.t13))
						.foregroundStyle(MaskinColor.accent)
						.accessibilityLabel("Starred")
				}
				if object.unreadCount > 0 {
					Circle().fill(MaskinColor.accent)
						.frame(width: MaskinSpace.s4, height: MaskinSpace.s4)
						.accessibilityLabel("\(object.unreadCount) unread")
				}
			}
		}
		.padding(.vertical, MaskinSpace.s2)
		.contentShape(Rectangle())
		.accessibilityElement(children: .combine)
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
