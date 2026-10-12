import MaskinDesign
import MaskinUI
import SwiftUI

/// Spec 7 §5: swipe right on a bubble to reply. The row follows the finger at 0.7×, capped at 84pt;
/// past 56pt there is a haptic tick and releasing starts the reply; it springs back over 0.28s. A
/// vertical move of more than 10pt before the threshold hands the gesture to scrolling.
struct SwipeToReply: ViewModifier {
	let onReply: () -> Void

	static let follow: CGFloat = 0.7
	static let cap: CGFloat = 84
	static let threshold: CGFloat = 56
	static let cancelAfterVertical: CGFloat = 10
	static let springBack = Animation.timingCurve(0.32, 0.72, 0, 1, duration: 0.28)

	@State private var offset: CGFloat = 0
	@State private var ticked = false
	@State private var cancelled = false
	@Environment(\.accessibilityReduceMotion) private var reduceMotion

	/// Pure mapping from finger travel to row travel, so the rule is testable.
	static func offset(for translation: CGFloat) -> CGFloat {
		min(max(translation, 0) * follow, cap)
	}

	func body(content: Content) -> some View {
		content
			.offset(x: offset)
			.overlay(alignment: .leading) {
				Image(systemName: "arrowshape.turn.up.left.fill")
					.font(.system(size: MaskinFontSize.t16, weight: .semibold))
					.foregroundStyle(ticked ? MaskinColor.ink : MaskinColor.ink4)
					.frame(width: MaskinSpace.s14, height: MaskinSpace.s14)
					.background(MaskinSurface.fill, in: Circle())
					.opacity(min(offset / Self.threshold, 1))
					.scaleEffect(ticked || reduceMotion ? 1 : 0.85)
					.offset(x: -(MaskinSpace.s14 + MaskinSpace.s4))
					.accessibilityHidden(true)
			}
			.gesture(
				DragGesture(minimumDistance: MaskinSpace.s7, coordinateSpace: .local)
					.onChanged { value in
						guard !cancelled else { return }
						if offset == 0, abs(value.translation.height) > Self.cancelAfterVertical,
							abs(value.translation.height) > abs(value.translation.width)
						{
							cancelled = true
							return
						}
						offset = Self.offset(for: value.translation.width)
						if offset >= Self.threshold, !ticked {
							ticked = true
							MaskinHaptics.play(.selection)
						} else if offset < Self.threshold {
							ticked = false
						}
					}
					.onEnded { _ in
						let fire = !cancelled && offset >= Self.threshold
						withAnimation(reduceMotion ? nil : Self.springBack) { offset = 0 }
						cancelled = false
						ticked = false
						if fire { onReply() }
					}
			)
	}
}

extension View {
	/// Swipe right to start a reply (spec 7 §5). Nil leaves the row still (nothing to quote).
	@ViewBuilder
	func swipeToReply(_ onReply: (() -> Void)?) -> some View {
		if let onReply {
			modifier(SwipeToReply(onReply: onReply))
		} else {
			self
		}
	}
}
