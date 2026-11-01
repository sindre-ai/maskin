import SwiftUI

/// The colours of the call orb, apart from the drawing, so the Live Activity can paint the same orb
/// as a still gradient circle. Only colours and stops: no Canvas, no timeline, safe in a widget.
public struct CallOrbStyle: Sendable, Equatable {
	/// How lively the orb looks, which is all the colour depends on.
	public enum Tone: Sendable, Equatable {
		/// Someone is talking: you or the agent.
		case live
		/// Connecting or thinking.
		case calm
		/// Your microphone is off.
		case muted
	}

	public var tone: Tone

	public init(_ tone: Tone) { self.tone = tone }

	/// Light spot to base colour: a radial gradient centred on `highlight`, its end radius the orb's own.
	public var gradientColors: [Color] {
		switch tone {
		case .live: [MaskinColor.sigHi, MaskinColor.sig]
		case .calm: [MaskinColor.sigHi.opacity(0.85), MaskinColor.sig.opacity(0.85)]
		case .muted: [MaskinColor.ink4, MaskinColor.ink4]
		}
	}

	/// Where the light spot sits, as a fraction of the orb (0...1 each way).
	public static let highlight = UnitPoint(x: 0.38, y: 0.32)

	public var glow: Color { tone == .muted ? .clear : MaskinColor.sig }

	public var opacity: Double { tone == .muted ? 0.35 : 1 }
}
