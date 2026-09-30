const $ = (s) => document.querySelector(s);
const status = (text, err = false) => { $('#status').textContent = text; $('#status').className = err ? 'err' : ''; };
const send = (msg) => chrome.runtime.sendMessage(msg);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const STORE = { kroger: 'Kroger', doordash: 'DoorDash' };
const secs = (ms) => `${(ms / 1000).toFixed(1)}s`;

// ---------- the current operation ----------
// The background keeps the current job (running / done / error) in session storage, so the popup
// can be closed mid-operation: on reopen it picks up the progress, or shows the finished result.

let ticker = null;
let shownEnd = null; // startedAt of the finished job already rendered (don't redo one-time effects)

function setBusy(on) {
  document.querySelectorAll('[data-dir], [data-clear], [data-save], [data-act="add"], [data-act="restore"]').forEach((b) => { b.disabled = on; });
  if (on) $('#apply').disabled = true;
}

async function showJob(job) {
  clearInterval(ticker);
  if (!job) return;
  if (job.status === 'running') {
    setBusy(true);
    const tick = () => status(`${job.label}… ${Math.floor((Date.now() - job.startedAt) / 1000)}s`);
    tick();
    ticker = setInterval(tick, 250);
    return;
  }
  setBusy(false);
  if (job.status === 'error') return status(job.error, true);
  const first = shownEnd !== job.startedAt;
  shownEnd = job.startedAt;
  if (job.kind === 'preview') await showPreview(job.result);
  else if (job.kind === 'apply') showApplied(job.result);
  else if (job.kind === 'save') await showSaved(job.result, first);
}

/** Start an operation. Results arrive through the job in session storage, not this reply. */
async function start(msg) {
  const res = await send(msg);
  if (!res.ok && res.busy) status(res.error, true);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && changes.job) showJob(changes.job.newValue);
});

// ---------- preview / apply ----------

function section(cls, title, items, qty) {
  if (!items?.length) return '';
  return `<h2 class="${cls}">${title} (${items.length})</h2><ul>${items
    .map((i) => `<li><span class="n" title="${esc(i.name)}">${esc(i.name)}${i.reason ? `<span class="why">${esc(i.reason)}</span>` : ''}</span><span class="q">${qty(i)}</span></li>`)
    .join('')}</ul>`;
}

function render({ target, diff }) {
  const t = STORE[target];
  $('#previewSection').hidden = false;
  $('#diff').innerHTML =
    section('add', `Add to ${t}`, diff.add, (i) => `+${i.qty}`) +
    section('change', `Change quantity in ${t}`, diff.change, (i) => `${i.from} → ${i.to}`) +
    section('remove', `Remove from ${t}`, diff.remove, (i) => `−${i.qty}`) +
    section('unmatched', 'Skipped', diff.unmatched, (i) => `×${i.qty}`) +
    section('untouched', 'Unidentified DoorDash items (left alone)', diff.untouched, (i) => `×${i.qty}`);
  return diff.add.length + diff.change.length + diff.remove.length;
}

async function showPreview(r) {
  const n = render(r);
  if (r.mode === 'clear') {
    status(n
      ? `Apply to remove all ${n} item${n === 1 ? '' : 's'} from ${r.label}. Tip: save the cart first if you might want it back.`
      : `${r.label[0].toUpperCase()}${r.label.slice(1)} is already empty.`);
  } else {
    const verb = r.mode === 'add' ? `add ${r.label} to ${STORE[r.target]}` : `make ${STORE[r.target]} match ${r.label}`;
    status(n ? `${n} change${n === 1 ? '' : 's'} to ${verb} (${secs(r.ms)}).` : `Nothing to do: ${STORE[r.target]} already has it (${secs(r.ms)}).`);
  }
  // The plan to apply is kept separately; it's gone once applied.
  const { plan } = await chrome.storage.session.get('plan');
  $('#apply').disabled = n === 0 || !plan;
}

function showApplied({ failures, remaining, after, ms }) {
  render(after);
  $('#apply').disabled = true;
  if (failures.length) status(`${failures.length} failed: ${failures.map((f) => `${f.name} (${f.error})`).join('; ')}`, true);
  else if (remaining) status(`Applied, but ${remaining} difference${remaining === 1 ? '' : 's'} remain (shown below).`, true);
  else status(`Done (${secs(ms)}).`);
}

function preview(msg) {
  $('#previewSection').hidden = true;
  start(msg);
}

document.querySelectorAll('[data-dir]').forEach((b) =>
  b.addEventListener('click', () => preview({ cmd: 'preview', dir: b.dataset.dir })));

document.querySelectorAll('[data-clear]').forEach((b) =>
  b.addEventListener('click', () => preview({ cmd: 'previewClear', target: b.dataset.clear })));

$('#apply').addEventListener('click', () => {
  $('#apply').disabled = true;
  start({ cmd: 'apply' });
});

// ---------- saved carts ----------

function renderSaved(carts) {
  if (!carts.length) {
    $('#saved').innerHTML = '<p class="muted">No saved carts yet. Save one to add or restore it later in one click.</p>';
    return;
  }
  $('#saved').innerHTML = carts.map((c) => {
    const units = c.items.reduce((n, i) => n + i.qty, 0);
    const other = c.source === 'kroger' ? 'doordash' : 'kroger';
    return `<details data-id="${esc(c.id)}" data-name="${esc(c.name)}">
      <summary>
        <span class="title"><span class="badge ${c.source === 'kroger' ? 'kr' : 'dd'}">${STORE[c.source]}</span>${esc(c.name)}</span>
        <span class="meta">${c.items.length} items · ${units} units · ${new Date(c.savedAt).toLocaleDateString()}</span>
      </summary>
      <div class="cartBody">
        <ul>${c.items.map((i) => `<li><span class="n" title="${esc(i.name)}">${esc(i.name)}</span><span class="q">×${i.qty}</span></li>`).join('')}</ul>
        ${c.skipped?.length ? `<p class="muted">Not saved (couldn't identify): ${c.skipped.map(esc).join(', ')}</p>` : ''}
        <div class="actions">
          <select data-target>
            <option value="${c.source}">${STORE[c.source]}</option>
            <option value="${other}">${STORE[other]}</option>
          </select>
          <button class="small" data-act="add" title="Add these items; raise lower quantities; never remove anything">Add to cart</button>
          <button class="small" data-act="restore" title="Make the cart exactly this saved cart (removes other items)">Restore</button>
          <span class="spacer"></span>
          <button class="small danger" data-act="delete">Delete</button>
        </div>
      </div>
    </details>`;
  }).join('');
}

async function loadSaved() {
  const res = await send({ cmd: 'listSaved' });
  if (res.ok) renderSaved(res.result);
}

async function showSaved(c, first) {
  status(`Saved “${c.name}” (${c.items.length} items${c.skipped.length ? `, ${c.skipped.length} unidentified skipped` : ''}).`);
  await // Restore whatever was happening when the popup was last closed.
loadSaved().then(() => chrome.storage.session.get('job')).then(({ job }) => showJob(job));
  if (first) document.querySelector(`details[data-id="${CSS.escape(c.id)}"]`)?.setAttribute('open', '');
}

document.querySelectorAll('[data-save]').forEach((b) =>
  b.addEventListener('click', () => {
    start({ cmd: 'saveCart', source: b.dataset.save, name: $('#saveName').value.trim() });
    $('#saveName').value = '';
  }));

$('#saved').addEventListener('click', async (e) => {
  const act = e.target.dataset?.act;
  if (!act) return;
  const box = e.target.closest('details');
  const id = box.dataset.id;
  if (act === 'delete') {
    if (!confirm(`Delete saved cart “${box.dataset.name}”?`)) return;
    await send({ cmd: 'deleteSaved', id });
    return // Restore whatever was happening when the popup was last closed.
loadSaved().then(() => chrome.storage.session.get('job')).then(({ job }) => showJob(job));
  }
  const target = box.querySelector('[data-target]').value;
  const mode = act === 'restore' ? 'mirror' : 'add';
  preview({ cmd: 'previewSaved', id, target, mode });
});

// ---------- misc ----------

$('#debug').addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('debug.html') }));
$('#clear').addEventListener('click', async () => {
  await send({ cmd: 'clearCache' });
  status('Match cache cleared.');
});

// Restore whatever was happening when the popup was last closed.
loadSaved().then(() => chrome.storage.session.get('job')).then(({ job }) => showJob(job));
