// Functions injected into a www.doordash.com tab (world: MAIN) via chrome.scripting.executeScript.
// Each must be fully self-contained: no imports, no outer-scope references.
// The site's GraphQL endpoint accepts hand-written queries, so we only ask for the fields we use.

/** @returns {{cartId:string, lines:Array<{lineId, itemId, name, qty, purchaseType}>}} */
export async function ddReadCart(storeId) {
  const gql = async (op, query, variables) => {
    const r = await fetch(`/graphql/${op}?operation=${op}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json', 'x-channel-id': 'marketplace', 'x-experience-id': 'doordash' },
      body: JSON.stringify({ operationName: op, variables, query }),
    });
    const j = await r.json();
    if (j.errors) throw new Error(op + ': ' + JSON.stringify(j.errors).slice(0, 300));
    return j.data;
  };
  try {
    const c = await gql('consumerOrderCart', 'query consumerOrderCart { consumerOrderCart { id } }', {});
    const cartId = c.consumerOrderCart?.id || '';
    if (!cartId) return { cartId: '', lines: [] };
    const d = await gql(
      'detailedCartItems',
      `query detailedCartItems($orderCartId: ID!) { orderCart(id: $orderCartId) { id orders { orderItems {
        id quantity purchaseType bundleStore { id } item { id name } } } } }`,
      { orderCartId: cartId },
    );
    const lines = (d.orderCart?.orders || [])
      .flatMap((o) => o.orderItems)
      .filter((i) => !i.bundleStore || i.bundleStore.id === storeId)
      .map((i) => ({ lineId: i.id, itemId: i.item.id, name: i.item.name, qty: i.quantity, purchaseType: i.purchaseType }));
    return { cartId, lines };
  } catch (e) {
    return { __error: 'DoorDash read failed (signed in?): ' + e.message };
  }
}

/**
 * Fetch a server-rendered store page and pull out every item record embedded in it (escaped JSON).
 * Used for the "Buy it again" page and for "Shop your list" results
 * (`/list?search_terms=...`), which search many terms in a single page request.
 * @returns {{items: Array<{id, msid, name, menuId, price, currency, purchaseType}>} | {retryAfter: number}}
 */
export async function ddPageItems(path) {
  try {
    const r = await fetch(path, { credentials: 'include' });
    if (r.status === 429) return { retryAfter: Number(r.headers.get('retry-after')) || 300 };
    if (!r.ok) return { __error: `DoorDash page returned HTTP ${r.status}` };
    const html = await r.text();
    const items = {};
    const re = /item_data\\*"\s*:\s*\{/g;
    let m;
    while ((m = re.exec(html))) {
      const chunk = html.slice(m.index, m.index + 2500).replace(/\\+"/g, '"').replace(/\\+u0026/g, '&');
      const field = (k) => chunk.match(new RegExp(`"${k}"\\s*:\\s*"([^"]*)"`))?.[1];
      const price = chunk.match(/"unit_amount"\s*:\s*(\d+)/)?.[1];
      const it = {
        id: field('item_id'), msid: field('item_msid'), name: field('item_name'), menuId: field('menu_id'),
        price: price ? Number(price) : null, currency: field('currency') || 'USD', purchaseType: field('purchase_type'),
      };
      if (it.id && it.msid && !items[it.msid]) items[it.msid] = it;
    }
    return { items: Object.values(items) };
  } catch (e) {
    return { __error: 'DoorDash page failed: ' + e.message };
  }
}

/**
 * Apply ops sequentially. ops: {type:'add', item:{id,name,menuId,price,currency,purchaseType}, qty}
 *                              | {type:'update', lineId, itemId, qty, purchaseType} | {type:'remove', lineId}
 * @returns {{cartId, results:Array<{ok:boolean, error?:string}>}}
 */
export async function ddApply(storeId, businessId, cartId, ops) {
  const gql = async (op, query, variables) => {
    const r = await fetch(`/graphql/${op}?operation=${op}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json', 'x-channel-id': 'marketplace', 'x-experience-id': 'doordash' },
      body: JSON.stringify({ operationName: op, variables, query }),
    });
    const j = await r.json();
    if (j.errors) throw new Error(JSON.stringify(j.errors).slice(0, 300));
    return j.data;
  };
  const cartContextFilter = {
    experienceCase: 'MULTI_CART_EXPERIENCE_CONTEXT',
    multiCartExperienceContext: {
      storeId,
      combinedBusinessCartExperienceContext: { storeId, combinedBusinessIds: [businessId] },
    },
  };
  const results = [];
  for (const op of ops) {
    try {
      if (op.type === 'add') {
        const d = await gql(
          'addCartItem',
          `mutation addCartItem($addCartItemInput: AddCartItemInput!, $fulfillmentContext: FulfillmentContextInput!, $cartContextFilter: CartContextV2) {
            addCartItemV2(addCartItemInput: $addCartItemInput, fulfillmentContext: $fulfillmentContext, cartContextFilter: $cartContextFilter) { id } }`,
          {
            addCartItemInput: {
              cartId, storeId, menuId: op.item.menuId, itemId: op.item.id, itemName: op.item.name,
              currency: op.item.currency, unitPrice: op.item.price, quantity: op.qty,
              purchaseTypeOptions: { purchaseType: op.item.purchaseType || 'PURCHASE_TYPE_UNIT', continuousQuantity: 0, unit: null },
            },
            fulfillmentContext: { shouldUpdateFulfillment: false },
            cartContextFilter,
          },
        );
        cartId = d.addCartItemV2?.id || cartId; // first add creates the cart if there was none
      } else if (op.type === 'update') {
        await gql(
          'updateCartItem',
          `mutation updateCartItem($updateCartItemApiParams: UpdateCartItemInput!, $fulfillmentContext: FulfillmentContextInput!, $cartContextFilter: CartContextV2) {
            updateCartItemV2(updateCartItemInput: $updateCartItemApiParams, fulfillmentContext: $fulfillmentContext, cartContextFilter: $cartContextFilter) { id } }`,
          {
            updateCartItemApiParams: {
              cartId, cartItemId: op.lineId, itemId: op.itemId, quantity: op.qty, storeId,
              purchaseTypeOptions: { purchaseType: op.purchaseType || 'PURCHASE_TYPE_UNIT', continuousQuantity: 0, unit: null },
              cartFilter: { storeIds: [] },
            },
            fulfillmentContext: { shouldUpdateFulfillment: false },
            cartContextFilter,
          },
        );
      } else if (op.type === 'remove') {
        await gql(
          'removeCartItem',
          `mutation removeCartItem($cartId: ID!, $itemId: ID!) { removeCartItemV2(cartId: $cartId, itemId: $itemId) { id } }`,
          { cartId, itemId: op.lineId },
        );
      }
      results.push({ ok: true });
    } catch (e) {
      results.push({ ok: false, error: e.message });
    }
  }
  return { cartId, results };
}
