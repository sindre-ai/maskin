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

/// The v4 weight scale (400, 500, 600, 650, 700, 750) on the weights the platform has.
/// 650 rounds down to semibold and 750 to bold; titles get their extra punch from tracking.
public enum MaskinFontWeight {
	public static let regular = Font.Weight.regular  // 400
	public static let medium = Font.Weight.medium  // 500
	public static let semibold = Font.Weight.semibold  // 600
	public static let w650 = Font.Weight.semibold  // 650
	public static let bold = Font.Weight.bold  // 700
	public static let w750 = Font.Weight.bold  // 750

	/// The CSS weight each native weight stands in for, for tests and docs.
	public static func css(_ weight: Font.Weight) -> Int {
		switch weight {
		case .medium: 500
		case .semibold: 600
		case .bold: 700
		default: 400
		}
	}
}

/// A named type role: font + tracking + case. Apply with `.maskinText(.largeTitle)`.
public enum MaskinTextRole: CaseIterable, Sendable {
	/// Root screen title, 34 / 750, -.026em, line-height 1.06.
	case largeTitle
	/// Sheet, thread and flow-name title, 24 / 750, -.022em.
	case sheetTitle
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
	/// Uppercase mono micro-label (10 / semibold, +0.08em).
	case microLabel
	/// The larger uppercase mono micro-label (12 / semibold, +0.07em). Only for a label that stands
	/// alone in a header (the story player's unit, a thread's context link); chips, row type labels and
	/// section labels use `.microLabel`. 9pt exists only inside briefing cards.
	case microLabelLarge
	/// The smallest uppercase mono micro-label (9 / semibold, +0.08em), inside briefing cards.
	case microLabelMicro
	/// Machine-shaped text: ids, counts, cron.
	case mono

	public var font: Font {
		switch self {
		case .largeTitle: MaskinTypeface.sans(MaskinFontSize.t34, weight: MaskinFontWeight.w750, relativeTo: .largeTitle)
		case .sheetTitle: MaskinTypeface.sans(MaskinFontSize.t24, weight: MaskinFontWeight.w750, relativeTo: .title)
		case .title: MaskinTypeface.sans(MaskinFontSize.t22, weight: .bold, relativeTo: .title2)
		case .headline: MaskinTypeface.sans(MaskinFontSize.t17, weight: .semibold, relativeTo: .headline)
		case .body: MaskinTypeface.sans(MaskinFontSize.t16, relativeTo: .body)
		case .subhead: MaskinTypeface.sans(MaskinFontSize.t14, relativeTo: .subheadline)
		case .caption: MaskinTypeface.sans(MaskinFontSize.t12, weight: .medium, relativeTo: .caption)
		case .microLabel: MaskinTypeface.mono(MaskinFontSize.t10, weight: .semibold, relativeTo: .caption2)
		case .microLabelLarge: MaskinTypeface.mono(MaskinFontSize.t12, weight: .semibold, relativeTo: .caption)
		case .microLabelMicro: MaskinTypeface.mono(MaskinFontSize.t9, weight: .semibold, relativeTo: .caption2)
		case .mono: MaskinTypeface.mono(MaskinFontSize.t13, relativeTo: .footnote)
		}
	}

	/// Tracking in em; applied against the role's point size.
	public var trackingEm: CGFloat {
		switch self {
		case .largeTitle: -0.026
		case .sheetTitle: -0.022
		case .title: -0.015
		case .headline: -0.008
		case .microLabel: 0.08
		case .microLabelLarge: 0.07
		case .microLabelMicro: 0.08
		default: 0
		}
	}

	/// Point size used to convert `trackingEm` to points.
	var referenceSize: CGFloat {
		switch self {
		case .largeTitle: MaskinFontSize.t34
		case .sheetTitle: MaskinFontSize.t24
		case .title: MaskinFontSize.t22
		case .headline: MaskinFontSize.t17
		case .body: MaskinFontSize.t16
		case .subhead: MaskinFontSize.t14
		case .caption: MaskinFontSize.t12
		case .microLabel: MaskinFontSize.t10
		case .microLabelLarge: MaskinFontSize.t12
		case .microLabelMicro: MaskinFontSize.t9
		case .mono: MaskinFontSize.t13
		}
	}

	/// CSS line-height multiple for roles v4 pins (nil: system default). Exposed as data; screens
	/// opt in via `lineSpacing` when they adopt the role.
	public var lineHeightEm: CGFloat? {
		switch self {
		case .largeTitle: 1.06
		default: nil
		}
	}

	/// The largest Dynamic Type size the role follows. Mono labels stop at `.xxxLarge`; everything
	/// else scales all the way through the accessibility sizes.
	public var dynamicTypeCeiling: DynamicTypeSize {
		switch self {
		case .microLabel, .microLabelLarge, .microLabelMicro: MaskinScaling.monoLabelCeiling
		default: .accessibility5
		}
	}

	public var isUppercase: Bool { self == .microLabel || self == .microLabelLarge || self == .microLabelMicro }
}

extension View {
	/// Applies a type role's font and tracking. Uppercasing for `.microLabel` is done by
	/// `MonoLabel` (it is a string transform, not a style).
	public func maskinText(_ role: MaskinTextRole) -> some View {
		font(role.font).tracking(role.trackingEm * role.referenceSize)
			.dynamicTypeSize(...role.dynamicTypeCeiling)
	}
}
