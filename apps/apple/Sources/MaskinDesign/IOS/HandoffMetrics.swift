import SwiftUI

/// Radii the generated scale stops short of (its largest is 18). Hand-written beside the generated
/// tokens, never in them.
public enum MaskinRadiusLarge {
	/// List cards and pills.
	public static let card: CGFloat = 20
	/// Pinned tiles and composer-like surfaces.
	public static let tile: CGFloat = 22
}

extension MaskinTypeface {
	/// A chat thread's title: 25pt, weight 720 (bold is the nearest system weight).
	public static var threadTitle: Font { sans(25, weight: .bold, relativeTo: .title2) }
}
