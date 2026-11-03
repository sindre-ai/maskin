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
	/// Things that move because a finger moved them (pager, chips): a touch of life, no wobble.
	public static let spring = Animation.spring(response: 0.38, dampingFraction: 0.82)
	/// Drawer / sheet-style slides.
	public static let slide = Animation.easeInOut(duration: MaskinDuration.slide)
}
