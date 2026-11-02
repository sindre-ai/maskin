import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// Spec 7 §4: the one pinned message, as a strip under the chat title. `card`, radius 16, a pin
/// icon in `sigInk`, the mono label `PINNED · {name}`, one line of the text, and ✕ to unpin. Tapping
/// the body scrolls to the message.
struct PinnedMessageStrip: View {
	let message: ChatMessage
	let onOpen: () -> Void
	let onUnpin: () -> Void

	private var shape: RoundedRectangle { RoundedRectangle(cornerRadius: MaskinRadius.panelXl, style: .continuous) }

	var body: some View {
		HStack(spacing: MaskinSpace.s5) {
			Image(systemName: "pin.fill")
				.font(.system(size: MaskinFontSize.t13, weight: .semibold))
				.foregroundStyle(MaskinColor.sigInk)
				.accessibilityHidden(true)
			Button(action: onOpen) {
				VStack(alignment: .leading, spacing: MaskinSpace.s1) {
					Text("PINNED · \(message.actorName)").font(ChatType.mono11).tracking(ChatType.mono11Tracking).foregroundStyle(MaskinColor.ink5)
						.lineLimit(1)
					Text(ChatPreviewText.plain(message.content))
						.font(MaskinTypeface.sans(MaskinFontSize.t14, relativeTo: .subheadline))
						.foregroundStyle(MaskinColor.ink2).lineLimit(1)
				}
				.frame(maxWidth: .infinity, alignment: .leading)
				.padding(.vertical, MaskinSpace.s3)
				.contentShape(Rectangle())
			}
			.buttonStyle(.maskinPressed)
			.accessibilityLabel("Pinned by \(message.actorName): \(ChatPreviewText.plain(message.content))")
			.accessibilityHint("Scrolls to the message")
			Button(action: onUnpin) {
				Image(systemName: "xmark").font(.system(size: MaskinFontSize.t13, weight: .bold))
					.foregroundStyle(MaskinColor.ink4)
					.frame(width: MaskinSpace.s14 + MaskinSpace.s4, height: MaskinSpace.s14 + MaskinSpace.s4)
					.contentShape(Circle())
			}
			.buttonStyle(.maskinPressed)
			.accessibilityLabel("Unpin")
		}
		.padding(.leading, MaskinSpace.s8)
		.padding([.vertical, .trailing], MaskinSpace.s2)
		.background(MaskinSurface.card, in: shape)
		.accessibilityElement(children: .contain)
	}
}
