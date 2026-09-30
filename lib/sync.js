// Pure diff logic shared by the extension and the unit tests.
// Carts are Maps of gtin13 -> { qty, name, ...extra }.

/**
 * Compute what must change in `target` to match `source`.
 * @param {Map<string,{qty:number,name:string}>} source
 * @param {Map<string,{qty:number,name:string}>} target
 * @param {(gtin:string)=>boolean} availableInTarget  false => item can't be bought at the target store
 * @param {'mirror'|'add'} mode  mirror: target ends up identical to source.
 *   add: only add missing items and raise lower quantities; never lower or remove anything.
 */
export function computeDiff(source, target, availableInTarget = () => true, mode = 'mirror') {
  const add = [], change = [], remove = [], unmatched = [];

  for (const [gtin, s] of source) {
    const t = target.get(gtin);
    if (t) {
      if (mode === 'add' ? t.qty < s.qty : t.qty !== s.qty) change.push({ gtin, name: s.name, from: t.qty, to: s.qty });
    } else if (availableInTarget(gtin)) {
      add.push({ gtin, name: s.name, qty: s.qty });
    } else {
      unmatched.push({ gtin, name: s.name, qty: s.qty });
    }
  }
  if (mode === 'mirror') for (const [gtin, t] of target) {
    if (!source.has(gtin)) remove.push({ gtin, name: t.name, qty: t.qty });
  }
  return { add, change, remove, unmatched };
}

/** Merge duplicate lines for the same gtin into one entry with summed quantity (extra fields kept). */
export function toCartMap(lines) {
  const m = new Map();
  for (const { gtin, qty, name, ...extra } of lines) {
    const prev = m.get(gtin);
    m.set(gtin, { ...extra, ...prev, qty: (prev?.qty || 0) + qty, name: prev?.name || name });
  }
  return m;
}

/** DoorDash item names end with a size in parens, e.g. "Kerrygold Pure Irish Butter (8 oz)". */
export function stripSize(name) {
  return name.replace(/\s*\([^)]*\)\s*$/, '').trim();
}
