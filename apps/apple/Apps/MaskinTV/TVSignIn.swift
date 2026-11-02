import CoreImage.CIFilterBuiltins
import MaskinCore
import MaskinDesign
import SwiftUI

/// Apple TV sign-in: a short code to approve on a phone or computer at maskin.io/tv, with the same
/// address as a QR code. Email and password stay one press away for a reviewer or a person without
/// a second device.
struct TVSignIn: View {
	let auth: AuthSession
	@State private var model: DeviceSignInModel
	@State private var usingPassword = false

	init(auth: AuthSession) {
		self.auth = auth
		let authorizer = APIDeviceAuthorizer(serverURL: GlanceConfig.apiBaseURL, clientSource: "tvos")
		_model = State(initialValue: DeviceSignInModel(authorizer: authorizer, auth: auth, deviceName: "Apple TV"))
	}

	var body: some View {
		ZStack {
			TVBackdrop()
			if usingPassword {
				VStack(spacing: 40) {
					GlanceLogin(auth: auth)
					Button("Use a code instead") { usingPassword = false; model.begin() }
				}
			} else {
				content
			}
		}
		.task { model.begin() }
		.onDisappear { model.stop() }
	}

	@ViewBuilder private var content: some View {
		switch model.phase {
		case .starting:
			ProgressView().scaleEffect(2)
		case .waiting(let code):
			HStack(alignment: .center, spacing: 120) {
				VStack(alignment: .leading, spacing: 28) {
					Text("Sign in on your phone or computer")
						.font(.system(size: 64, weight: .semibold))
						.foregroundStyle(MaskinColor.ink)
					Text("Go to \(code.displayAddress) and type this code. Approve it only if it matches.")
						.font(.system(size: 34))
						.foregroundStyle(MaskinColor.ink4)
					Text(code.userCode)
						.font(.system(size: 96, weight: .semibold, design: .monospaced))
						.tracking(8)
						.foregroundStyle(MaskinColor.ink)
						.padding(.top, 20)
						.accessibilityLabel("Code \(code.userCode.map(String.init).joined(separator: " "))")
					Button("Use email and password") { usingPassword = true }
						.padding(.top, 20)
				}
				.frame(maxWidth: 900, alignment: .leading)
				TVQRCode(url: code.verificationURIComplete).frame(width: 360, height: 360)
			}
			.padding(96)
		case .denied:
			retry("That sign-in was declined.", button: "Get a new code")
		case .expired:
			retry("That code ran out.", button: "Get a new code")
		case .failed(let message):
			retry(message, button: "Try again")
		}
	}

	private func retry(_ message: String, button: String) -> some View {
		VStack(spacing: 40) {
			Text(message).font(.system(size: 48, weight: .semibold)).foregroundStyle(MaskinColor.ink)
			Button(button) { model.begin() }
			Button("Use email and password") { usingPassword = true }
		}
	}
}

/// A QR code for the approval link, drawn white on the dark page so a phone camera reads it.
private struct TVQRCode: View {
	let url: URL

	var body: some View {
		if let image = Self.render(url.absoluteString) {
			Image(decorative: image, scale: 1)
				.interpolation(.none).resizable().scaledToFit()
				.padding(24)
				.background(.white, in: RoundedRectangle(cornerRadius: MaskinRadius.hero, style: .continuous))
				.accessibilityLabel("QR code for the sign-in page")
		}
	}

	static func render(_ text: String) -> CGImage? {
		let filter = CIFilter.qrCodeGenerator()
		filter.message = Data(text.utf8)
		filter.correctionLevel = "M"
		guard let output = filter.outputImage?.transformed(by: CGAffineTransform(scaleX: 10, y: 10))
		else { return nil }
		return CIContext().createCGImage(output, from: output.extent)
	}
}
