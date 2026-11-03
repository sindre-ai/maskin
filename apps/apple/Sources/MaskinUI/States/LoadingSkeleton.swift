import MaskinDesign
import SwiftUI

/// A shimmering placeholder block. Respects Reduce Motion (static when enabled).
public struct SkeletonBlock: View {
	@Environment(\.accessibilityReduceMotion) private var reduceMotion
	@State private var phase: CGFloat = -1

	private let height: CGFloat
	private let cornerRadius: CGFloat

	public init(height: CGFloat = MaskinSpace.s9, cornerRadius: CGFloat = MaskinRadius.input) {
		self.height = height
		self.cornerRadius = cornerRadius
	}

	public var body: some View {
		RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
			.fill(MaskinSurface.fill)
			.frame(height: height)
			.overlay {
				if !reduceMotion {
					GeometryReader { proxy in
						LinearGradient(
							colors: [.clear, MaskinSurface.fillStrong, .clear], startPoint: .leading, endPoint: .trailing
						)
						.frame(width: proxy.size.width * 0.6)
						.offset(x: phase * proxy.size.width)
					}
					.clipShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
				}
			}
			.onAppear {
				guard !reduceMotion else { return }
				withAnimation(.linear(duration: MaskinDuration.slide * 5).repeatForever(autoreverses: false)) {
					phase = 1.4
				}
			}
			.accessibilityHidden(true)
	}
}

/// Card-shaped loading placeholder; `rows` stacked skeleton cards.
public struct LoadingSkeleton: View {
	private let rows: Int

	public init(rows: Int = 3) { self.rows = rows }

	public var body: some View {
		VStack(spacing: MaskinSpace.s7) {
			ForEach(0..<rows, id: \.self) { _ in
				VStack(alignment: .leading, spacing: MaskinSpace.s5) {
					SkeletonBlock(height: MaskinSpace.s9).frame(maxWidth: .infinity)
					SkeletonBlock(height: MaskinSpace.s8).containerRelativeFrame(.horizontal) { w, _ in w * 0.6 }
					SkeletonBlock(height: MaskinSpace.s8).containerRelativeFrame(.horizontal) { w, _ in w * 0.35 }
				}
				.padding(MaskinSpace.s9)
				.frame(maxWidth: .infinity, alignment: .leading)
				.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.hero, style: .continuous))
			}
		}
		.accessibilityElement(children: .ignore)
		.accessibilityLabel("Loading")
	}
}

extension View {
	/// System redaction styled with the shimmer-free placeholder look, for real content
	/// whose data hasn't arrived yet.
	public func maskinRedacted(_ isLoading: Bool) -> some View {
		redacted(reason: isLoading ? .placeholder : [])
	}
}

#Preview("Skeleton — light") {
	LoadingSkeleton().padding().background(MaskinSurface.grouped).preferredColorScheme(.light)
}
#Preview("Skeleton — dark") {
	LoadingSkeleton().padding().background(MaskinSurface.grouped).preferredColorScheme(.dark)
}
