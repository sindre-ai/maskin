import Foundation

/// The scripts the host adds to a custom view's web view. They go in as user scripts, not as text in
/// the page, so the page cannot misplace, edit or remove them.
extension LoopViewBridge {
	private static var post: String { "window.webkit.messageHandlers.\(handlerName).postMessage" }

	/// `window.maskin.query(name)`: asks the host and resolves with its answer. Same shape as the
	/// web bridge, so a view written for one runs on the other. `__maskinReply` is how the host
	/// hands an answer back; a page can only resolve its own pending questions with it.
	public static var bridgeScript: String {
		"""
		(function(){var n=0,p={};\
		window.__maskinReply=function(id,ok,payload){var h=p[id];if(!h)return;delete p[id];\
		if(ok)h.res(payload);else h.rej(new Error(payload))};\
		window.maskin={query:function(name){return new Promise(function(res,rej){var id=++n;\
		p[id]={res:res,rej:rej};try{\(post)({type:'\(queryMessage)',id:id,name:String(name)})}\
		catch(e){delete p[id];rej(e)}})}}})();
		"""
	}

	/// Reports the document's content height (not scrollHeight, which can never shrink below the
	/// frame's own height) on load, resize and every layout change, so the tab can size the view
	/// to fit as numbers arrive.
	public static var sizeScript: String {
		"""
		(function(){function s(){try{var d=document.documentElement;\(post)({type:'\(sizeMessage)',\
		w:d.scrollWidth,cw:d.clientWidth,\
		h:Math.ceil(Math.max(d.getBoundingClientRect().height,d.scrollHeight>window.innerHeight?d.scrollHeight:0))})}\
		catch(e){}}if(document.readyState==='complete')s();else window.addEventListener('load',s);\
		window.addEventListener('resize',s);\
		if(window.ResizeObserver)new ResizeObserver(s).observe(document.documentElement)})();
		"""
	}

	/// Takes the real-time connection constructors away from the page and from every frame it
	/// makes. A page that opens a peer connection can send what it read to a host of its choosing,
	/// and no policy header covers that. This is a layer, not a seal: see the pull request for what
	/// stays open.
	public static var realtimeBlockScript: String {
		"""
		(function(){['RTCPeerConnection','webkitRTCPeerConnection','RTCDataChannel',\
		'RTCSessionDescription','RTCIceCandidate','RTCRtpSender','RTCRtpReceiver','RTCRtpTransceiver',\
		'RTCSctpTransport','RTCDtlsTransport','RTCIceTransport','RTCCertificate','RTCPeerConnectionIceEvent',\
		'RTCDataChannelEvent'].forEach(function(k){try{\
		Object.defineProperty(window,k,{value:undefined,writable:false,configurable:false})}catch(e){}})})();
		"""
	}

	/// Content rules that refuse every network load. The policy in the document already says
	/// `connect-src 'none'` and the navigation delegate cancels every navigation but ours; this is
	/// a third layer under both. Patterns avoid groups, which content rules do not support.
	public static let blockNetworkRules =
		#"[{"trigger":{"url-filter":"^https?://"},"action":{"type":"block"}},"#
		+ #"{"trigger":{"url-filter":"^wss?://"},"action":{"type":"block"}},"#
		+ #"{"trigger":{"url-filter":"^ftp://"},"action":{"type":"block"}}]"#
}
