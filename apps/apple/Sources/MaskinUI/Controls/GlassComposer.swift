import MaskinDesign
import SwiftUI

/// Floating input bar: attach (+), text field, dictation toggle, send. Stateless about
/// networking and speech — callers own the text binding and react to the closures.
public struct GlassComposer: View {
	@Binding private var text: String
	@Binding private var isDictating: Bool
	private let placeholder: String
	private let canSendOverride: Bool?
	private var canSend: Bool {
		canSendOverride ?? !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
	}
	private let onAttach: () -> Void
	private let onSend: () -> Void

	public init(
		text: Binding<String>, isDictating: Binding<Bool> = .constant(false),
		placeholder: String = "Message", canSend: Bool? = nil,
		onAttach: @escaping () -> Void = {}, onSend: @escaping () -> Void
	) {
		_text = text
		_isDictating = isDictating
		self.placeholder = placeholder
		canSendOverride = canSend
		self.onAttach = onAttach
		self.onSend = onSend
	}

	public var body: some View {
		HStack(alignment: .bottom, spacing: MaskinSpace.s4) {
			circleButton("plus", label: "Attach", action: onAttach)
			TextField(placeholder, text: $text, axis: .vertical)
				.lineLimit(1...5)
				.maskinText(.body)
				.foregroundStyle(MaskinColor.ink)
				.frame(minHeight: MaskinSpace.touchMin - MaskinSpace.s2)
			Button {
				isDictating.toggle()
				MaskinHaptics.play(.selection)
			} label: {
				Image(systemName: isDictating ? "waveform" : "mic")
					.symbolEffect(.pulse, isActive: isDictating)
					.frame(width: MaskinSpace.touchMin - MaskinSpace.s2, height: MaskinSpace.touchMin - MaskinSpace.s2)
					.foregroundStyle(isDictating ? MaskinColor.dangerMic : MaskinColor.ink3)
			}
			.buttonStyle(.plain)
			.accessibilityLabel(isDictating ? "Stop dictation" : "Start dictation")
			Button {
				MaskinHaptics.play(.light)
				onSend()
			} label: {
				Image(systemName: "arrow.up")
					.font(.system(size: MaskinFontSize.t15, weight: .bold))
					.foregroundStyle(MaskinSurface.onInverse)
					.frame(width: MaskinSpace.touchMin - MaskinSpace.s2, height: MaskinSpace.touchMin - MaskinSpace.s2)
					.background(MaskinSurface.inverse, in: Circle())
					.opacity(canSend ? 1 : 0.35)
			}
			.buttonStyle(.plain)
			.disabled(!canSend)
			.accessibilityLabel("Send")
		}
		.padding(.horizontal, MaskinSpace.s3)
		.padding(.vertical, MaskinSpace.s3)
		.maskinGlass(in: RoundedRectangle(cornerRadius: MaskinRadius.hero + MaskinSpace.s4, style: .continuous))
	}

	private func circleButton(_ symbol: String, label: String, action: @escaping () -> Void) -> some View {
		Button(action: action) {
			Image(systemName: symbol)
				.font(.system(size: MaskinFontSize.t15, weight: .semibold))
				.foregroundStyle(MaskinColor.ink3)
				.frame(width: MaskinSpace.touchMin - MaskinSpace.s2, height: MaskinSpace.touchMin - MaskinSpace.s2)
				.background(MaskinSurface.fill, in: Circle())
		}
		.buttonStyle(.plain)
		.accessibilityLabel(label)
	}
}

#Preview("Composer — light") { ComposerGallery().preferredColorScheme(.light) }
#Preview("Composer — dark") { ComposerGallery().preferredColorScheme(.dark) }

private struct ComposerGallery: View {
	@State private var text = ""
	@State private var dictating = false
	var body: some View {
		VStack {
			Spacer()
			GlassComposer(text: $text, isDictating: $dictating) {}
		}
		.padding(MaskinSpace.s7)
		.background(MaskinSurface.grouped)
	}
}
