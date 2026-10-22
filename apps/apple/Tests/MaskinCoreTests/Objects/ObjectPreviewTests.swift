import Foundation
import Testing

@testable import MaskinCore

@Suite struct ObjectPreviewTests {
	@Test func recipientShowsNameAndAddressTogether() {
		#expect(ObjectPreview.Recipient(role: "to", name: "Mette Holm", address: "mette@northwind.dk").displayText
			== "Mette Holm <mette@northwind.dk>")
		#expect(ObjectPreview.Recipient(role: "cc", address: "dan@northwind.dk").displayText == "dan@northwind.dk")
		#expect(ObjectPreview.Recipient(role: "to", name: "Merethe Aas").displayText == "Merethe Aas")
	}

	@Test func aDraftWithAMissingFieldCannotBeApproved() {
		let complete = ObjectPreview(kind: "email", label: "Email", body: "Hi", contentHash: "h")
		let incomplete = ObjectPreview(kind: "email", label: "Email", body: "Hi", missing: ["To"], contentHash: "h")
		#expect(complete.canApprove)
		#expect(!incomplete.canApprove)
	}
}
