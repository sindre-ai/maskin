import SwiftUI

/// Aliases for radii that now live in the generated scale (`MaskinRadius.card2xl`, `.tile`).
/// Kept so existing callers compile; prefer `MaskinRadius`.
public enum MaskinRadiusLarge {
	/// List cards and pills.
	public static let card: CGFloat = MaskinRadius.card2xl
	/// Pinned tiles and composer-like surfaces.
	public static let tile: CGFloat = MaskinRadius.tile
}

extension MaskinTypeface {
	/// A chat thread's title: 24 / 750, same as a sheet title.
	public static var threadTitle: Font { MaskinTextRole.sheetTitle.font }
}
