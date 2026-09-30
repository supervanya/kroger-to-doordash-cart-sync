// Runs in kroger.com's page (world: MAIN, document_start). Kroger's product API needs an
// `x-laf-object` location header that the site builds from app state; remember the one the
// site sends so the extension can reuse it for product lookups.
(() => {
  const save = (v) => { try { if (v) localStorage.setItem('__cartSyncLaf', v); } catch {} };

  const origSet = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
    if (String(k).toLowerCase() === 'x-laf-object') save(v);
    return origSet.apply(this, arguments);
  };

  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      const h = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined));
      save(h.get('x-laf-object'));
    } catch {}
    return origFetch.apply(this, arguments);
  };
})();
