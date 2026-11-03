import SwiftUI

/// The brand tile colours. Unlike `MaskinSurface.inverse` these do NOT flip in dark mode: the
/// Maskin logo tile is always #18181b with a white mark (design handoff, icons/ICONS.md).
public enum MaskinBrand {
	public static let tile = Color(light: RGBA(0x18181B), dark: RGBA(0x18181B))
	public static let mark = Color(light: RGBA(0xFFFFFF), dark: RGBA(0xFFFFFF))
	/// The 1pt inset ring that keeps the black tile visible on dark wallpapers and dark surfaces.
	public static let ring = Color.white.opacity(0.12)
}
