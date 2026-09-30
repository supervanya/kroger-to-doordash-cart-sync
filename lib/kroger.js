// Functions injected into a www.kroger.com tab (world: MAIN) via chrome.scripting.executeScript.
// Each must be fully self-contained: no imports, no outer-scope references.
// Errors are returned as { __error } because thrown errors don't serialize across executeScript.

/** @returns {{cartId:string, lines:Array<{gtin:string, qty:number, line:object}>}} */
export async function krReadCart() {
  try {
    const r = await fetch('/atlas/v1/carts', {
      headers: { accept: 'application/json', 'x-kroger-channel': 'WEB' },
      credentials: 'include',
    });
    if (r.status === 401 || r.status === 403) return { __error: 'Not signed in to kroger.com' };
    const j = await r.json();
    const cart = j?.data?.carts?.find((c) => c.type === 'ACTIVE') || j?.data?.carts?.[0];
    if (!cart) return { __error: 'Kroger cart not found: ' + JSON.stringify(j).slice(0, 200) };
    const lines = cart.lineItems
      .filter((l) => !l.savedForLater)
      .map((l) => ({ gtin: l.gtin13, qty: l.quantity, line: l }));
    return { cartId: cart.id, lines };
  } catch (e) {
    return { __error: 'Kroger read failed: ' + e.message };
  }
}

/**
 * Product names for gtins. Needs the location header the site itself sends, which
 * content/kroger-laf-capture.js stores in localStorage on every page load.
 * @returns {Record<string,{name:string, brand:string, size:string}>}
 */
export async function krProducts(gtins) {
  try {
    const laf = localStorage.getItem('__cartSyncLaf');
    if (!laf) return { __error: 'LAF_MISSING' };
    const out = {};
    for (let i = 0; i < gtins.length; i += 50) {
      const qs = gtins.slice(i, i + 50).map((g) => 'filter.gtin13s=' + g).join('&');
      const r = await fetch(`/atlas/v1/product/v2/products?${qs}&filter.verified=true&projections=items.full`, {
        headers: { accept: 'application/json', 'x-kroger-channel': 'WEB', 'x-laf-object': laf },
        credentials: 'include',
      });
      const j = await r.json();
      if (j.errors) return { __error: 'Kroger products: ' + JSON.stringify(j.errors).slice(0, 200) };
      for (const p of j.data.products) {
        const it = p.item;
        out[it.upc] = { name: it.description, brand: it.brand?.name || '', size: it.customerFacingSize || '' };
      }
    }
    return out;
  } catch (e) {
    return { __error: 'Kroger products failed: ' + e.message };
  }
}

/**
 * One PUT sets quantities for many lines. Existing lines are sent back with a new quantity
 * (0 removes); new items are sent without an id.
 */
export async function krWrite(cartId, lineItems) {
  try {
    const r = await fetch('/atlas/v1/carts/' + cartId, {
      method: 'PUT',
      headers: { accept: 'application/json', 'content-type': 'application/json', 'x-kroger-channel': 'WEB' },
      credentials: 'include',
      body: JSON.stringify({ lineItems }),
    });
    const text = await r.text();
    if (!r.ok) return { __error: `Kroger write HTTP ${r.status}: ${text.slice(0, 300)}` };
    return { ok: true };
  } catch (e) {
    return { __error: 'Kroger write failed: ' + e.message };
  }
}
