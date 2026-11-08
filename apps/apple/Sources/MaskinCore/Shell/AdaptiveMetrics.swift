import CoreGraphics

/// Size-class driven metrics for the live meeting and the app window. Pure so they are testable;
/// callers pass `horizontalSizeClass == .regular`, never a device idiom.
public enum LiveMeetingMetrics {
	/// Diameter of a call control: 64 pt in regular width (iPad, wide windows), 58 pt in compact.
	public static func controlSize(regularWidth: Bool) -> CGFloat { regularWidth ? 64 : 58 }
	/// Regular width keeps the controls as a compact cluster at bottom centre instead of
	/// stretching them across the whole screen.
	public static func controlsMaxWidth(regularWidth: Bool) -> CGFloat? { regularWidth ? 520 : nil }
	/// The caption under the call card runs wider than the controls, up to 620 pt in regular width.
	public static func captionsMaxWidth(regularWidth: Bool) -> CGFloat? { regularWidth ? 620 : nil }
}

public enum ReadingColumn {
	/// Item detail and thread messages stay in a 720 pt column in regular width and are centred.
	public static let maxWidth: CGFloat = 720
}

public enum WindowMetrics {
	/// Smallest window Stage Manager / Split View may shrink the app to.
	public static let minimumWidth: CGFloat = 320
	public static let minimumHeight: CGFloat = 480
}
