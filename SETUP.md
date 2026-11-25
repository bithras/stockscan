# Barcode receiving scanner: setup

Files: `Code.gs` (backend, runs inside the Google Sheet), `index.html` (the phone page, must be served over HTTPS).

## 1. Google Sheet + script (once, ~5 min)
1. Create a new Google Sheet (any name).
2. In the Sheet, open **Extensions → Apps Script**. Delete the sample code, paste all of `Code.gs` and save.
3. In the function dropdown pick **setup** → **Run** → approve the permissions. It asks for access to the Sheet and to "connect to an external service", which is the optional product-name lookup.
4. The **Execution log** shows `App key: …`. Copy it and keep it private.
5. **Deploy → New deployment →** type **Web app**. Execute as: **Me**. Who has access: **Anyone**. Deploy, then copy the **Web app URL** (ends in `/exec`).
   "Anyone" is needed because the phones call it without signing in. Without the app key, every request is refused.

The tabs `Products` and `Log` are created by `setup`. Manual edits to Quantity in the Sheet are logged automatically (simple `onEdit` trigger, no install).

## 2. Phones
Open this once on each phone, in Chrome:
`<PAGE URL>#url=<WEB APP URL>&key=<APP KEY>`
The page saves the settings and removes them from the address bar. Then: Chrome menu → **Add to Home screen**.
Alternative: open the page and enter the URL and key under ⚙.

## CSV export (for Magento later)
`<WEB APP URL>?format=csv&key=<APP KEY>` downloads the Products tab as CSV (`sku,barcode,name,qty`), always up to date.
Only rows that have a SKU are included. Add `&all=1` to include every row. Treat the link like the key: anyone who has it can read the list.

## Updating the script later
Paste the new code → **Deploy → Manage deployments →** ✎ → Version: **New version** → Deploy. The URL stays the same.

## Using it
- **Scanning:**
  - A known code adds +1 to that product's Quantity.
  - The same item counts again only after it has left the camera view for about 1 s, so with several identical items, take the first one away before scanning the next.
  - A new code asks for a name (sometimes pre-filled) and an optional SKU, then saves it with quantity 1.
- **Setting a quantity:** type a number in the quantity field and press **Ορισμός ποσότητας**. It replaces the quantity; it doesn't add to it.
- **The Sheet is the source of truth:** each scan adds 1 to whatever the Sheet holds at that moment. Removing stock is done in the Sheet by hand.
- **No connection:** the scan is **not** recorded (red message plus a buzz). Scan it again.
- **Bluetooth/USB scanner or typing:** use the "πληκτρολόγησε barcode" field.
