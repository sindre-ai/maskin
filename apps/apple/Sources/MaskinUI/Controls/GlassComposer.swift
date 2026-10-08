import MaskinDesign
import SwiftUI

/// The composer's shape, shared by every thread, in the iOS Messages idiom: attach as a glass circle,
/// then a glass capsule holding the field with one trailing control that is the mic while there is
/// nothing to send and the send arrow once there is. Callers supply the controls; this owns layout.
public struct ComposerSurface<Leading: View, Field: View, Mic: View>: View {
	public static var control: CGFloat { MaskinSpace.touchMin - MaskinSpace.s2 }

	private let leading: Leading
	private let field: Field
	private let mic: Mic
	private let canSend: Bool
	private let showsMic: Bool
	private let onSend: () -> Void

	/// `showsMic` is true while the mic should keep the trailing slot (nothing to send, or listening).
	public init(
		canSend: Bool, showsMic: Bool, onSend: @escaping () -> Void,
		@ViewBuilder leading: () -> Leading, @ViewBuilder field: () -> Field, @ViewBuilder mic: () -> Mic
	) {
		self.canSend = canSend
		self.showsMic = showsMic
		self.onSend = onSend
		self.leading = leading()
		self.field = field()
		self.mic = mic()
	}

	public var body: some View {
		HStack(alignment: .bottom, spacing: MaskinSpace.s3) {
			leading.maskinGlass(in: Circle())
			HStack(alignment: .bottom, spacing: MaskinSpace.s2) {
				field
					.maskinText(.body)
					.foregroundStyle(MaskinColor.ink)
					.frame(minHeight: Self.control)
					.padding(.leading, MaskinSpace.s5)
				trailing
			}
			.padding(MaskinSpace.s2)
			.maskinGlass(in: RoundedRectangle(cornerRadius: Self.control, style: .continuous))
		}
		.animation(MaskinMotion.quick, value: showsMic)
	}

	@ViewBuilder private var trailing: some View {
		if showsMic {
			mic
		} else {
			sendButton.transition(.scale.combined(with: .opacity))
		}
	}

	private var sendButton: some View {
		Button {
			MaskinHaptics.play(.light)
			onSend()
		} label: {
			Image(systemName: "arrow.up")
				.font(.system(size: MaskinFontSize.t15, weight: .bold))
				.foregroundStyle(MaskinSurface.onInverse)
				.frame(width: Self.control, height: Self.control)
				.background(MaskinSurface.inverse, in: Circle())
				.opacity(canSend ? 1 : 0.35)
		}
		.buttonStyle(.maskinPressed(.shrink))
		.disabled(!canSend)
		#if !os(watchOS) && !os(tvOS)
		.keyboardShortcut(.return, modifiers: .command)
		#endif
		.accessibilityLabel("Send")
	}
}

/// The attach control's face; the surface draws the glass behind it.
public struct ComposerCircleLabel: View {
	private let symbol: String
	public init(_ symbol: String) { self.symbol = symbol }
	public var body: some View {
		Image(systemName: symbol)
			.font(.system(size: MaskinFontSize.t15, weight: .semibold))
			.foregroundStyle(MaskinColor.ink3)
			.frame(width: MaskinSpace.touchMin - MaskinSpace.s2, height: MaskinSpace.touchMin - MaskinSpace.s2)
	}
}

/// The mic as the composer draws it: quiet while idle, a pulsing red disc while listening.
public struct ComposerMicLabel: View {
	private let listening: Bool
	public init(listening: Bool) { self.listening = listening }
	public var body: some View {
		Image(systemName: listening ? "waveform" : "mic")
			.font(.system(size: MaskinFontSize.t15, weight: .semibold))
			.symbolEffect(.pulse, isActive: listening)
			.foregroundStyle(listening ? Color.white : MaskinColor.ink3)
			.frame(width: MaskinSpace.touchMin - MaskinSpace.s2, height: MaskinSpace.touchMin - MaskinSpace.s2)
			.background(listening ? MaskinColor.dangerMic : Color.clear, in: Circle())
	}
}

/// Floating input bar for a plain text thread (object comments): attach, field, dictation, send.
/// Stateless about networking and speech — callers own the text binding and the dictation control.
public struct GlassComposer<Mic: View>: View {
	@Binding private var text: String
	private let placeholder: String
	private let canSendOverride: Bool?
	private let onAttach: () -> Void
	private let onSend: () -> Void
	private let mic: Mic
	@Binding private var listening: Bool

	private var canSend: Bool {
		canSendOverride ?? !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
	}

	public init(
		text: Binding<String>, placeholder: String = "Message", canSend: Bool? = nil,
		onAttach: @escaping () -> Void = {}, onSend: @escaping () -> Void,
		listening: Binding<Bool> = .constant(false), @ViewBuilder mic: () -> Mic
	) {
		_text = text
		_listening = listening
		self.placeholder = placeholder
		canSendOverride = canSend
		self.onAttach = onAttach
		self.onSend = onSend
		self.mic = mic()
	}

	public var body: some View {
		ComposerSurface(
			canSend: canSend, showsMic: !canSend || listening, onSend: onSend,
			leading: {
				Button(action: onAttach) { ComposerCircleLabel("plus") }
					.buttonStyle(.maskinPressed)
					.accessibilityLabel("Attach")
			},
			field: {
				TextField(placeholder, text: $text, axis: .vertical)
					.lineLimit(1...5)
					.accessibilityLabel(placeholder)
			},
			mic: { mic })
	}
}

extension GlassComposer where Mic == EmptyView {
	public init(
		text: Binding<String>, placeholder: String = "Message", canSend: Bool? = nil,
		onAttach: @escaping () -> Void = {}, onSend: @escaping () -> Void
	) {
		self.init(
			text: text, placeholder: placeholder, canSend: canSend, onAttach: onAttach, onSend: onSend,
			mic: { EmptyView() })
	}
}

#Preview("Composer — light") { ComposerGallery().preferredColorScheme(.light) }
#Preview("Composer — dark") { ComposerGallery().preferredColorScheme(.dark) }

private struct ComposerGallery: View {
	@State private var text = ""
	var body: some View {
		VStack {
			Spacer()
			GlassComposer(text: $text) {}
		}
		.padding(MaskinSpace.s7)
		.background(MaskinSurface.grouped)
	}
}
