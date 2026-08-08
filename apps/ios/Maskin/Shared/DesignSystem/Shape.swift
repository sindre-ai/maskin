import CoreGraphics

/// Port of `tokens/shape.css` radii and border weights.
enum MaskinRadius {
	static let xs: CGFloat = 4 // inline code
	static let tag: CGFloat = 5 // mono object-type tags
	static let sm: CGFloat = 6 // small buttons, object chips
	static let md: CGFloat = 8 // buttons, icon tiles, toggles
	static let banner: CGFloat = 10 // inline banners, card badges
	static let lg: CGFloat = 12 // cards, tables
	static let xl: CGFloat = 14 // prompt bar, sheets
	static let chip: CGFloat = 20 // agent/actor chips, dark pills
	static let pill: CGFloat = 999 // fully round
}

enum MaskinBorder {
	static let width: CGFloat = 1.5 // brand's signature weight
	static let hairline: CGFloat = 1 // internal rules
}

/// Port of `tokens/spacing.css` static scale (rem -> pt at 16px base).
enum MaskinSpacing {
	static let s05: CGFloat = 4
	static let s1: CGFloat = 5.6
	static let s2: CGFloat = 8
	static let s3: CGFloat = 12
	static let s4: CGFloat = 16
	static let s5: CGFloat = 20
	static let s6: CGFloat = 24
	static let s7: CGFloat = 28
	static let s8: CGFloat = 36
	static let s9: CGFloat = 48
	static let cardPadding: CGFloat = 20
}
