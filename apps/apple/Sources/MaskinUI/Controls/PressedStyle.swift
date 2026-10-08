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
		PressedLabel(kind: kind) { configuration.label }
			.opacity(look.opacity)
			.scaleEffect(look.scale)
			.animation(reduceMotion ? nil : MaskinMotion.quick, value: configuration.isPressed)
			.contentShape(Rectangle())
	}
}

/// The label of a `.maskinPressed` button plus its pointer and keyboard states: a quiet fill (rows)
/// or lift (cards, pills) under a pointer, and a 2pt `sig` ring at a 2pt offset when the button has
/// keyboard focus. Lives in a view of its own because `isFocused` is read from the environment.
private struct PressedLabel<Label: View>: View {
	let kind: MaskinPressKind
	@ViewBuilder let label: Label
	@Environment(\.isFocused) private var isFocused

	var body: some View {
		label
			.maskinHover(kind == .dim ? .fill : .lift)
			.overlay {
				if isFocused {
					RoundedRectangle(cornerRadius: MaskinRadius.btn, style: .continuous)
						.strokeBorder(MaskinColor.sig, lineWidth: MaskinFocusRing.width)
						.padding(-(MaskinFocusRing.width + MaskinFocusRing.offset))
						.allowsHitTesting(false)
				}
			}
	}
}

/// The focus ring of the v4 handoff: 2pt, `sig`, 2pt out from the control.
public enum MaskinFocusRing {
	public static let width: CGFloat = 2
	public static let offset: CGFloat = 2
}

extension ButtonStyle where Self == MaskinPressedButtonStyle {
	/// Dim-on-press for rows, links and icons.
	public static var maskinPressed: MaskinPressedButtonStyle { .init(.dim) }

	public static func maskinPressed(_ kind: MaskinPressKind) -> MaskinPressedButtonStyle {
		.init(kind)
	}
}
