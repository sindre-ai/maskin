import MaskinDesign
import SwiftUI

/// How an agent is doing, shown on its avatar. The shape and colour say who it is; the mood says
/// what it is up to, so a list of agents reads as a room of people rather than a table.
public enum AgentMood: Sendable, Equatable {
	/// Standing by. No decoration.
	case idle
	/// Running: a breathing ring and a gentle bob.
	case working
	/// Waiting on a person: a soft Patina nudge.
	case waiting
	/// Last run failed: a small warning mark.
	case failed
	/// Paused on purpose: dimmed.
	case paused
}

/// The mood's corner mark, if it has one.
struct AgentMoodBadge: View {
	let mood: AgentMood
	let size: CGFloat
	@Environment(\.accessibilityReduceMotion) private var reduceMotion
	@State private var pulsing = false

	var body: some View {
		switch mood {
		case .waiting:
			dot(MaskinColor.sig)
				.scaleEffect(pulsing ? 1.18 : 1)
				.onAppear {
					guard !reduceMotion else { return }
					withAnimation(.easeInOut(duration: 1.1).repeatForever(autoreverses: true)) { pulsing = true }
				}
		case .failed:
			dot(MaskinColor.warning)
		case .idle, .working, .paused:
			EmptyView()
		}
	}

	private func dot(_ color: Color) -> some View {
		Circle()
			.fill(color)
			.frame(width: size, height: size)
			.overlay(Circle().strokeBorder(MaskinSurface.card, lineWidth: max(1, size * 0.18)))
			.accessibilityHidden(true)
	}
}
