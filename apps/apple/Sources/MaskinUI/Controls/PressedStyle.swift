import MaskinDesign
import SwiftUI

/// What a pressed tappable does, per the v4 handoff: rows, links and icons dim to .55;
/// cards and pills shrink to .97.
public enum MaskinPressKind: Sendable, CaseIterable {
	/// Rows, links, toolbar icons: opacity .55.
	case dim
	/// Cards, pills: scale .97.
	case shrink

	public static let dimOpacity: Double = 0.55
	public static let shrinkScale: CGFloat = 0.97

	/// Opacity and scale for a state. Under Reduce Motion nothing moves, so `.shrink` falls back
	/// to the dim feedback instead of a scale.
	public func appearance(isPressed: Bool, reduceMotion: Bool) -> (opacity: Double, scale: CGFloat) {
		guard isPressed else { return (1, 1) }
		switch self {
		case .dim: return (Self.dimOpacity, 1)
		case .shrink: return reduceMotion ? (Self.dimOpacity, 1) : (1, Self.shrinkScale)
		}
	}
}

/// One pressed state for every tappable: `.buttonStyle(.maskinPressed)` for rows, links and
/// icons, `.buttonStyle(.maskinPressed(.shrink))` for cards and pills. Keeps the full label
/// tappable and honours Reduce Motion (no animation, no scale).
public struct MaskinPressedButtonStyle: ButtonStyle {
	@Environment(\.accessibilityReduceMotion) private var reduceMotion
	private let kind: MaskinPressKind

	public init(_ kind: MaskinPressKind = .dim) { self.kind = kind }

	public func makeBody(configuration: Configuration) -> some View {
		let look = kind.appearance(isPressed: configuration.isPressed, reduceMotion: reduceMotion)
		configuration.label
			.opacity(look.opacity)
			.scaleEffect(look.scale)
			.animation(reduceMotion ? nil : MaskinMotion.quick, value: configuration.isPressed)
			.contentShape(Rectangle())
	}
}

extension ButtonStyle where Self == MaskinPressedButtonStyle {
	/// Dim-on-press for rows, links and icons.
	public static var maskinPressed: MaskinPressedButtonStyle { .init(.dim) }

	public static func maskinPressed(_ kind: MaskinPressKind) -> MaskinPressedButtonStyle {
		.init(kind)
	}
}
