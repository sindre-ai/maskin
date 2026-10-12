import MaskinCore
import MaskinDesign
import SwiftUI

/// Swipe right on a bubble to reply to it. The bubble follows the finger at 0.7x up to 84pt, a
/// selection tick marks the 56pt threshold, and releasing past it calls `onReply`. It springs back
/// over 0.28s. A mostly vertical drag is left to the scroll view.
private struct SwipeToReply: ViewModifier {
	let onReply: () -> Void
	@State private var offset: Double = 0
	@State private var armed = false
	@State private var cancelled = false

	func body(content: Content) -> some View {
		content
			.offset(x: offset)
			.background(alignment: .leading) {
				Image(systemName: "arrowshape.turn.up.left.fill")
					.foregroundStyle(armed ? MaskinColor.ink : MaskinColor.ink5)
					.opacity(min(offset / SwipeReply.threshold, 1))
					.scaleEffect(armed ? 1.15 : 0.85)
					.accessibilityHidden(true)
			}
			.simultaneousGesture(
				DragGesture(minimumDistance: MaskinSpace.s5)
					.onChanged { value in
						let dx = Double(value.translation.width)
						let dy = Double(value.translation.height)
						if cancelled { return }
						guard SwipeReply.isReplySwipe(dx: dx, dy: dy) || offset > 0 else {
							if abs(dy) > SwipeReply.verticalCancel { cancelled = true }
							return
						}
						offset = SwipeReply.offset(forDrag: dx)
						let reached = SwipeReply.reachesThreshold(offset: offset)
						if reached != armed {
							armed = reached
							if reached { MaskinHaptics.play(.selection) }
						}
					}
					.onEnded { _ in
						let reply = armed && !cancelled
						cancelled = false
						armed = false
						withAnimation(.timingCurve(0.32, 0.72, 0, 1, duration: 0.28)) { offset = 0 }
						if reply { onReply() }
					}
			)
	}
}

extension View {
	/// Swipe right to reply; a nil action leaves the view alone.
	@ViewBuilder
	func swipeToReply(_ onReply: (() -> Void)?) -> some View {
		if let onReply { modifier(SwipeToReply(onReply: onReply)) } else { self }
	}
}
