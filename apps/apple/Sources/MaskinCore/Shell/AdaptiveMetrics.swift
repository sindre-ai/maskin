import CoreGraphics

/// Size-class driven metrics for the live meeting and the app window. Pure so they are testable;
/// callers pass `horizontalSizeClass == .regular`, never a device idiom.
public enum LiveMeetingMetrics {
	/// Diameter of a call control: 64 pt in regular width (iPad, wide windows), 58 pt in compact.
	public static func controlSize(regularWidth: Bool) -> CGFloat { regularWidth ? 64 : 58 }
	/// Regular width keeps the controls as a compact cluster at bottom centre instead of
	/// stretching them across the whole screen.
	public static func controlsMaxWidth(regularWidth: Bool) -> CGFloat? { regularWidth ? 520 : nil }
}

public enum WindowMetrics {
	/// Smallest window Stage Manager / Split View may shrink the app to.
	public static let minimumWidth: CGFloat = 320
	public static let minimumHeight: CGFloat = 480
}
