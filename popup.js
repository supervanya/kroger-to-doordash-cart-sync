const $ = (s) => document.querySelector(s);
const status = (text, err = false) => { $('#status').textContent = text; $('#status').className = err ? 'err' : ''; };
const send = (msg) => chrome.runtime.sendMessage(msg);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const STORE = { kroger: 'Kroger', doordash: 'DoorDash' };
const secs = (ms) => `${(ms / 1000).toFixed(1)}s`;

// While a request runs, show the background's current step with a running timer.
let busyLabel = '';
chrome.runtime.onMessage.addListener((m) => { if (m.type === 'progress') busyLabel = m.text; });

async function busy(msg, text) {
  busyLabel = text;
  const t0 = Date.now();
  const tick = () => status(`${busyLabel}… ${Math.floor((Date.now() - t0) / 1000)}s`);
  tick();
  const timer = setInterval(tick, 250);
  try {
    return await send(msg);
  } finally {
    clearInterval(timer);
  }
}

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

async function preview(msg, busyText) {
  $('#apply').disabled = true;
  $('#previewSection').hidden = true;
  const res = await busy(msg, busyText);
  if (!res.ok) return status(res.error, true);
  const r = res.result;
  const n = render(r);
  const verb = r.mode === 'add' ? `add ${r.label} to ${STORE[r.target]}` : `make ${STORE[r.target]} match ${r.label}`;
  status(n ? `${n} change${n === 1 ? '' : 's'} to ${verb} (${secs(r.ms)}).` : `Nothing to do: ${STORE[r.target]} already has it (${secs(r.ms)}).`);
  $('#apply').disabled = n === 0;
  $('#previewSection').scrollIntoView({ block: 'nearest' });
}

document.querySelectorAll('[data-dir]').forEach((b) =>
  b.addEventListener('click', () => preview({ cmd: 'preview', dir: b.dataset.dir }, 'Reading both carts')));

$('#apply').addEventListener('click', async () => {
  $('#apply').disabled = true;
  const res = await busy({ cmd: 'apply' }, 'Applying');
  if (!res.ok) return status(res.error, true);
  const { failures, remaining, after, ms } = res.result;
  render(after);
  if (failures.length) status(`${failures.length} failed: ${failures.map((f) => `${f.name} (${f.error})`).join('; ')}`, true);
  else if (remaining) status(`Applied, but ${remaining} difference${remaining === 1 ? '' : 's'} remain (shown below).`, true);
  else status(`Done (${secs(ms)}).`);
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

document.querySelectorAll('[data-save]').forEach((b) =>
  b.addEventListener('click', async () => {
    const source = b.dataset.save;
    const res = await busy({ cmd: 'saveCart', source, name: $('#saveName').value.trim() }, `Saving your ${STORE[source]} cart`);
    if (!res.ok) return status(res.error, true);
    const c = res.result;
    $('#saveName').value = '';
    status(`Saved “${c.name}” (${c.items.length} items${c.skipped.length ? `, ${c.skipped.length} unidentified skipped` : ''}).`);
    await loadSaved();
    document.querySelector(`details[data-id="${CSS.escape(c.id)}"]`)?.setAttribute('open', '');
  }));

$('#saved').addEventListener('click', async (e) => {
  const act = e.target.dataset?.act;
  if (!act) return;
  const box = e.target.closest('details');
  const id = box.dataset.id;
  if (act === 'delete') {
    if (!confirm(`Delete saved cart “${box.dataset.name}”?`)) return;
    await send({ cmd: 'deleteSaved', id });
    return loadSaved();
  }
  const target = box.querySelector('[data-target]').value;
  const mode = act === 'restore' ? 'mirror' : 'add';
  preview({ cmd: 'previewSaved', id, target, mode }, `Comparing with your ${STORE[target]} cart`);
});

// ---------- misc ----------

$('#debug').addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('debug.html') }));
$('#clear').addEventListener('click', async () => {
  await send({ cmd: 'clearCache' });
  status('Match cache cleared.');
});

loadSaved();
