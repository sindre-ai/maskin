import MaskinDesign
import SwiftUI

/// The composer bar's shape for plain text hosts that cannot depend on `ChatComposerModel`
/// (object comments today): one glass bar, radius 26, with the attach circle inside on the left,
/// the field, and one trailing control that is the mic while there is nothing to send and the send
/// arrow once there is. Callers supply the controls; this owns layout. Same geometry as
/// `MaskinComposer` (spec 7 §1), so the two read as one component until every host has switched.
public enum ComposerMetrics {
	/// 40pt circles inside 44pt hit frames.
	public static let control: CGFloat = MaskinSpace.touchMin - MaskinSpace.s2
}

public struct ComposerSurface<Leading: View, Field: View, Mic: View>: View {
	public static var control: CGFloat { ComposerMetrics.control }

	private let leading: Leading
	private let field: Field
	private let mic: Mic
	private let canSend: Bool
	private let showsMic: Bool
	private let onSend: () -> Void
	private let shape = RoundedRectangle(cornerRadius: MaskinRadius.composer, style: .continuous)

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
		HStack(alignment: .bottom, spacing: MaskinSpace.s2) {
			leading
			field
				.font(MaskinTypeface.sans(MaskinFontSize.t16, relativeTo: .body))
				.foregroundStyle(MaskinColor.ink)
				.padding(.vertical, MaskinSpace.s4)
				.frame(minHeight: Self.control)
				.padding(.vertical, MaskinSpace.s1)
				.padding(.leading, MaskinSpace.s2)
				.frame(maxWidth: .infinity)
			trailing
		}
		.padding(MaskinSpace.s2)
		.background {
			shape.fill(.clear)
				.maskinGlass(in: shape)
				.overlay(shape.strokeBorder(MaskinSurface.glassBorder, lineWidth: 0.5))
				.shadow(color: MaskinColor.overlayDim.opacity(0.35), radius: MaskinSpace.s10, y: MaskinSpace.s7)
		}
		.animation(MaskinMotion.quick, value: showsMic)
	}

	@ViewBuilder private var trailing: some View {
		if showsMic {
			mic.transition(.opacity)
		} else {
			sendButton.transition(.opacity)
		}
	}

	private var sendButton: some View {
		Button {
			MaskinHaptics.play(.light)
			onSend()
		} label: {
			Image(systemName: "arrow.up")
				.maskinSymbol(MaskinFontSize.t17, weight: .heavy)
				.foregroundStyle(MaskinSurface.onInverse)
				.frame(width: Self.control, height: Self.control)
				.background(MaskinSurface.inverse, in: Circle())
				.frame(width: MaskinSpace.touchMin, height: MaskinSpace.touchMin)
				.contentShape(Circle())
				.opacity(canSend ? 1 : 0.35)
		}
		.buttonStyle(.maskinPressed)
		.disabled(!canSend)
		#if !os(watchOS) && !os(tvOS)
		.keyboardShortcut(.return, modifiers: .command)
		#endif
		.accessibilityLabel("Send")
	}
}

/// A quiet 40pt circle (`fill` / `fg3`) in a 44pt hit frame: the attach control's face.
public struct ComposerCircleLabel: View {
	private let symbol: String
	public init(_ symbol: String) { self.symbol = symbol }
	public var body: some View {
		Image(systemName: symbol)
			.maskinSymbol(MaskinFontSize.t17, weight: .semibold)
			.foregroundStyle(MaskinColor.ink3)
			.frame(width: ComposerMetrics.control, height: ComposerMetrics.control)
			.background(MaskinSurface.fill, in: Circle())
			.frame(width: MaskinSpace.touchMin, height: MaskinSpace.touchMin)
			.contentShape(Circle())
	}
}

/// The mic as the composer draws it: a quiet circle while idle, a pulsing red disc while listening.
public struct ComposerMicLabel: View {
	private let listening: Bool
	public init(listening: Bool) { self.listening = listening }
	public var body: some View {
		Image(systemName: listening ? "waveform" : "mic")
			.maskinSymbol(MaskinFontSize.t17, weight: listening ? .semibold : .regular)
			.symbolEffect(.pulse, isActive: listening)
			.foregroundStyle(listening ? MaskinSurface.onInverse : MaskinColor.ink3)
			.frame(width: ComposerMetrics.control, height: ComposerMetrics.control)
			.background(listening ? MaskinColor.dangerMic : MaskinSurface.fill, in: Circle())
			.frame(width: MaskinSpace.touchMin, height: MaskinSpace.touchMin)
			.contentShape(Circle())
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

	private var hasContent: Bool { !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

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
			canSend: canSend, showsMic: (!hasContent || listening) && Mic.self != EmptyView.self, onSend: onSend,
			leading: {
				Button(action: onAttach) { ComposerCircleLabel("plus") }
					.buttonStyle(.maskinPressed)
					.accessibilityLabel("Attach")
			},
			field: {
				TextField(text: $text, prompt: Text(placeholder).foregroundStyle(MaskinColor.ink5), axis: .vertical) {
					Text("Message")
				}
				.textFieldStyle(.plain)
				.lineLimit(1...6)
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
