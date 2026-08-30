// Run at document_start in Gemini's MAIN world before any of Gemini's own
// React code. We override the iframe-detection signals (window.top,
// window.parent, window.frameElement, document.referrer host) so Gemini
// believes it's in a top-level browsing context — which makes the 临时对话
// button (and possibly other features) appear that Gemini otherwise hides
// in iframe mode.
//
// Excluded from gemini.google.com/_/* (bscframe etc.) so nested anti-bot
// sub-iframes still see real values and our content_adapter sub-frame
// filter (window.parent === window.top) keeps working for them.
(function () {
  try {
    // Make window.top and window.parent return the window itself
    const cloak = (key) => {
      try {
        Object.defineProperty(window, key, {
          configurable: true,
          get: () => window
        });
      } catch (_) {}
    };
    cloak('top');
    cloak('parent');

    // window.frameElement returns the <iframe> element in parent doc, or
    // null if top frame. Setting to null = "I'm top frame".
    try {
      Object.defineProperty(window, 'frameElement', {
        configurable: true,
        get: () => null
      });
    } catch (_) {}

    // Some sites also check the Window.prototype getters directly to
    // bypass own-property overrides. Patch the prototype too.
    try {
      const wp = Object.getPrototypeOf(window);
      // wp is Window.prototype on most platforms (or WindowProxy in some)
      ['top', 'parent'].forEach(k => {
        try {
          Object.defineProperty(wp, k, {
            configurable: true,
            get: () => window
          });
        } catch (_) {}
      });
    } catch (_) {}
  } catch (_) {}
})();
