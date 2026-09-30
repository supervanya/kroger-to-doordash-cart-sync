const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const NOT_FOUND_TTL = 7 * 24 * 3600 * 1000; // keep in sync with background.js
const KR_PRODUCT = (gtin) => `https://www.kroger.com/p/item/${gtin}`;
const DD_PRODUCT = (id) => `https://www.doordash.com/convenience/product?store_id=36030895&product_id=${id}`;

let cache = { byGtin: {}, byDdId: {}, notFound: {} };

const flash = (text) => { $('#msg').textContent = text; setTimeout(() => { $('#msg').textContent = ''; }, 2500); };
const bytes = (obj) => new Blob([JSON.stringify(obj ?? {})]).size;

async function load() {
  const { cache: c } = await chrome.storage.local.get('cache');
  const { plan, lastRun } = await chrome.storage.session.get(['plan', 'lastRun']);
  const { savedCarts = [] } = await chrome.storage.local.get('savedCarts');
  cache = { byGtin: {}, byDdId: {}, notFound: {}, ...c };

  const staleNf = Object.values(cache.notFound).filter((t) => Date.now() - t >= NOT_FOUND_TTL).length;
  $('#stats').innerHTML = [
    ['Saved matches', Object.keys(cache.byGtin).length],
    ['DoorDash id → UPC', Object.keys(cache.byDdId).length],
    ['Not at DoorDash', Object.keys(cache.notFound).length + (staleNf ? ` (${staleNf} due for recheck)` : '')],
    ['Saved carts', savedCarts.length],
    ['Storage used', `${((bytes(c) + bytes(savedCarts)) / 1024).toFixed(1)} KB`],
    ['Pending plan', plan ? `${plan.dir === 'k2d' ? 'Kroger → DoorDash' : 'DoorDash → Kroger'}` : 'none'],
  ].map(([k, v]) => `<div class="stat"><span class="muted">${k}</span><b>${esc(v)}</b></div>`).join('');

  $('#plan').textContent = plan ? JSON.stringify({ dir: plan.dir, diff: plan.diff }, null, 2) : 'No pending plan. Run a preview from the popup.';
  $('#savedCount').textContent = `(${savedCarts.length})`;
  $('#savedCarts').textContent = savedCarts.length
    ? savedCarts.map((sc) => `${sc.name} · ${sc.source} · ${new Date(sc.savedAt).toLocaleString()} · ${sc.items.length} items\n`
      + sc.items.map((i) => `  ${i.gtin}  ×${i.qty}  ${i.name}`).join('\n')).join('\n\n')
    : 'None. Save one from the popup.';
  $('#raw').textContent = JSON.stringify(c ?? {}, null, 2);
  renderMatches();
  renderNotFound();
  renderLastRun(lastRun);
}

function renderLastRun(run) {
  if (!run) {
    $('#lastRunMeta').textContent = '';
    $('#lastRun').innerHTML = '<tr><td colspan="2" class="muted">Nothing run yet in this browser session.</td></tr>';
    return;
  }
  const total = run.totalMs ?? Date.now() - run.startedAt;
  $('#lastRunMeta').textContent = `(${run.op} · ${new Date(run.startedAt).toLocaleTimeString()} · ${(total / 1000).toFixed(1)}s${run.totalMs == null ? ', still running' : ''})`;
  const slowest = Math.max(...run.steps.map((st) => st.ms), 0);
  $('#lastRun').innerHTML = run.steps.map((st) => `<tr>
      <td>${esc(st.label)}</td>
      <td class="num" style="${st.ms === slowest && st.ms > 1000 ? 'font-weight:600' : ''}">${(st.ms / 1000).toFixed(2)}s</td>
    </tr>`).join('') + (run.error ? `<tr><td colspan="2" style="color:var(--bad)">Error: ${esc(run.error)}</td></tr>` : '');
}

function renderMatches() {
  const q = $('#filter').value.trim().toLowerCase();
  const rows = Object.entries(cache.byGtin)
    .filter(([g, it]) => !q || `${it.name} ${g} ${it.id}`.toLowerCase().includes(q))
    .sort((a, b) => (a[1].name || '').localeCompare(b[1].name || ''));
  $('#matchCount').textContent = `(${rows.length}${q ? ` of ${Object.keys(cache.byGtin).length}` : ''})`;
  $('#matches').innerHTML = rows.map(([g, it]) => `<tr>
      <td class="name">${esc(it.name)}</td>
      <td><a href="${KR_PRODUCT(g)}" target="_blank"><code>${esc(g)}</code></a></td>
      <td><a href="${DD_PRODUCT(it.id)}" target="_blank"><code>${esc(it.id)}</code></a></td>
      <td><code>${esc(it.menuId)}</code></td>
      <td class="num">${it.price != null ? `$${(it.price / 100).toFixed(2)}` : ''}</td>
      <td class="muted">${esc((it.purchaseType || '').replace('PURCHASE_TYPE_', ''))}</td>
      <td><button data-forget="${esc(g)}" title="Forget this match; the next sync searches for it again">Forget</button></td>
    </tr>`).join('') || '<tr><td colspan="7" class="muted">Nothing saved yet.</td></tr>';
}

function renderNotFound() {
  const rows = Object.entries(cache.notFound).sort((a, b) => b[1] - a[1]);
  $('#nfCount').textContent = `(${rows.length})`;
  $('#notFound').innerHTML = rows.map(([g, t]) => `<tr>
      <td><a href="${KR_PRODUCT(g)}" target="_blank"><code>${esc(g)}</code></a></td>
      <td>${new Date(t).toLocaleString()}</td>
      <td>${new Date(t + NOT_FOUND_TTL).toLocaleDateString()}</td>
      <td><button data-recheck="${esc(g)}" title="Search for it again on the next sync">Recheck next sync</button></td>
    </tr>`).join('') || '<tr><td colspan="4" class="muted">None.</td></tr>';
}

async function save() {
  await chrome.storage.local.set({ cache });
  await load();
}

document.addEventListener('click', async (e) => {
  const forget = e.target.dataset?.forget;
  const recheck = e.target.dataset?.recheck;
  if (forget) {
    const it = cache.byGtin[forget];
    if (it) delete cache.byDdId[it.id];
    delete cache.byGtin[forget];
    await save();
    flash(`Forgot ${forget}.`);
  } else if (recheck) {
    delete cache.notFound[recheck];
    await save();
    flash(`${recheck} will be searched on the next sync.`);
  }
});

$('#filter').addEventListener('input', renderMatches);
$('#refresh').addEventListener('click', load);
$('#copy').addEventListener('click', async () => {
  await navigator.clipboard.writeText(JSON.stringify(cache, null, 2));
  flash('Copied.');
});
$('#clear').addEventListener('click', async () => {
  if (!confirm('Forget all saved matches? The next sync will search again.')) return;
  await chrome.storage.local.remove('cache');
  await load();
  flash('Cleared.');
});
chrome.storage.onChanged.addListener(load); // stays live while a sync runs

load();
