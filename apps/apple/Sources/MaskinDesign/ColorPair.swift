import SwiftUI

/// A background/foreground colour pair, e.g. a badge's tint and its text.
public struct MaskinColorPair: Sendable {
	public let bg: Color
	public let fg: Color

	public init(bg: Color, fg: Color) {
		self.bg = bg
		self.fg = fg
	}
}
