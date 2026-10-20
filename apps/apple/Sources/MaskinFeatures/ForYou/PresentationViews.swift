import MaskinCore
import MaskinDesign
import SwiftUI

/// One presentation card drawn natively: text, a big figure over text, bars, or the closing card.
struct PresentationSlideView: View {
	let slide: PresentationSlide
	/// Strip thumbnails use small type; the player uses large.
	var compact = false

	var body: some View {
		VStack(alignment: .leading, spacing: compact ? MaskinSpace.s3 : MaskinSpace.s7) {
			switch slide.kind {
			case .text:
				text
			case .stat(let big):
				Text(big)
					.font(MaskinTypeface.sans(compact ? MaskinFontSize.t28 : 88, weight: .bold))
					.tracking(compact ? -0.5 : -3)
					.minimumScaleFactor(0.5).lineLimit(1)
					.foregroundStyle(MaskinPatina.viewerAccent)
				text
			case .bars(let bars):
				ForEach(Array(bars.enumerated()), id: \.offset) { _, bar in
					VStack(alignment: .leading, spacing: MaskinSpace.s2) {
						Text(bar.label)
							.font(MaskinTypeface.sans(compact ? MaskinFontSize.t11 : MaskinFontSize.t15, weight: .semibold))
							.foregroundStyle(MaskinColor.patina100).lineLimit(1)
						Capsule().fill(Color.white.opacity(0.18))
							.frame(height: compact ? 4 : 10)
							.overlay(alignment: .leading) {
								GeometryReader { proxy in
									Capsule().fill(MaskinPatina.viewerAccent)
										.frame(width: proxy.size.width * min(max(bar.fraction, 0), 1))
								}
							}
					}
				}
			case .cta(let action):
				text
				if let action, !compact {
					Text(action)
						.font(MaskinTypeface.sans(MaskinFontSize.t15, weight: .bold))
						.foregroundStyle(MaskinSurface.onInverse)
						.padding(.horizontal, MaskinSpace.s11).frame(height: MaskinSpace.touchMin)
						.background(MaskinSurface.inverse, in: Capsule())
				}
			}
		}
		.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: compact ? .topLeading : .leading)
	}

	private var text: some View {
		Text(slide.text)
			.font(MaskinTypeface.sans(compact ? MaskinFontSize.t11 : MaskinFontSize.t20, weight: .semibold))
			.foregroundStyle(MaskinColor.stFg)
			.lineLimit(compact ? 4 : nil)
			.multilineTextAlignment(.leading)
	}
}

/// "Tell me more" answers with a presentation: its title, "4 cards · 0:40", Play, and the cards as
/// a horizontal strip. The cards come from the flow's linked HTML page.
struct PresentationBlock: View {
	let title: String
	let slides: [PresentationSlide]
	/// Cards on the page before the cap; shown as "8 of 18" when the deck was trimmed.
	var total: Int?
	let play: () -> Void

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s5) {
			HStack {
				VStack(alignment: .leading, spacing: MaskinSpace.s1) {
					Text("PRESENTATION \u{00B7} \(PresentationParser.summary(of: slides, total: total).uppercased())")
						.font(MaskinTypeface.mono(MaskinFontSize.t10, weight: .semibold))
						.maskinMonoLabelScale().tracking(0.7)
						.foregroundStyle(MaskinColor.patina100.opacity(0.7)).lineLimit(1)
					Text(title).font(MaskinTypeface.sans(MaskinFontSize.t15, weight: .bold))
						.foregroundStyle(Color.white).lineLimit(1)
				}
				Spacer(minLength: MaskinSpace.s3)
				Button(action: play) {
					Label("Play", systemImage: "play.fill")
						.font(MaskinTypeface.sans(MaskinFontSize.t14, weight: .bold))
						.foregroundStyle(MaskinSurface.onInverse)
						.padding(.horizontal, MaskinSpace.s9).frame(height: MaskinSpace.touchMin)
						.background(MaskinSurface.inverse, in: Capsule())
				}
				.buttonStyle(.maskinPressed(.shrink))
			}
			ScrollView(.horizontal, showsIndicators: false) {
				HStack(spacing: MaskinSpace.s4) {
					ForEach(slides) { slide in
						PresentationSlideView(slide: slide, compact: true)
							.padding(MaskinSpace.s6)
							.frame(width: 150, height: 100)
							.background(Color.white.opacity(0.1), in: RoundedRectangle(cornerRadius: MaskinRadius.tile, style: .continuous))
					}
				}
			}
			.scrollClipDisabled()
		}
		.padding(MaskinSpace.s7)
		.background(Color.white.opacity(0.08), in: RoundedRectangle(cornerRadius: MaskinRadius.hero, style: .continuous))
		.accessibilityElement(children: .contain)
	}
}

/// Plays a presentation full screen: progress bars, a card every ten seconds, tap right or left
/// to move, the close button to leave.
struct PresentationPlayer: View {
	let title: String
	let slides: [PresentationSlide]
	let close: () -> Void

	@State private var index = 0
	@Environment(\.accessibilityReduceMotion) private var reduceMotion

	var body: some View {
		ZStack {
			MaskinGradient.briefViewer.ignoresSafeArea()
			VStack(spacing: MaskinSpace.s9) {
				HStack(spacing: MaskinSpace.s2) {
					ForEach(slides.indices, id: \.self) { i in
						Capsule().fill(i <= index ? MaskinPatina.viewerAccent : Color.white.opacity(0.25))
							.frame(height: MaskinSpace.s2)
					}
				}
				.accessibilityHidden(true)
				HStack {
					Text(title).font(MaskinTypeface.sans(MaskinFontSize.t17, weight: .bold))
						.foregroundStyle(Color.white).lineLimit(1)
					Spacer()
					Button(action: close) {
						Image(systemName: "xmark").foregroundStyle(Color.white)
							.frame(width: MaskinSpace.touchMin, height: MaskinSpace.touchMin)
					}
					.accessibilityLabel("Close")
				}
				if slides.indices.contains(index) {
					PresentationSlideView(slide: slides[index])
						.id(index)
						.contentShape(Rectangle())
						.gesture(SpatialTapGesture().onEnded { value in
							if value.location.x < 160 { step(-1) } else { step(1) }
						})
				}
			}
			.padding(MaskinSpace.s9)
			.frame(maxWidth: BriefViewer.maxPlayerWidth)
		}
		.preferredColorScheme(.dark)
		.task(id: index) {
			guard !reduceMotion else { return }
			try? await Task.sleep(for: .seconds(PresentationParser.secondsPerCard))
			if !Task.isCancelled { step(1) }
		}
	}

	private func step(_ delta: Int) {
		let next = index + delta
		if next < 0 { return }
		if next >= slides.count { close() } else { index = next }
	}
}
