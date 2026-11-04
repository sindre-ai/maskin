import MaskinCore
import MaskinDesign
import SwiftUI

#if os(iOS)
	import UIKit

	/// A UIKit pan that only *begins* for a clearly rightward, mostly horizontal flick and always
	/// recognises alongside the scroll view's own pan. A SwiftUI `DragGesture` on a bubble competes
	/// with (and on recent iOS swallows) the vertical scroll pan; a delegate-gated recognizer cannot,
	/// because a vertical drag never begins it.
	@available(iOS 18.0, *)
	private struct ReplyPan: UIGestureRecognizerRepresentable {
		let onChange: (_ dx: Double) -> Void
		let onEnd: (_ completed: Bool) -> Void

		func makeCoordinator(converter: CoordinateSpaceConverter) -> Coordinator { Coordinator() }

		func makeUIGestureRecognizer(context: Context) -> UIPanGestureRecognizer {
			let pan = UIPanGestureRecognizer()
			pan.delegate = context.coordinator
			pan.cancelsTouchesInView = false
			pan.delaysTouchesBegan = false
			pan.delaysTouchesEnded = false
			return pan
		}

		func handleUIGestureRecognizerAction(_ recognizer: UIPanGestureRecognizer, context: Context) {
			switch recognizer.state {
			case .changed:
				onChange(Double(recognizer.translation(in: recognizer.view).x))
			case .ended:
				onEnd(true)
			case .cancelled, .failed:
				onEnd(false)
			default: break
			}
		}

		final class Coordinator: NSObject, UIGestureRecognizerDelegate {
			func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
				guard let pan = gestureRecognizer as? UIPanGestureRecognizer else { return false }
				let v = pan.velocity(in: pan.view)
				// Rightward and mostly horizontal; anything else belongs to the scroll view.
				return SwipeReply.isReplySwipe(dx: Double(v.x), dy: Double(v.y))
			}

			func gestureRecognizer(
				_ gestureRecognizer: UIGestureRecognizer,
				shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer
			) -> Bool { true }
		}
	}
#endif

/// Swipe right on a bubble to reply to it. The bubble follows the finger at 0.7x up to 84pt, a
/// selection tick marks the 56pt threshold, and releasing past it calls `onReply`. It springs back
/// over 0.28s. Vertical drags never reach this: the recognizer refuses to begin for them.
struct SwipeToReply: ViewModifier {
	let onReply: () -> Void
	@State private var offset: Double = 0
	@State private var armed = false
	@Environment(\.accessibilityReduceMotion) private var reduceMotion

	/// Max row travel; mirrors `SwipeReply.cap` for callers and tests.
	static let cap = CGFloat(SwipeReply.cap)

	/// Row travel for a finger travel of `translation` points.
	static func offset(for translation: CGFloat) -> CGFloat {
		CGFloat(SwipeReply.offset(forDrag: Double(translation)))
	}

	func body(content: Content) -> some View {
		let visual = content
			.offset(x: offset)
			.background(alignment: .leading) {
				Image(systemName: "arrowshape.turn.up.left.fill")
					.foregroundStyle(armed ? MaskinColor.ink : MaskinColor.ink5)
					.opacity(min(offset / SwipeReply.threshold, 1))
					.scaleEffect(armed ? 1.15 : 0.85)
					.accessibilityHidden(true)
			}
		#if os(iOS)
			if #available(iOS 18.0, *) {
				visual.gesture(
					ReplyPan(onChange: track, onEnd: finish))
			} else {
				// iOS 17 has no UIKit-gesture bridge; reply stays available from the context menu.
				visual
			}
		#else
			visual
		#endif
	}

	private func track(_ dx: Double) {
		offset = SwipeReply.offset(forDrag: dx)
		let reached = SwipeReply.reachesThreshold(offset: offset)
		if reached != armed {
			armed = reached
			if reached { MaskinHaptics.play(.selection) }
		}
	}

	private func finish(_ completed: Bool) {
		let reply = armed && completed
		armed = false
		withAnimation(reduceMotion ? nil : .timingCurve(0.32, 0.72, 0, 1, duration: 0.28)) { offset = 0 }
		if reply { onReply() }
	}
}

extension View {
	/// Swipe right to reply; a nil action leaves the view alone.
	@ViewBuilder
	func swipeToReply(_ onReply: (() -> Void)?) -> some View {
		if let onReply { modifier(SwipeToReply(onReply: onReply)) } else { self }
	}
}
