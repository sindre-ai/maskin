import MaskinDesign
import SwiftUI

extension View {
	/// Pull to refresh with a character instead of the system spinner (iOS 18+; the system
	/// control elsewhere). Pulling grows a small shape that turns as you pull. Past the threshold, let
	/// go and it changes shape while the list reloads. `action` must finish when the data is current.
	public func characterRefreshable(_ action: @escaping @Sendable () async -> Void) -> some View {
		#if os(iOS)
			if #available(iOS 18, *) {
				return AnyView(modifier(CharacterRefresh(action: action)))
			}
		#endif
		return AnyView(refreshable(action: action))
	}
}

#if os(iOS)
	@available(iOS 18, *)
	private struct CharacterRefresh: ViewModifier {
		let action: @Sendable () async -> Void

		@Environment(\.accessibilityReduceMotion) private var reduceMotion
		@State private var pull: CGFloat = 0
		@State private var topInset: CGFloat = 0
		@State private var refreshing = false
		@State private var armed = false

		private let threshold: CGFloat = 72
		private let holdHeight: CGFloat = 56

		func body(content: Content) -> some View {
			content
				.contentMargins(.top, refreshing ? holdHeight : 0, for: .scrollContent)
				.onScrollGeometryChange(for: CGFloat.self) { geometry in
					max(0, -(geometry.contentOffset.y + geometry.contentInsets.top))
				} action: { _, new in
					pull = new
					if new >= threshold, !armed, !refreshing {
						armed = true
						MaskinHaptics.play(.light)
					} else if new < threshold * 0.6 {
						armed = false
					}
				}
				.onScrollGeometryChange(for: CGFloat.self) { $0.contentInsets.top } action: { _, new in
					topInset = new
				}
				.onScrollPhaseChange { old, new in
					guard old == .interacting, new != .interacting, armed, !refreshing else { return }
					start()
				}
				.overlay(alignment: .top) {
					RefreshCharacter(progress: min(pull / threshold, 1), refreshing: refreshing, still: reduceMotion)
						.offset(y: topInset + indicatorOffset)
						.opacity(refreshing || pull > 8 ? 1 : 0)
						.allowsHitTesting(false)
				}
				.accessibilityAction(named: "Refresh") { start() }
		}

		/// Rides just under the bar, following the pull, then parks in the space held for it.
		private var indicatorOffset: CGFloat {
			refreshing ? holdHeight / 2 - 16 : min(pull, threshold * 1.4) / 2 - 16
		}

		private func start() {
			guard !refreshing else { return }
			refreshing = true
			armed = false
			MaskinHaptics.play(.medium)
			Task {
				let began = ContinuousClock.now
				await action()
				// Long enough to be seen, so a fast reload doesn't flash.
				let elapsed = ContinuousClock.now - began
				if elapsed < .milliseconds(700) { try? await Task.sleep(for: .milliseconds(700) - elapsed) }
				MaskinHaptics.play(.success)
				withAnimation(MaskinMotion.spring) { refreshing = false }
			}
		}
	}

	/// A small shape that grows and turns as you pull, then cycles through shapes while loading.
	private struct RefreshCharacter: View {
		let progress: CGFloat
		let refreshing: Bool
		let still: Bool

		private let shapes = AgentShape.allCases

		var body: some View {
			TimelineView(.animation(minimumInterval: 1.0 / 30, paused: !refreshing || still)) { context in
				let t = context.date.timeIntervalSinceReferenceDate
				let index = refreshing ? Int(t / 0.45) % shapes.count : Int(progress * CGFloat(shapes.count - 1))
				let shape = shapes[index]
				shape
					.fill(MaskinColor.accent)
					.frame(width: 26, height: 26)
					.scaleEffect(refreshing ? 1 + 0.08 * CGFloat(sin(t * 6)) : 0.3 + 0.7 * progress)
					.rotationEffect(.degrees(refreshing ? t * 140 : Double(progress) * 220))
					.animation(MaskinMotion.spring, value: index)
					.accessibilityHidden(true)
			}
			.frame(height: 32)
		}
	}
#endif
