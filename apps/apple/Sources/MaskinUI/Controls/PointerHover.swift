import MaskinDesign
import SwiftUI

/// What a pointer hovering over a tappable does, per the v4 iPad handoff: rows and pills take the
/// `tint` fill, cards lift.
public enum MaskinHoverKind: Sendable, CaseIterable {
	/// Rows and pills: quiet fill behind the content.
	case fill
	/// Cards: the system lift effect.
	case lift

	/// Whether the fill shows for a hover state. Reduce Motion only removes the lift, never the fill.
	public func showsFill(isHovering: Bool) -> Bool { self == .fill && isHovering }
	/// The system pointer effect: highlight for rows and pills, lift for cards. Reduce Motion drops
	/// the lift (it moves); the highlight and the fill stay.
	public func systemEffect(reduceMotion: Bool) -> SystemEffect {
		switch self {
		case .fill: .highlight
		case .lift: reduceMotion ? .none : .lift
		}
	}

	public enum SystemEffect: Sendable, Equatable { case highlight, lift, none }
}

private struct MaskinHoverModifier: ViewModifier {
	let kind: MaskinHoverKind
	let radius: CGFloat
	@Environment(\.accessibilityReduceMotion) private var reduceMotion
	@State private var hovering = false

	func body(content: Content) -> some View {
		#if os(iOS) || os(visionOS)
			content
				.background {
					if kind.showsFill(isHovering: hovering) {
						RoundedRectangle(cornerRadius: radius, style: .continuous).fill(MaskinSurface.fill)
					}
				}
				.contentShape(.hoverEffect, RoundedRectangle(cornerRadius: radius, style: .continuous))
				.modifier(SystemHover(effect: kind.systemEffect(reduceMotion: reduceMotion)))
				.onHover { hovering = $0 }
		#elseif os(macOS)
			content
				.background {
					if kind.showsFill(isHovering: hovering) {
						RoundedRectangle(cornerRadius: radius, style: .continuous).fill(MaskinSurface.fill)
					}
				}
				.onHover { hovering = $0 }
		#else
			content
		#endif
	}
}

#if os(iOS) || os(visionOS)
	private struct SystemHover: ViewModifier {
		let effect: MaskinHoverKind.SystemEffect
		@ViewBuilder func body(content: Content) -> some View {
			switch effect {
			case .highlight: content.hoverEffect(.highlight)
			case .lift: content.hoverEffect(.lift)
			case .none: content
			}
		}
	}
#endif

extension View {
	/// Pointer feedback for a row, pill or card. `.fill` (default) tints the background on hover;
	/// `.lift` lifts a card with the system effect (skipped under Reduce Motion). Does nothing on
	/// platforms without a pointer.
	public func maskinHover(_ kind: MaskinHoverKind = .fill, cornerRadius: CGFloat = 10) -> some View {
		modifier(MaskinHoverModifier(kind: kind, radius: cornerRadius))
	}
}
