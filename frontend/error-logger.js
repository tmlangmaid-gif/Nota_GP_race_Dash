// Browser-side error capture.
//
// Catches uncaught exceptions and unhandled promise rejections on every page
// and POSTs them in small batches to /api/log-error, which appends to a
// rolling JSON file in the repo. Designed to be portable: drop this file
// alongside the HTML pages, include it with `<script src="/error-logger.js"
// defer></script>`, and you're done.
//
// What gets captured:
//   - window error events (uncaught throw, syntax/reference errors)
//   - unhandledrejection events (promise rejections without .catch)
//   - manual: call window.logBrowserError({ message: '...', extra: {...} })
//
// Batching: queues errors locally and flushes every 30s, on page hide via
// navigator.sendBeacon, and immediately on the first error to avoid loss.
//
// De-dup: identical (type, message, source, line) within one page-lifetime
// are only sent once, so a render loop that throws every frame doesn't DDOS
// the endpoint.
(function () {
  'use strict';

  var URL_PATH = '/api/log-error';
  var FLUSH_INTERVAL_MS = 30 * 1000;
  var MAX_QUEUE = 50;

  var queue = [];
  var seen = Object.create(null);   // dedup key -> 1
  var flushTimer = null;

  function dedupKey(e) {
    return [e.type, e.message, e.source, e.line, e.col].join('|');
  }

  function record(err) {
    var key = dedupKey(err);
    if (seen[key]) return;
    seen[key] = 1;
    queue.push(err);
    if (queue.length > MAX_QUEUE) queue.shift();
    // First error after idle: flush quickly (500 ms) to capture clustering
    if (queue.length === 1 && !flushTimer) {
      flushTimer = setTimeout(function () {
        flushTimer = null;
        flush();
      }, 500);
    }
  }

  function flush() {
    if (!queue.length) return;
    var batch = queue.splice(0);
    var body = JSON.stringify({ errors: batch });
    if (navigator.sendBeacon) {
      try {
        var blob = new Blob([body], { type: 'application/json' });
        if (navigator.sendBeacon(URL_PATH, blob)) return;
      } catch (e) { /* fall through to fetch */ }
    }
    try {
      fetch(URL_PATH, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    body,
        keepalive: true
      }).catch(function () { /* ignore network errors */ });
    } catch (e) { /* ignore */ }
  }

  window.addEventListener('error', function (e) {
    record({
      type:    'window.onerror',
      message: (e.message != null ? String(e.message) : (e.error ? String(e.error) : 'unknown')),
      source:  e.filename || null,
      line:    typeof e.lineno === 'number' ? e.lineno : null,
      col:     typeof e.colno === 'number' ? e.colno : null,
      stack:   (e.error && e.error.stack) ? String(e.error.stack) : null,
      url:     location.href
    });
  });

  window.addEventListener('unhandledrejection', function (e) {
    var reason = e.reason;
    record({
      type:    'unhandledrejection',
      message: reason && reason.message ? String(reason.message) : String(reason),
      stack:   (reason && reason.stack) ? String(reason.stack) : null,
      url:     location.href
    });
  });

  // Manual logging hook for places where the app would otherwise swallow
  // errors. Example:
  //   try { ... } catch (e) { window.logBrowserError(e); }
  window.logBrowserError = function (err, extra) {
    if (!err) return;
    record({
      type:    'manual',
      message: err.message ? String(err.message) : String(err),
      stack:   err.stack ? String(err.stack) : null,
      url:     location.href,
      extra:   extra || null
    });
  };

  // Periodic flush so errors don't sit in memory forever
  setInterval(flush, FLUSH_INTERVAL_MS);

  // Send on page hide (covers reload / navigation / tab close)
  window.addEventListener('pagehide', flush);
  window.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') flush();
  });
})();
