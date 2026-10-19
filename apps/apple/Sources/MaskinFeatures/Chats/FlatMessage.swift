import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// v5 message layout: no bubbles. A 36pt avatar column on the left (agents a shape, people a
/// circle), and beside it the name (15 bold) and time (12) on the first message of a run, then the
/// text at 16pt. Later messages of the run leave the avatar column empty.
struct FlatMessageFrame<Content: View>: View {
	let showsAuthor: Bool
	let name: String
	let kind: ChatParticipant.Kind
	let seed: String
	let time: Date?
	var working = false
	var onOpen: (() -> Void)?
	@ViewBuilder var content: Content

	static var avatarSize: CGFloat { MaskinSpace.s12 + MaskinSpace.s12 / 2 }

	var body: some View {
		HStack(alignment: .top, spacing: MaskinSpace.s5) {
			Group {
				if showsAuthor {
					avatar
				} else {
					Color.clear
				}
			}
			.frame(width: Self.avatarSize, height: showsAuthor ? Self.avatarSize : 0, alignment: .top)
			VStack(alignment: .leading, spacing: MaskinSpace.s2 + MaskinSpace.s1 / 2) {
				if showsAuthor { header }
				content
			}
			.frame(maxWidth: .infinity, alignment: .leading)
		}
		.padding(.top, showsAuthor ? MaskinSpace.s3 : 0)
	}

	@ViewBuilder private var avatar: some View {
		let image = ActorAvatar(
			name: name, kind: kind == .agent ? .agent : .human, size: Self.avatarSize, seed: seed, working: working)
			.accessibilityHidden(true)
		if let onOpen {
			Button(action: onOpen) { image }.buttonStyle(.maskinPressed)
				.accessibilityLabel("\(name), open agent")
		} else {
			image
		}
	}

	private var header: some View {
		HStack(alignment: .firstTextBaseline, spacing: MaskinSpace.s4) {
			Text(name).font(MaskinTypeface.sans(MaskinFontSize.t15, weight: .bold, relativeTo: .subheadline))
				.foregroundStyle(MaskinColor.ink).lineLimit(1)
			if let time {
				RelativeTime(time, style: .clock)
					.font(MaskinTypeface.sans(MaskinFontSize.t12, relativeTo: .caption)).foregroundStyle(MaskinColor.ink5)
			}
		}
	}
}
