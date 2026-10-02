import SwiftUI

/// Animation presets built from the motion tokens.
public enum MaskinMotion {
	/// Colour / border changes.
	public static let quick = Animation.easeInOut(duration: MaskinDuration.d150)
	/// Fades.
	public static let fade = Animation.easeOut(duration: MaskinDuration.d180)
	/// Shadow + transform, press states.
	public static let standard = Animation.easeInOut(duration: MaskinDuration.d200)
	/// Panel state changes.
	public static let panel = Animation.easeInOut(duration: MaskinDuration.d250)
	/// Drawer / sheet-style slides.
	public static let slide = Animation.easeInOut(duration: MaskinDuration.slide)
}
