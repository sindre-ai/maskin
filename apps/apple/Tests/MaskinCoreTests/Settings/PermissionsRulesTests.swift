import Foundation
import Testing

@testable import MaskinCore

@Suite("PermissionsRules")
struct PermissionsRulesTests {
	@Test("lists the five permissions in order")
	func order() {
		#expect(
			PermissionKind.allCases.map(\.title)
				== ["Microphone", "Camera", "Photos", "Notifications", "Paste from other apps"])
	}

	@Test("only the choices iOS lets an app read show a state")
	func readable() {
		#expect(PermissionKind.allCases.filter(\.isReadable) == [.microphone, .camera, .notifications])
		#expect(!PermissionKind.paste.isReadable)
	}

	@Test("each status has its own word and tone")
	func states() {
		#expect(PermissionStatus.allowed.pageState == PageState("Allowed", .active))
		#expect(PermissionStatus.denied.pageState == PageState("Denied", .notice))
		#expect(PermissionStatus.notAsked.pageState == PageState("Not asked yet", .muted))
	}

	@Test("the paste footnote says to pick Allow")
	func pasteLine() {
		#expect(PermissionsRules.pasteFootnote.contains("Allow"))
	}

	@Test("the denied line shows only while something is denied")
	func deniedLine() {
		#expect(!PermissionsRules.showsDeniedFootnote([:]))
		#expect(!PermissionsRules.showsDeniedFootnote([.microphone: .allowed, .camera: .notAsked]))
		#expect(PermissionsRules.showsDeniedFootnote([.microphone: .allowed, .camera: .denied]))
	}
}
