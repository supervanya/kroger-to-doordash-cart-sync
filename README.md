# Kroger ⇄ DoorDash Cart Sync

A Chrome extension that makes one cart match the other: your kroger.com cart and the
DoorDash **Kroger (7350 N Middlebelt Rd)** store cart. It works in either direction.

- **Exact matches.** DoorDash tags every item in this store with Kroger's own 13-digit
  UPC, so items are matched by UPC. Names are never guessed.
- **No clicking through pages.** The extension calls the same APIs the two websites use,
  from inside your logged-in tabs. A sync takes a few seconds.
- **Mirror with preview.** You see every add, quantity change and removal before
  anything is changed.

## Install

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and select this folder.
3. Pin the extension. Stay signed in to kroger.com and doordash.com in this Chrome profile.

## Use

1. Click the extension icon, then **Kroger → DoorDash** or **DoorDash → Kroger**.
2. Review the preview:
   - **Add / Change quantity / Remove**: what will change in the target cart.
   - **Skipped**: items the target store doesn't sell, or items DoorDash sells by weight.
     Weighed items need a weight rather than a count, so set those by hand.
   - **Unidentified DoorDash items**: lines the extension couldn't tie to a UPC. They are
     never removed.
3. Click **Apply changes**. The extension re-reads both carts afterwards and reports
   anything that still differs.

If a Kroger or DoorDash tab isn't open, the extension opens one in the background.

You can close the popup at any time. The work keeps running in the background. Reopen the
popup to see its progress, or the finished preview with **Apply changes** ready. Only one
operation runs at a time. The last result is kept until you start another operation or close
the browser.

## Clear a cart

**Clear Kroger cart** / **Clear DoorDash cart** previews removing every item from that cart,
including DoorDash items the extension can't identify. Nothing is deleted until you click
**Apply changes**. Clearing doesn't match items, so it needs no DoorDash searching. Save the cart
first if you might want it back.

## Saved carts

Save a snapshot of either cart and apply it later to **either** store. Items are stored by UPC,
so a cart saved from Kroger can be applied to DoorDash and the other way round.

1. Optionally type a name, then click **Save Kroger cart** or **Save DoorDash cart**.
2. Click a saved cart to expand it and preview its items.
3. Pick the store to apply it to, then:
   - **Add to cart:** adds missing items and raises any lower quantities. Nothing is removed
     or lowered.
   - **Restore:** makes that cart exactly match the saved one, including removing other items.
4. Review the preview and click **Apply changes**, just like a sync.

Saved carts live in `chrome.storage.local` under `savedCarts`. The **Debug** page lists them.
If a DoorDash item can't be identified when you save, it's left out of the snapshot and
listed under "Not saved".

## Speed and DoorDash's rate limit

DoorDash's cart doesn't include UPCs, and its search can't look an item up by UPC. So the
first time the extension sees an item, it:

1. Loads your DoorDash **Buy it again** page (one request, about 100 past purchases with UPCs).
2. Searches for everything still unmatched in one go, using DoorDash's own **Shop your list**
   page ("Search all your items at once"), and keeps only results whose UPC matches exactly.
   Up to 30 items go in one page request. In testing, one request matched 54 of 56 Kroger
   items in about 9 seconds.

Every item on those pages is saved as a UPC ↔ DoorDash item match (a single list search
typically saves several hundred), so later syncs mostly skip both steps.

DoorDash's regular search allows only about 20 searches per 5 minutes. A list search is one
page request however many items it covers, so a typical sync makes one or two requests. If
DoorDash does block a request (HTTP 429), the extension stops, saves the matches found so far,
and tells you when to retry.

**DoorDash → Kroger safety check:** if any DoorDash item can't be identified, the sync stops
and changes nothing. Otherwise the extension would remove that item from Kroger, thinking it
wasn't in the DoorDash cart.

### What's saved, and when it's refreshed

Matches live in the extension's own storage (`chrome.storage.local`). They survive browser
restarts and aren't affected by clearing kroger.com or doordash.com site data.

- **Known items:** UPC → DoorDash item ID, name, menu ID, price and purchase type, plus
  DoorDash item ID → UPC. Kroger's product ID is the UPC itself. Known items are never
  searched again.
- **Items DoorDash doesn't sell:** remembered for 7 days, so they don't use up searches on
  every sync.
- **Stale matches:** if adding an item to DoorDash fails, its saved match is deleted, the
  item is searched again, and the add is retried once if DoorDash now returns a different
  item ID for that UPC.

**Clear match cache** in the popup forgets everything above.

## How it works

| File | Role |
| --- | --- |
| `background.js` | Finds or opens the tabs, reads both carts, matches items, builds and applies the plan |
| `lib/kroger.js` | Kroger calls: `GET /atlas/v1/carts`, product names, `PUT /atlas/v1/carts/{id}` |
| `lib/doordash.js` | DoorDash: cart read and add / update / remove (GraphQL), item lists from store pages (Buy it again, Shop your list) |
| `lib/sync.js` | Pure diff logic, unit-tested in `lib/sync.test.js` (`npm test`) |
| `content/kroger-laf-capture.js` | Saves the location header Kroger's product API needs |
| `popup.html`, `popup.js` | The popup UI |

These are the websites' internal APIs, not public ones. If Kroger or DoorDash changes its
site, a call may break. The popup shows the error message when that happens.
