import SwiftUI

/// The v4 root-screen header: a dark teal gradient with a soft glow at the top right, and the
/// rounded sheet that overlaps its bottom edge. Hand-written beside the generated tokens. The
/// header is dark in both modes; only the sheet follows the colour scheme.
public enum MaskinScreenHeader {
	public static let inkTop = Color(light: RGBA(0x12302C), dark: RGBA(0x12302C))
	public static let inkBottom = Color(light: RGBA(0x17403B), dark: RGBA(0x17403B))
	public static let glow = Color(light: RGBA(0x7DBCB0), dark: RGBA(0x7DBCB0))
	/// The kicker and the summary's accent on the dark header.
	public static let kicker = Color(light: RGBA(0xACD6CD), dark: RGBA(0xACD6CD))
	/// Header buttons: a translucent white disc with a hairline ring.
	public static let buttonFill = Color.white.opacity(0.12)
	public static let buttonRing = Color.white.opacity(0.14)
	/// The sheet the content sits on.
	public static let sheet = Color(light: RGBA(0xF2F5F4), dark: RGBA(0x0F1614))

	/// The selected tab: dark teal on light, the light glow on dark.
	public static let tabTint = Color(light: RGBA(0x12302C), dark: RGBA(0x7DBCB0))

	/// How far the sheet rides up over the header.
	public static let overlap: CGFloat = 22
	public static let sheetRadius: CGFloat = MaskinRadius.brief
	public static let buttonSize: CGFloat = 40
	/// The dot on the Display button when a setting is changed.
	public static let dotSize: CGFloat = 8

	public static var gradient: some View {
		ZStack {
			LinearGradient(colors: [inkTop, inkBottom], startPoint: .top, endPoint: .bottom)
			RadialGradient(
				colors: [glow.opacity(0.38), glow.opacity(0)], center: .topTrailing, startRadius: 0,
				endRadius: 260)
		}
	}
}
