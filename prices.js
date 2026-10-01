const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const status = (text, err = false) => { $('#status').textContent = text; $('#status').className = err ? 'err' : ''; };
const usd = (cents) => (cents == null ? '' : `$${(cents / 100).toFixed(2)}`);
const dollars = (cents) => (cents == null ? '' : (cents / 100).toFixed(2)); // for CSV

let data = null;
let ticker = null;

// ---------- the comparison job (runs in the background; survives closing this tab) ----------

function showJob(job) {
  clearInterval(ticker);
  if (!job || job.kind !== 'prices') return;
  if (job.status === 'running') {
    $('#refresh').disabled = true;
    const tick = () => status(`${job.label}… ${Math.floor((Date.now() - job.startedAt) / 1000)}s`);
    tick();
    ticker = setInterval(tick, 250);
    return;
  }
  $('#refresh').disabled = false;
  if (job.status === 'error') return status(job.error, true);
  data = job.result;
  status(`Prices as of ${new Date(data.at).toLocaleString()}.`);
  render();
  logTable();
}

async function refresh() {
  const res = await chrome.runtime.sendMessage({ cmd: 'prices' });
  if (!res.ok && res.busy) status(res.error, true);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && changes.job) showJob(changes.job.newValue);
});

// ---------- table ----------

const unitDiff = (r) => (r.kroger?.unit != null && r.doordash?.unit != null ? r.doordash.unit - r.kroger.unit : null);
const inCart = (side) => side && !side.listed;

function visibleRows() {
  const q = $('#filter').value.trim().toLowerCase();
  const show = $('#show').value;
  const rows = data.rows.filter((r) => {
    if (q && !`${r.name} ${r.doordash?.name || ''} ${r.gtin || ''}`.toLowerCase().includes(q)) return false;
    const k = inCart(r.kroger), d = inCart(r.doordash);
    return show === 'all' || (show === 'both' && k && d) || (show === 'kroger' && k && !d) || (show === 'doordash' && d && !k);
  });
  const sort = $('#sort').value;
  if (sort === 'diff') rows.sort((a, b) => Math.abs(unitDiff(b) ?? -1) - Math.abs(unitDiff(a) ?? -1));
  if (sort === 'total') rows.sort((a, b) => Math.max(b.kroger?.total || 0, b.doordash?.total || 0) - Math.max(a.kroger?.total || 0, a.doordash?.total || 0));
  return rows;
}

function cells(side) {
  if (!side) return '<td class="sep"></td><td></td><td></td>';
  const approx = side.estimated ? '≈' : '';
  const unitTitle = side.perWeight ? ` title="${esc(side.perWeight)}"` : '';
  if (side.listed) {
    return `<td class="sep listed">–</td><td class="listed"${unitTitle}>${approx}${usd(side.unit)}</td><td class="listed"></td>`;
  }
  const reg = side.regularTotal ? `<span class="reg">${usd(side.regularTotal)}</span>` : '';
  const sale = side.regularTotal ? '<span class="tag">sale</span>' : '';
  return `<td class="sep">${side.qty}</td><td${unitTitle}>${approx}${usd(side.unit)}</td><td>${reg}${approx}${usd(side.total)}${sale}</td>`;
}

function render() {
  const { kroger, doordash, basket } = data;
  const diff = basket.doordash - basket.kroger;
  $('#stats').innerHTML = `
    <div class="stat"><span class="kr">Kroger cart</span><b>${usd(kroger.total)}</b><span class="sub">${kroger.lines} items, before coupons</span></div>
    <div class="stat"><span class="dd">DoorDash cart</span><b>${usd(doordash.total)}</b><span class="sub">${doordash.lines} items, subtotal before fees</span></div>
    <div class="stat"><span>Same basket at both stores</span>
      <b><span class="kr">${usd(basket.kroger)}</span> vs <span class="dd">${usd(basket.doordash)}</span></b>
      <span class="sub">${basket.items} items priced at both · ${diff >= 0 ? `Kroger is ${usd(diff)} cheaper` : `DoorDash is ${usd(-diff)} cheaper`}${basket.byWeight ? ` · ${basket.byWeight} priced by weight left out` : ''}${basket.excluded ? ` · ${basket.excluded} without a price at one store left out` : ''}</span>
    </div>`;

  const rows = visibleRows();
  $('#rows').innerHTML = rows.map((r) => {
    const d = unitDiff(r);
    // By-weight prices are estimates and the stores may use different units (bunch vs each).
    const rough = r.kroger?.estimated || r.doordash?.estimated;
    const label = d == null ? '' : d === 0 ? 'same' : d > 0 ? `Kroger −${usd(d)}` : `DoorDash −${usd(-d)}`;
    const cheaper = !label || d === 0 ? label
      : rough ? `<span class="muted" title="Priced by weight: estimate, and the stores may sell it by a different unit">≈ ${label}</span>`
        : `<span class="${d > 0 ? 'cheaper-kr' : 'cheaper-dd'}">${label}</span>`;
    const qtyNote = inCart(r.kroger) && inCart(r.doordash) && r.kroger.qty !== r.doordash.qty
      ? '<span class="warn">different quantities: the stores may sell this by a different unit (e.g. bunch vs each)</span>' : '';
    const ddName = r.doordash?.name && r.doordash.name !== r.name ? `<span class="muted" style="display:block;font-size:11px">DoorDash: ${esc(r.doordash.name)}</span>` : '';
    return `<tr>
      <td class="name">${esc(r.name)}${ddName}${qtyNote}</td>
      <td class="l"><code>${esc(r.gtin || '')}</code></td>
      ${cells(r.kroger)}${cells(r.doordash)}
      <td class="sep">${cheaper}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="9" class="l muted">No items match.</td></tr>';

  $('#foot').innerHTML = `<tr>
    <td class="l" colspan="2">Cart totals</td>
    <td class="sep"></td><td></td><td>${usd(kroger.total)}</td>
    <td class="sep"></td><td></td><td>${usd(doordash.total)}</td><td class="sep"></td>
  </tr>`;
  $('#csv').disabled = $('#copy').disabled = false;
}

// ---------- export ----------

const COLUMNS = ['item', 'doordash_item', 'upc', 'kroger_qty', 'kroger_unit_price', 'kroger_line_total', 'kroger_regular_line_total', 'kroger_estimated',
  'doordash_qty', 'doordash_unit_price', 'doordash_line_total', 'doordash_regular_line_total', 'doordash_estimated', 'doordash_minus_kroger_unit'];

function exportRows() {
  return visibleRows().map((r) => ({
    item: r.name,
    doordash_item: r.doordash?.name || '',
    upc: r.gtin || '',
    kroger_qty: inCart(r.kroger) ? r.kroger.qty : 0,
    kroger_unit_price: dollars(r.kroger?.unit),
    kroger_line_total: inCart(r.kroger) ? dollars(r.kroger.total) : '',
    kroger_regular_line_total: dollars(r.kroger?.regularTotal),
    kroger_estimated: r.kroger?.estimated ? 'yes' : '',
    doordash_qty: inCart(r.doordash) ? r.doordash.qty : 0,
    doordash_unit_price: dollars(r.doordash?.unit),
    doordash_line_total: inCart(r.doordash) ? dollars(r.doordash.total) : '',
    doordash_regular_line_total: dollars(r.doordash?.regularTotal),
    doordash_estimated: r.doordash?.estimated ? 'yes' : '',
    doordash_minus_kroger_unit: dollars(unitDiff(r)),
  }));
}

const csvCell = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));

$('#csv').addEventListener('click', () => {
  const rows = exportRows();
  const csv = [COLUMNS.join(','), ...rows.map((r) => COLUMNS.map((c) => csvCell(r[c])).join(','))].join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = `cart-prices-${new Date(data.at).toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
});

$('#copy').addEventListener('click', async () => {
  const rows = exportRows();
  const tsv = [COLUMNS.join('\t'), ...rows.map((r) => COLUMNS.map((c) => String(r[c]).replace(/\t/g, ' ')).join('\t'))].join('\n');
  await navigator.clipboard.writeText(tsv);
  status(`Copied ${rows.length} rows. Paste into Sheets, Numbers or Excel.`);
});

/** Also print it to this page's DevTools console (right-click → Inspect → Console). */
function logTable() {
  console.clear();
  console.log(`Kroger ${usd(data.kroger.total)} · DoorDash ${usd(data.doordash.total)} · same basket: Kroger ${usd(data.basket.kroger)} vs DoorDash ${usd(data.basket.doordash)}`);
  console.table(exportRows());
}

['#filter', '#show', '#sort'].forEach((s) => $(s).addEventListener('input', () => data && render()));
$('#refresh').addEventListener('click', refresh);

// Show the last comparison if there is one; otherwise run one.
chrome.storage.session.get('job').then(({ job }) => {
  if (job?.kind === 'prices' && job.status !== 'error') showJob(job);
  else refresh();
});
