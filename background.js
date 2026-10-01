import { computeDiff, toCartMap, stripSize } from './lib/sync.js';
import { krReadCart, krProducts, krWrite } from './lib/kroger.js';
import { ddReadCart, ddPageItems, ddApply } from './lib/doordash.js';

const DD_STORE_ID = '36030895'; // Kroger, 7350 N Middlebelt Rd (DoorDash)
const DD_BUSINESS_ID = '12931039'; // Kroger on DoorDash
const KR_URL = 'https://www.kroger.com/cart';
const DD_URL = `https://www.doordash.com/convenience/store/${DD_STORE_ID}?pickup=false`;
const STORE_NAME = { kroger: 'Kroger', doordash: 'DoorDash' };
const storePath = (p) => `/convenience/store/${DD_STORE_ID}${p}`;
const LIST_CHUNK = 30; // terms per "Shop your list" request (~9 s and ~4 MB of HTML per 30 terms)

// ---------- tabs & injection ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function waitForLoad(tabId, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { chrome.tabs.onUpdated.removeListener(fn); reject(new Error('Tab load timed out')); }, timeoutMs);
    const fn = (id, info) => {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(fn);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(fn);
    chrome.tabs.get(tabId).then((t) => { if (t.status === 'complete') fn(tabId, { status: 'complete' }); });
  });
}

/**
 * A usable tab on the site. Prefers a loaded, awake tab. A tab put to sleep by Chrome's Memory
 * Saver never reports "complete" on its own, so it gets reloaded. A tab that's still loading is
 * already on the right origin, so we wait only briefly: our same-origin fetches don't need
 * every third-party asset to finish.
 */
async function ensureTab(pattern, url) {
  const tabs = await chrome.tabs.query({ url: pattern });
  const tab = tabs.find((t) => !t.discarded && t.status === 'complete') || tabs.find((t) => !t.discarded) || tabs[0];
  if (!tab) {
    const created = await chrome.tabs.create({ url, active: false });
    await waitForLoad(created.id);
    return created.id;
  }
  if (tab.discarded || tab.status === 'unloaded') {
    await chrome.tabs.reload(tab.id);
    await waitForLoad(tab.id);
  } else if (tab.status !== 'complete') {
    await waitForLoad(tab.id, 8000).catch(() => {});
  }
  return tab.id;
}

const withTimeout = (p, ms, msg) => Promise.race([p, sleep(ms).then(() => { throw new Error(msg); })]);

/**
 * Run a page function in the tab. Kroger sometimes reloads its own page right after loading
 * (bot protection), which cuts off an injected script. Read-only calls (`retry: true`) are then
 * retried once after the reload; writes are never retried, so nothing gets applied twice.
 */
async function run(tabId, func, args = [], { retry = false, timeoutMs = 60000 } = {}) {
  for (let attempt = 0; ; attempt++) {
    let out;
    try {
      const exec = chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func, args });
      const [res] = await withTimeout(exec, timeoutMs, `${func.name} took longer than ${timeoutMs / 1000}s`);
      out = res?.result;
    } catch (e) {
      if (retry && attempt === 0) { await waitForLoad(tabId, 15000).catch(() => {}); continue; }
      throw e;
    }
    // Every page function returns an object; nothing back means the page navigated mid-call.
    if (out == null) {
      if (retry && attempt === 0) { await waitForLoad(tabId, 15000).catch(() => {}); continue; }
      throw new Error(`${func.name}: the page reloaded while it was running. Try again.`);
    }
    if (out.__error) throw new Error(out.__error);
    return out;
  }
}

// ---------- gtin <-> DoorDash item cache ----------
// byGtin: gtin13 -> {id, name, menuId, price, currency, purchaseType}; byDdId: ddItemId -> gtin13
// notFound: gtin13 -> time we last searched DoorDash for it and found nothing (skipped for NOT_FOUND_TTL)

const NOT_FOUND_TTL = 7 * 24 * 3600 * 1000;

async function loadCache() {
  const { cache } = await chrome.storage.local.get('cache');
  return { byGtin: {}, byDdId: {}, notFound: {}, ...cache };
}
const saveCache = (cache) => chrome.storage.local.set({ cache });

function cacheItems(cache, items) {
  for (const it of items) {
    if (!it?.msid || !it.id) continue;
    cache.byGtin[it.msid] = { id: it.id, name: it.name, menuId: it.menuId, price: it.price, currency: it.currency, purchaseType: it.purchaseType };
    cache.byDdId[it.id] = it.msid;
    delete cache.notFound[it.msid];
  }
}

/** Forget a saved match (e.g. DoorDash rejected the item id) so the next lookup searches fresh. */
function evict(cache, gtin) {
  const old = cache.byGtin[gtin];
  if (old) delete cache.byDdId[old.id];
  delete cache.byGtin[gtin];
}

const recentlyNotFound = (cache, g) => Date.now() - (cache.notFound[g] || 0) < NOT_FOUND_TTL;

// DoorDash sells some produce purely by weight; a count can't be copied onto those.
// (UNIT_TO_MEASUREMENT items, e.g. "Zucchini (each)", are ordered by count and are fine.)
const byWeight = (purchaseType) => purchaseType === 'PURCHASE_TYPE_MEASUREMENT';

// ---------- per-operation context: lazy tabs, cache, one "Buy it again" fetch ----------

// ---------- the current operation ("job"), persisted so the popup can close and reopen ----------
// session.job: {kind:'preview'|'apply'|'save', desc, status:'running'|'done'|'error', label, startedAt,
//               updatedAt, result?, error?}. The popup renders purely from this.

let job = null;
const JOB_STALE_MS = 120000; // a "running" job not updated for this long died with the worker
const saveJob = () => chrome.storage.session.set({ job });

/** Record the step now running (shown live in the popup, even after it's reopened). */
function setProgress(label) {
  if (!job || job.status !== 'running') return;
  job = { ...job, label, updatedAt: Date.now() };
  saveJob();
}

class Busy extends Error {}

async function startJob(kind, desc, fn) {
  const { job: current } = await chrome.storage.session.get('job');
  if (current?.status === 'running' && Date.now() - current.updatedAt < JOB_STALE_MS) {
    throw new Busy(`Still working on: ${current.desc}. Wait for it to finish.`);
  }
  job = { kind, desc, status: 'running', label: desc, startedAt: Date.now(), updatedAt: Date.now() };
  await saveJob();
  try {
    const result = await fn();
    job = { ...job, status: 'done', result, updatedAt: Date.now() };
    return result;
  } catch (e) {
    job = { ...job, status: 'error', error: e.message, updatedAt: Date.now() };
    throw e;
  } finally {
    await saveJob();
  }
}

function makeCtx(cache, op) {
  const tabs = {};
  let reorder;
  const log = { op, startedAt: Date.now(), steps: [] };
  const ctx = {
    cache,
    log,
    /** Run one named step: shown live in the popup, timed in the Debug page's "Last run". */
    step: async (label, fn) => {
      setProgress(label);
      const t0 = Date.now();
      const entry = { label, ms: 0 };
      log.steps.push(entry);
      try { return await fn(); } finally { entry.ms = Date.now() - t0; }
    },
    kTab: () => (tabs.k ||= ctx.step('Connecting to the Kroger tab', () => ensureTab('https://www.kroger.com/*', KR_URL))),
    dTab: () => (tabs.d ||= ctx.step('Connecting to the DoorDash tab', () => ensureTab('https://www.doordash.com/*', DD_URL))),
    // The "Buy it again" page is large (~4 MB): fetch it at most once per operation, only on a cache miss.
    loadReorder: () => (reorder ||= ctx.dTab()
      .then((t) => ctx.step('Loading your DoorDash "Buy it again" list',
        () => run(t, ddPageItems, [storePath('/collection/reorder?collectionType=reorder')], { retry: true })))
      .then((res) => cacheItems(cache, res.items || []))
      .catch(() => {})), // best effort: list search still works without it
  };
  return ctx;
}

async function withCtx(op, fn) {
  const ctx = makeCtx(await loadCache(), op);
  try {
    return await fn(ctx);
  } catch (e) {
    ctx.log.error = e.message;
    throw e;
  } finally {
    ctx.log.totalMs = Date.now() - ctx.log.startedAt;
    await saveCache(ctx.cache); // keep whatever was learned, even if the operation failed
    await chrome.storage.session.set({ lastRun: ctx.log });
  }
}

// "Shop your list" splits terms on commas and newlines; ® and ™ only hurt matching.
const listTerm = (name) => name.replace(/[®™*]/g, '').replace(/[,\n]/g, ' ').replace(/\s+/g, ' ').trim();
const base64Utf8 = (str) => btoa(String.fromCharCode(...new TextEncoder().encode(str)));

/**
 * Search DoorDash for many items at once via its "Shop your list" page
 * (`/list?search_terms=<base64 JSON array>`): one page request per LIST_CHUNK terms, instead of
 * one rate-limited GraphQL search per item. Every item on the results page is cached.
 */
async function listSearch(ctx, names) {
  const terms = [...new Set(names.map(listTerm).filter(Boolean))];
  if (!terms.length) return;
  const dTab = await ctx.dTab();
  const chunks = Math.ceil(terms.length / LIST_CHUNK);
  for (let i = 0; i < terms.length; i += LIST_CHUNK) {
    const chunk = terms.slice(i, i + LIST_CHUNK);
    const label = `Searching DoorDash for ${chunk.length} item${chunk.length === 1 ? '' : 's'} at once`
      + (chunks > 1 ? ` (${i / LIST_CHUNK + 1}/${chunks})` : '');
    const path = storePath(`/list?search_terms=${encodeURIComponent(base64Utf8(JSON.stringify(chunk)))}`);
    const res = await ctx.step(label, () => run(dTab, ddPageItems, [path], { retry: true, timeoutMs: 90000 }));
    if (res.retryAfter) {
      throw new Error(`DoorDash is rate-limiting requests. Matches found so far are saved. Try again in ~${Math.ceil(res.retryAfter / 60)} min.`);
    }
    cacheItems(ctx.cache, res.items);
  }
}

/** Kroger product names: gtin -> {name, brand, size}. */
async function krNames(ctx, gtins) {
  if (!gtins.length) return {};
  const kTab = await ctx.kTab();
  const label = `Getting names for ${gtins.length} Kroger item${gtins.length === 1 ? '' : 's'}`;
  try {
    return await ctx.step(label, () => run(kTab, krProducts, [gtins], { retry: true }));
  } catch (e) {
    if (!String(e.message).includes('LAF_MISSING')) throw e;
    // The capture script hasn't seen a request yet (e.g. extension just installed): reload once.
    await ctx.step('Reloading the Kroger tab (first run after install)', async () => {
      await chrome.tabs.reload(kTab);
      await waitForLoad(kTab);
      await sleep(2500);
    });
    return await ctx.step(label, () => run(kTab, krProducts, [gtins], { retry: true }));
  }
}

// ---------- reading carts ----------

async function readKroger(ctx) {
  const kTab = await ctx.kTab();
  return ctx.step('Reading your Kroger cart', () => run(kTab, krReadCart, [], { retry: true }));
}

/**
 * DoorDash cart with each line resolved to a gtin13 (null if unidentified). The cart has no UPCs,
 * so for item ids we haven't seen: the "Buy it again" page first, then one bulk list search.
 */
async function readDoorDash(ctx) {
  const dTab = await ctx.dTab();
  const d = await ctx.step('Reading your DoorDash cart', () => run(dTab, ddReadCart, [DD_STORE_ID], { retry: true }));
  const missing = d.lines.filter((l) => !ctx.cache.byDdId[l.itemId]);
  if (missing.length) await ctx.loadReorder();
  await listSearch(ctx, missing.filter((l) => !ctx.cache.byDdId[l.itemId]).map((l) => stripSize(l.name)));
  return { cartId: d.cartId, subtotal: d.subtotal, lines: d.lines.map((l) => ({ ...l, gtin: ctx.cache.byDdId[l.itemId] || null })) };
}

/**
 * Make sure every gtin has a DoorDash item in the cache if DoorDash sells it: the "Buy it again"
 * page first, then a bulk list search by name. `names` (gtin -> {name, brand}) supplies the search text.
 */
async function resolveAtDoorDash(ctx, gtins, names = {}) {
  const { cache } = ctx;
  let missing = [...new Set(gtins)].filter((g) => !cache.byGtin[g] && !recentlyNotFound(cache, g));
  if (!missing.length) return;
  await ctx.loadReorder();
  missing = missing.filter((g) => !cache.byGtin[g]);
  if (!missing.length) return;
  const noName = missing.filter((g) => !names[g]?.name);
  if (noName.length) names = { ...names, ...(await krNames(ctx, noName)) };
  await listSearch(ctx, missing.map((g) => names[g]?.name || g));
  // Second try with a shorter query (brand + first words) for anything still unmatched.
  const short = (g) => {
    const brand = names[g].brand || '';
    return [brand, ...names[g].name.replace(brand, '').trim().split(/\s+/).slice(0, 3)].join(' ').trim();
  };
  await listSearch(ctx, missing.filter((g) => !cache.byGtin[g] && names[g]?.name).map(short));
  // Both passes ran without being rate-limited: anything still missing isn't sold there.
  for (const g of missing) if (!cache.byGtin[g]) cache.notFound[g] = Date.now();
}

// ---------- plans: what to change in one cart so it matches a source ----------

const weightSkip = (o) => ({ ...o, reason: 'sold by weight on DoorDash; set it by hand' });

/**
 * Diff `source` (Map gtin -> {qty, name, brand?, byWeight?}) against the target store's live cart
 * and store the plan for apply(). `redo` describes how to rebuild this preview (to verify after apply).
 */
async function buildPlan(ctx, { target, source, mode, redo, label }) {
  const { cache } = ctx;
  const plan = { target, mode, redo, label };
  let diff;

  if (target === 'doordash') {
    const d = await readDoorDash(ctx);
    await resolveAtDoorDash(ctx, [...source.keys()], Object.fromEntries(source));
    const dMap = toCartMap(d.lines.filter((l) => l.gtin).map((l) => ({ gtin: l.gtin, qty: l.qty, name: l.name })));
    diff = computeDiff(source, dMap, (g) => !!cache.byGtin[g], mode);
    diff.unmatched = diff.unmatched.map((u) => ({
      ...u,
      reason: recentlyNotFound(cache, u.gtin)
        ? `not found at the DoorDash store (checked ${new Date(cache.notFound[u.gtin]).toLocaleDateString()}; rechecked after 7 days)`
        : 'not found at the DoorDash store',
    }));
    const weighed = (g) => byWeight(cache.byGtin[g]?.purchaseType);
    for (const key of ['add', 'change']) {
      diff.unmatched.push(...diff[key].filter((o) => weighed(o.gtin)).map(weightSkip));
      diff[key] = diff[key].filter((o) => !weighed(o.gtin));
    }
    // Lines we couldn't identify are never touched.
    diff.untouched = d.lines.filter((l) => !l.gtin).map((l) => ({ name: l.name, qty: l.qty, reason: 'could not identify this DoorDash item; left as is' }));
    Object.assign(plan, { dCartId: d.cartId, dLines: d.lines, counts: { target: d.lines.length } });
  } else {
    const k = await readKroger(ctx);
    // Names for Kroger items that aren't in the source (shown under "Remove").
    const unknown = [...new Set(k.lines.map((l) => l.gtin).filter((g) => !source.has(g) && !cache.byGtin[g]))];
    const names = mode === 'mirror' ? await krNames(ctx, unknown) : {};
    const nameOf = (g) => source.get(g)?.name || names[g]?.name || cache.byGtin[g]?.name || g;
    const kMap = toCartMap(k.lines.map((l) => ({ gtin: l.gtin, qty: l.qty, name: nameOf(l.gtin) })));
    diff = computeDiff(source, kMap, () => true, mode);
    const weighed = (g) => source.get(g)?.byWeight;
    for (const key of ['add', 'change']) {
      diff.unmatched.push(...diff[key].filter((o) => weighed(o.gtin)).map(weightSkip));
      diff[key] = diff[key].filter((o) => !weighed(o.gtin));
    }
    diff.untouched = [];
    Object.assign(plan, { kCartId: k.cartId, kLines: k.lines, counts: { target: k.lines.length } });
  }

  plan.diff = diff;
  await chrome.storage.session.set({ plan });
  return { target, mode, label, diff, counts: plan.counts };
}

/** Sync preview: make one store's cart mirror the other's live cart. */
async function previewSync(ctx, dir) {
  const redo = { kind: 'sync', dir };
  if (dir === 'k2d') {
    const k = await readKroger(ctx);
    const names = await krNames(ctx, [...new Set(k.lines.map((l) => l.gtin))]);
    const source = toCartMap(k.lines.map((l) => ({ gtin: l.gtin, qty: l.qty, name: names[l.gtin]?.name || l.gtin, brand: names[l.gtin]?.brand || '' })));
    return buildPlan(ctx, { target: 'doordash', source, mode: 'mirror', redo, label: 'your Kroger cart' });
  }
  const d = await readDoorDash(ctx);
  // Mirroring from an incomplete source would delete Kroger items that are really in the DoorDash cart.
  const unknown = d.lines.filter((l) => !l.gtin);
  if (unknown.length) {
    throw new Error(`Couldn't identify ${unknown.length} DoorDash item(s): ${unknown.map((u) => u.name).join(', ')}. Nothing was changed.`);
  }
  const source = toCartMap(d.lines.map((l) => ({ gtin: l.gtin, qty: l.qty, name: l.name, byWeight: byWeight(l.purchaseType) })));
  return buildPlan(ctx, { target: 'kroger', source, mode: 'mirror', redo, label: 'your DoorDash cart' });
}

// ---------- saved carts ----------
// savedCarts: [{id, name, source:'kroger'|'doordash', savedAt, items:[{gtin, qty, name, brand?, byWeight?}], skipped:[name]}]

async function loadSaved() {
  const { savedCarts } = await chrome.storage.local.get('savedCarts');
  return savedCarts || [];
}
const storeSaved = (savedCarts) => chrome.storage.local.set({ savedCarts });

async function saveCart(ctx, source, name) {
  let items;
  let skipped = [];
  if (source === 'kroger') {
    const k = await readKroger(ctx);
    const names = await krNames(ctx, [...new Set(k.lines.map((l) => l.gtin))]);
    items = toCartMap(k.lines.map((l) => ({ gtin: l.gtin, qty: l.qty, name: names[l.gtin]?.name || l.gtin, brand: names[l.gtin]?.brand || '' })));
  } else {
    const d = await readDoorDash(ctx);
    skipped = d.lines.filter((l) => !l.gtin).map((l) => l.name);
    items = toCartMap(d.lines.filter((l) => l.gtin).map((l) => ({ gtin: l.gtin, qty: l.qty, name: l.name, byWeight: byWeight(l.purchaseType) })));
  }
  if (!items.size) throw new Error(`Your ${STORE_NAME[source]} cart is empty; nothing to save.`);
  const cart = {
    id: crypto.randomUUID(),
    name: name || `${STORE_NAME[source]} cart`,
    source,
    savedAt: Date.now(),
    items: [...items].map(([gtin, v]) => ({ gtin, ...v })),
    skipped,
  };
  await storeSaved([cart, ...(await loadSaved())]);
  return cart;
}

async function previewSaved(ctx, { id, target, mode }) {
  const cart = (await loadSaved()).find((c) => c.id === id);
  if (!cart) throw new Error('That saved cart no longer exists.');
  return buildPlan(ctx, { target, source: toCartMap(cart.items), mode, redo: { kind: 'saved', id, target, mode }, label: `“${cart.name}”` });
}

// ---------- clear a cart ----------

/**
 * Plan removing every line from one store's cart. No item matching (so no DoorDash searching):
 * each line is keyed by its own line id, which apply() removes like any other "remove".
 * Unidentified DoorDash items are included, unlike in syncs.
 */
async function previewClear(ctx, target) {
  const plan = { target, mode: 'clear', redo: { kind: 'clear', target }, label: `your ${STORE_NAME[target]} cart` };
  let remove;
  if (target === 'doordash') {
    const d = await ctx.step('Reading your DoorDash cart', async () => run(await ctx.dTab(), ddReadCart, [DD_STORE_ID], { retry: true }));
    const dLines = d.lines.map((l) => ({ ...l, gtin: `line:${l.lineId}` }));
    remove = dLines.map((l) => ({ gtin: l.gtin, name: l.name, qty: l.qty }));
    Object.assign(plan, { dCartId: d.cartId, dLines, counts: { target: dLines.length } });
  } else {
    const k = await readKroger(ctx);
    const names = await krNames(ctx, [...new Set(k.lines.map((l) => l.gtin))]);
    remove = [...toCartMap(k.lines.map((l) => ({ gtin: l.gtin, qty: l.qty, name: names[l.gtin]?.name || l.gtin })))]
      .map(([gtin, v]) => ({ gtin, name: v.name, qty: v.qty }));
    Object.assign(plan, { kCartId: k.cartId, kLines: k.lines, counts: { target: k.lines.length } });
  }
  plan.diff = { add: [], change: [], remove, unmatched: [], untouched: [] };
  await chrome.storage.session.set({ plan });
  return { target, mode: 'clear', label: plan.label, diff: plan.diff, counts: plan.counts };
}

// ---------- price comparison ----------

const ddEstimated = (purchaseType) => purchaseType === 'PURCHASE_TYPE_UNIT_TO_MEASUREMENT' || purchaseType === 'PURCHASE_TYPE_MEASUREMENT';

/**
 * Both carts priced side by side, one row per UPC (unidentified DoorDash lines get their own row).
 * Each side is {qty, unit, total, regularTotal, estimated, listed}: cents; `listed` means the item
 * isn't in that cart and `unit` is the store's current price for comparison (DoorDash's from the
 * match cache, so it may be a little out of date). Kroger prices exclude digital coupons.
 */
async function comparePrices(ctx) {
  const k = await readKroger(ctx);
  const d = await readDoorDash(ctx);
  const allGtins = [...new Set([...k.lines.map((l) => l.gtin), ...d.lines.map((l) => l.gtin).filter(Boolean)])];
  const info = await krNames(ctx, allGtins);

  const rows = new Map();
  const rowFor = (key, gtin, name) => {
    if (!rows.has(key)) rows.set(key, { gtin, name, kroger: null, doordash: null });
    return rows.get(key);
  };

  for (const [g, v] of toCartMap(k.lines.map((l) => ({ gtin: l.gtin, qty: l.qty })))) {
    const p = info[g] || {};
    const unit = p.price ?? null;
    rowFor(g, g, p.name || g).kroger = {
      qty: v.qty, unit, total: unit == null ? null : unit * v.qty,
      regularTotal: p.regularPrice != null && unit != null && p.regularPrice > unit ? p.regularPrice * v.qty : null,
      estimated: p.sellBy === 'Weight', perWeight: p.perWeight, listed: false,
    };
  }
  for (const l of d.lines) {
    const row = rowFor(l.gtin || `line:${l.lineId}`, l.gtin, l.name);
    const dd = (row.doordash ||= { qty: 0, unit: l.unitPrice, total: 0, regularTotal: null, estimated: ddEstimated(l.purchaseType), listed: false, name: l.name });
    dd.qty += l.qty;
    dd.total += l.lineTotal ?? 0;
    if (l.regularTotal != null) dd.regularTotal = (dd.regularTotal || 0) + l.regularTotal;
  }
  // Fill in the other store's current price for items that are only in one cart.
  for (const row of rows.values()) {
    if (!row.gtin) continue;
    const p = info[row.gtin];
    if (!row.kroger && p?.price != null) row.kroger = { qty: 0, unit: p.price, total: null, estimated: p.sellBy === 'Weight', perWeight: p.perWeight, listed: true };
    const c = ctx.cache.byGtin[row.gtin];
    if (!row.doordash && c?.price != null) row.doordash = { qty: 0, unit: c.price, total: null, estimated: ddEstimated(c.purchaseType), listed: true, name: c.name };
  }

  const list = [...rows.values()].sort((a, b) => a.name.localeCompare(b.name));
  const sum = (side) => list.reduce((n, r) => n + (r[side] && !r[side].listed ? r[side].total || 0 : 0), 0);
  // Same basket: every item priced at both stores, at the quantity in your cart (Kroger's if in both).
  // Items priced by weight are left out: the stores can sell the same produce code by a different
  // unit (Kroger "bunch of bananas" vs DoorDash "banana (each)"), so their prices don't compare.
  const basket = { items: 0, kroger: 0, doordash: 0, excluded: 0, byWeight: 0 };
  for (const r of list) {
    if (r.kroger?.unit == null || r.doordash?.unit == null) { basket.excluded++; continue; }
    if (r.kroger.estimated || r.doordash.estimated) { basket.byWeight++; continue; }
    const q = r.kroger.qty || r.doordash.qty;
    basket.items++;
    basket.kroger += r.kroger.unit * q;
    basket.doordash += r.doordash.unit * q;
  }
  return {
    at: Date.now(),
    kroger: { lines: k.lines.length, total: sum('kroger') },
    doordash: { lines: d.lines.length, total: d.subtotal ?? sum('doordash') },
    basket,
    rows: list,
  };
}

const rebuild = (ctx, redo) => (redo.kind === 'sync' ? previewSync(ctx, redo.dir)
  : redo.kind === 'clear' ? previewClear(ctx, redo.target) : previewSaved(ctx, redo));

// ---------- apply ----------

async function apply(ctx) {
  const t0 = Date.now();
  const { plan } = await chrome.storage.session.get('plan');
  if (!plan) throw new Error('No preview to apply; run a preview first.');
  const { cache } = ctx;
  const { diff } = plan;
  const failures = [];

  if (plan.target === 'doordash') {
    const dTab = await ctx.dTab();
    const linesByGtin = {};
    for (const l of plan.dLines) if (l.gtin) (linesByGtin[l.gtin] ||= []).push(l);
    const ops = [];
    for (const a of diff.add) ops.push({ type: 'add', item: cache.byGtin[a.gtin], qty: a.qty, label: a.name, gtin: a.gtin });
    for (const c of diff.change) {
      const [first, ...dupes] = linesByGtin[c.gtin];
      ops.push({ type: 'update', lineId: first.lineId, itemId: first.itemId, purchaseType: first.purchaseType, qty: c.to, label: c.name });
      for (const x of dupes) ops.push({ type: 'remove', lineId: x.lineId, label: c.name });
    }
    for (const r of diff.remove) for (const x of linesByGtin[r.gtin]) ops.push({ type: 'remove', lineId: x.lineId, label: r.name });
    const res = await ctx.step(`Updating your DoorDash cart (${ops.length} change${ops.length === 1 ? '' : 's'})`,
      () => run(dTab, ddApply, [DD_STORE_ID, DD_BUSINESS_ID, plan.dCartId, ops.map(({ label, gtin, ...o }) => o)], { timeoutMs: 180000 }));
    const failed = ops.map((op, i) => ({ op, r: res.results[i] })).filter(({ r }) => !r.ok);

    // A failed add may mean the saved match is stale: drop it, search fresh, and retry once
    // if the search finds a different DoorDash item for that UPC.
    const retry = [];
    for (const { op } of failed.filter(({ op }) => op.type === 'add')) {
      const staleId = op.item.id;
      evict(cache, op.gtin);
      try { await listSearch(ctx, [op.label]); } catch { break; } // rate-limited: report the rest as failed
      const fresh = cache.byGtin[op.gtin];
      if (fresh && fresh.id !== staleId) retry.push({ ...op, item: fresh });
    }
    const retryRes = retry.length
      ? await ctx.step(`Retrying ${retry.length} item(s) with fresh matches`,
        () => run(dTab, ddApply, [DD_STORE_ID, DD_BUSINESS_ID, res.cartId, retry.map(({ label, gtin, ...o }) => o)], { timeoutMs: 180000 }))
      : { results: [] };
    const fixed = new Set(retry.filter((_, i) => retryRes.results[i].ok).map((op) => op.gtin));
    for (const { op, r } of failed) {
      if (!(op.type === 'add' && fixed.has(op.gtin))) failures.push({ name: op.label, op: op.type, error: r.error });
    }
  } else {
    const byGtin = {};
    for (const l of plan.kLines) (byGtin[l.gtin] ||= []).push(l.line);
    const lineItems = [];
    for (const a of diff.add) lineItems.push({ gtin13: a.gtin, quantity: a.qty, modalityType: 'DELIVERY', substitutionPolicy: 'SHOPPER_CHOICE', savedForLater: false });
    for (const c of diff.change) {
      const [first, ...dupes] = byGtin[c.gtin];
      lineItems.push({ ...first, quantity: c.to }, ...dupes.map((x) => ({ ...x, quantity: 0 })));
    }
    for (const r of diff.remove) for (const x of byGtin[r.gtin]) lineItems.push({ ...x, quantity: 0 });
    if (lineItems.length) {
      const kTab = await ctx.kTab();
      try {
        await ctx.step(`Updating your Kroger cart (${lineItems.length} change${lineItems.length === 1 ? '' : 's'})`, () => run(kTab, krWrite, [plan.kCartId, lineItems]));
      } catch (e) {
        failures.push({ name: 'Kroger cart update', op: 'write', error: e.message });
      }
    }
  }

  await chrome.storage.session.remove('plan');
  // Verify by rebuilding the same preview against the updated cart.
  setProgress('Checking the result');
  const after = await rebuild(ctx, plan.redo);
  const remaining = after.diff.add.length + after.diff.change.length + after.diff.remove.length;
  return { failures, remaining, after, ms: Date.now() - t0 };
}

// ---------- messages from the popup ----------

const timed = (fn) => async (ctx) => { const t0 = Date.now(); const r = await fn(ctx); return { ...r, ms: Date.now() - t0 }; };

/** A cart operation: runs as the persisted job, with a step log for the Debug page. */
const op = (kind, desc, fn) => startJob(kind, desc, () => withCtx(desc, fn));

const handlers = {
  preview: (msg) => op('preview', `Sync preview (${msg.dir === 'k2d' ? 'Kroger → DoorDash' : 'DoorDash → Kroger'})`, timed((ctx) => previewSync(ctx, msg.dir))),
  prices: () => op('prices', 'Compare prices', comparePrices),
  previewClear: (msg) => op('preview', `Clear ${STORE_NAME[msg.target]} cart (preview)`, timed((ctx) => previewClear(ctx, msg.target))),
  previewSaved: (msg) => op('preview', `Saved cart preview (${msg.mode === 'add' ? 'add to' : 'restore'} ${STORE_NAME[msg.target]})`, timed((ctx) => previewSaved(ctx, msg))),
  apply: () => op('apply', 'Apply changes', apply),
  saveCart: (msg) => op('save', `Save ${STORE_NAME[msg.source]} cart`, (ctx) => saveCart(ctx, msg.source, msg.name)),
  listSaved: () => loadSaved(),
  deleteSaved: async (msg) => { await storeSaved((await loadSaved()).filter((c) => c.id !== msg.id)); return { ok: true }; },
  clearCache: async () => { await chrome.storage.local.remove('cache'); return { ok: true }; },
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handler = handlers[msg.cmd];
  if (!handler) return false;
  handler(msg)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((e) => sendResponse({ ok: false, error: e.message, busy: e instanceof Busy }));
  return true;
});
