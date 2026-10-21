import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// The row under a message that has a thread: the people in it as overlapping avatars, then
/// "3 replies" (a green link) or, when some are unread, a dark "2 new replies" capsule. Tap opens
/// the thread.
struct ThreadPill: View {
	let summary: ThreadSummary
	/// The pill sits under a bubble on your side of the chat: lean right with it.
	var isOwn = false
	let onOpen: () -> Void

	private static let avatar = MaskinSpace.s12
	private static let overlap = MaskinSpace.s3

	var body: some View {
		Button(action: onOpen) {
			HStack(spacing: MaskinSpace.s4) {
				HStack(spacing: -Self.overlap) {
					ForEach(summary.participants) { person in
						ActorAvatar(
							name: person.name, kind: person.kind == .agent ? .agent : .human, size: Self.avatar,
							seed: person.id
						)
						.overlay(Circle().strokeBorder(MaskinSurface.grouped, lineWidth: 2))
						.accessibilityHidden(true)
					}
				}
				if summary.unreadCount > 0 {
					HStack(spacing: MaskinSpace.s1) {
						Text(summary.label)
						Image(systemName: "chevron.right").maskinSymbol(MaskinFontSize.t11, weight: .bold)
					}
					.font(MaskinTypeface.sans(MaskinFontSize.t13, weight: .bold, relativeTo: .footnote))
					.foregroundStyle(MaskinSurface.onInverse)
					.padding(.horizontal, MaskinSpace.s5)
					.frame(height: MaskinSpace.s14 + MaskinSpace.s1)
					.background(MaskinSurface.inverse, in: Capsule())
				} else {
					HStack(spacing: MaskinSpace.s2) {
						Text(summary.label)
						Image(systemName: "chevron.right").maskinSymbol(MaskinFontSize.t11, weight: .bold)
					}
					.font(MaskinTypeface.sans(MaskinFontSize.t14, weight: .bold, relativeTo: .subheadline))
					.foregroundStyle(MaskinColor.sigInk)
				}
			}
			.frame(minHeight: MaskinSpace.touchMin)
			.contentShape(Rectangle())
		}
		.buttonStyle(.maskinPressed)
		.frame(maxWidth: .infinity, alignment: isOwn ? .trailing : .leading)
		.accessibilityLabel("\(summary.label). Open thread")
	}
}
