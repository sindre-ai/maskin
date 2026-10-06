import CoreText
import SwiftUI

/// Type families for the native clients. Families are referenced by name: the app target
/// bundles Schibsted Grotesk and JetBrains Mono and registers them. When a family is NOT
/// registered (previews, tests, hosts without the bundle) we use the system font instead of
/// `Font.custom`, because `Font.custom` silently ignores `.weight()` / `.bold()` for a
/// missing family — bold markdown and semibold labels would all render regular. The
/// system fallback is fixed-size; the registered-font path scales with Dynamic Type.
public enum MaskinTypeface {
	public static let sansFamily = "Schibsted Grotesk"
	public static let monoFamily = "JetBrains Mono"

	/// True when the family is installed or registered in this process.
	public static func isAvailable(_ family: String) -> Bool {
		let font = CTFontCreateWithName(family as CFString, 12, nil)
		return (CTFontCopyFamilyName(font) as String) == family
	}

	public static func sans(
		_ size: CGFloat, weight: Font.Weight = .regular, relativeTo style: Font.TextStyle = .body
	) -> Font {
		guard isAvailable(sansFamily) else { return .system(size: size, weight: weight) }
		return .custom(sansFamily, size: size, relativeTo: style).weight(weight)
	}

	public static func mono(
		_ size: CGFloat, weight: Font.Weight = .regular, relativeTo style: Font.TextStyle = .caption
	) -> Font {
		guard isAvailable(monoFamily) else { return .system(size: size, weight: weight, design: .monospaced) }
		return .custom(monoFamily, size: size, relativeTo: style).weight(weight)
	}
}

/// A named type role: font + tracking + case. Apply with `.maskinText(.largeTitle)`.
public enum MaskinTextRole: CaseIterable, Sendable {
	/// Screen title, 34 / bold, tight tracking.
	case largeTitle
	/// Card or sheet headline.
	case title
	/// Feed card headline / row title.
	case headline
	/// Running text.
	case body
	/// Secondary running text and meta.
	case subhead
	/// Small supporting text.
	case caption
	/// Uppercase mono micro-label (11 / semibold, +0.06em).
	case microLabel
	/// Machine-shaped text: ids, counts, cron.
	case mono

	// Role sizes beyond the token scale (iOS large title) live here, not in call sites.
	private static let largeTitleSize: CGFloat = 34

	public var font: Font {
		switch self {
		case .largeTitle: MaskinTypeface.sans(Self.largeTitleSize, weight: .bold, relativeTo: .largeTitle)
		case .title: MaskinTypeface.sans(MaskinFontSize.t22, weight: .bold, relativeTo: .title2)
		case .headline: MaskinTypeface.sans(MaskinFontSize.t17, weight: .semibold, relativeTo: .headline)
		case .body: MaskinTypeface.sans(MaskinFontSize.t16, relativeTo: .body)
		case .subhead: MaskinTypeface.sans(MaskinFontSize.t14, relativeTo: .subheadline)
		case .caption: MaskinTypeface.sans(MaskinFontSize.t12, weight: .medium, relativeTo: .caption)
		case .microLabel: MaskinTypeface.mono(MaskinFontSize.t11, weight: .semibold, relativeTo: .caption2)
		case .mono: MaskinTypeface.mono(MaskinFontSize.t13, relativeTo: .footnote)
		}
	}

	/// Tracking in em; applied against the role's point size.
	public var trackingEm: CGFloat {
		switch self {
		case .largeTitle: -0.02
		case .title: -0.015
		case .headline: -0.008
		case .microLabel: 0.06
		default: 0
		}
	}

	/// Point size used to convert `trackingEm` to points.
	var referenceSize: CGFloat {
		switch self {
		case .largeTitle: Self.largeTitleSize
		case .title: MaskinFontSize.t22
		case .headline: MaskinFontSize.t17
		case .body: MaskinFontSize.t16
		case .subhead: MaskinFontSize.t14
		case .caption: MaskinFontSize.t12
		case .microLabel: MaskinFontSize.t11
		case .mono: MaskinFontSize.t13
		}
	}

	public var isUppercase: Bool { self == .microLabel }
}

extension View {
	/// Applies a type role's font and tracking. Uppercasing for `.microLabel` is done by
	/// `MonoLabel` (it is a string transform, not a style).
	public func maskinText(_ role: MaskinTextRole) -> some View {
		font(role.font).tracking(role.trackingEm * role.referenceSize)
	}
}
