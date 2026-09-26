//! The Browser tab's WebKit UI delegate on macOS, and the one module in the workspace allowed
//! `unsafe` code (README, "Dependency notes").
//!
//! wry's own delegate grants every camera and microphone request a page makes. That is right
//! for the app's page, but a web page in the Browser tab must never listen or watch, so the
//! tab's webview gets this delegate instead: it denies media capture, sends popups
//! (`window.open`, `target=_blank`) to the system browser, and leaves the file picker to wry's
//! delegate as before. Talking to WebKit through objc2 needs `unsafe`; every use says why it
//! holds.

use block2::DynBlock;
use objc2::rc::Retained;
use objc2::runtime::{NSObject, ProtocolObject};
use objc2::{DefinedClass, MainThreadOnly, define_class, msg_send, sel};
use objc2_foundation::{MainThreadMarker, NSArray, NSObjectProtocol, NSURL};
use objc2_web_kit::{
    WKFrameInfo, WKMediaCaptureType, WKNavigationAction, WKOpenPanelParameters,
    WKPermissionDecision, WKSecurityOrigin, WKUIDelegate, WKWebView, WKWebViewConfiguration,
    WKWindowFeatures,
};
use wry::WebViewExtMacOS;

struct Ivars {
    /// wry's delegate, which still shows the file picker.
    wry: Option<Retained<ProtocolObject<dyn WKUIDelegate>>>,
    /// Opens a popup's address outside the tab.
    on_popup: Box<dyn Fn(String)>,
}

define_class!(
    // SAFETY: NSObject has no subclassing requirements, and the class adds no `Drop`.
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = Ivars]
    #[name = "BrigadierBrowserUIDelegate"]
    struct Delegate;

    // SAFETY: NSObjectProtocol has no requirements.
    unsafe impl NSObjectProtocol for Delegate {}

    // SAFETY: each method's selector and signature match WKUIDelegate's declaration in
    // objc2-web-kit.
    unsafe impl WKUIDelegate for Delegate {
        #[unsafe(method(webView:requestMediaCapturePermissionForOrigin:initiatedByFrame:type:decisionHandler:))]
        fn request_media_capture(
            &self,
            _web_view: &WKWebView,
            origin: &WKSecurityOrigin,
            _frame: &WKFrameInfo,
            kind: WKMediaCaptureType,
            decision: &DynBlock<dyn Fn(WKPermissionDecision)>,
        ) {
            // SAFETY: plain property reads on the origin WebKit passed in.
            let (scheme, host) = unsafe { (origin.protocol(), origin.host()) };
            let kind = match kind {
                WKMediaCaptureType::Camera => "camera",
                WKMediaCaptureType::Microphone => "microphone",
                WKMediaCaptureType::CameraAndMicrophone => "camera and microphone",
                _ => "media",
            };
            tracing::info!(origin = %format!("{scheme}://{host}"), kind, "Browser tab: media capture denied");
            decision.call((WKPermissionDecision::Deny,));
        }

        #[unsafe(method_id(webView:createWebViewWithConfiguration:forNavigationAction:windowFeatures:))]
        fn create_web_view(
            &self,
            _web_view: &WKWebView,
            _configuration: &WKWebViewConfiguration,
            action: &WKNavigationAction,
            _features: &WKWindowFeatures,
        ) -> Option<Retained<WKWebView>> {
            // SAFETY: a property read on the action WebKit passed in.
            let request = unsafe { action.request() };
            if let Some(url) = request.URL().and_then(|url| url.absoluteString()) {
                (self.ivars().on_popup)(url.to_string());
            }
            // No new web view: WebKit opens nothing itself.
            None
        }

        #[unsafe(method(webView:runOpenPanelWithParameters:initiatedByFrame:completionHandler:))]
        fn run_open_panel(
            &self,
            web_view: &WKWebView,
            parameters: &WKOpenPanelParameters,
            frame: &WKFrameInfo,
            done: &DynBlock<dyn Fn(*mut NSArray<NSURL>)>,
        ) {
            let open_panel =
                sel!(webView:runOpenPanelWithParameters:initiatedByFrame:completionHandler:);
            match &self.ivars().wry {
                Some(wry) if wry.respondsToSelector(open_panel) => {
                    // SAFETY: wry's delegate implements this method (checked just above), and
                    // it gets WebKit's own arguments unchanged.
                    unsafe {
                        wry.webView_runOpenPanelWithParameters_initiatedByFrame_completionHandler(
                            web_view, parameters, frame, done,
                        );
                    }
                }
                // As if the user cancelled the picker.
                _ => done.call((std::ptr::null_mut(),)),
            }
        }
    }
);

impl Delegate {
    fn new(mtm: MainThreadMarker, ivars: Ivars) -> Retained<Self> {
        let this = mtm.alloc::<Self>().set_ivars(ivars);
        // SAFETY: NSObject's `init` on a freshly allocated instance.
        unsafe { msg_send![super(this), init] }
    }
}

/// The Browser tab's delegate for one webview. WebKit holds a delegate weakly, so this must
/// live as long as the webview.
pub struct BrowserUi {
    _delegate: Retained<Delegate>,
}

/// Makes `webview` deny camera and microphone requests and hand popups' addresses to
/// `on_popup` rather than open them. Call it on the main thread, right after building the
/// webview.
pub fn install(webview: &wry::WebView, on_popup: impl Fn(String) + 'static) -> BrowserUi {
    let view = webview.webview();
    // SAFETY: a property read on a live web view, on the main thread (it is MainThreadOnly).
    let wry = unsafe { view.UIDelegate() };
    let delegate = Delegate::new(
        view.mtm(),
        Ivars {
            wry,
            on_popup: Box::new(on_popup),
        },
    );
    // SAFETY: the delegate implements WKUIDelegate; WebKit keeps it weakly, and the returned
    // `BrowserUi` keeps it alive beside the webview.
    unsafe { view.setUIDelegate(Some(ProtocolObject::from_ref(&*delegate))) };
    BrowserUi {
        _delegate: delegate,
    }
}
