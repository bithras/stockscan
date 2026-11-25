/**
 * Barcode receiving scanner: Apps Script backend.
 * Paste into the Google Sheet's Extensions → Apps Script, run setup() once, deploy as a Web app.
 *
 * Products: one row per barcode, running quantity. The Sheet is the source of truth:
 * every scan reads the current cell value and adds 1, so manual edits in the Sheet are respected.
 * Log: one line per change made by the app, plus manual Quantity edits (via the onEdit simple trigger).
 */

const PRODUCTS = 'Products';
const LOG = 'Log';
const HEAD_P = ['Barcode', 'Product name', 'SKU', 'Quantity', 'Last updated'];
const HEAD_L = ['Time', 'Barcode', 'Product name', 'Change', 'New qty', 'Source'];
const COL = { barcode: 1, name: 2, sku: 3, qty: 4, updated: 5 };
const DATE_FMT = 'dd/mm/yyyy hh:mm';

/** Run once from the editor: creates the tabs and the app key (shown in the execution log). */
function setup() {
  const ss = SpreadsheetApp.getActive();
  const p = sheet_(ss, PRODUCTS, HEAD_P);
  p.getRange('A:A').setNumberFormat('@');
  p.getRange('C:C').setNumberFormat('@');
  p.getRange('D:D').setNumberFormat('0');
  p.getRange('E:E').setNumberFormat(DATE_FMT);
  const l = sheet_(ss, LOG, HEAD_L);
  l.getRange('A:A').setNumberFormat(DATE_FMT + ':ss');
  l.getRange('B:B').setNumberFormat('@');

  const props = PropertiesService.getScriptProperties();
  let key = props.getProperty('API_KEY');
  if (!key) {
    key = Utilities.getUuid().replace(/-/g, '');
    props.setProperty('API_KEY', key);
  }
  Logger.log('App key: ' + key);
}

function sheet_(ss, name, head) {
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  if (!sh.getRange(1, 1).getValue()) {
    sh.getRange(1, 1, 1, head.length).setValues([head]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

function doGet() {
  return json_({ ok: true, app: 'barcode-scanner' });
}

function doPost(e) {
  let out;
  try {
    const req = JSON.parse(e.postData.contents);
    const key = PropertiesService.getScriptProperties().getProperty('API_KEY');
    if (!key || req.key !== key) throw new Error('Λάθος κλειδί εφαρμογής');
    out = handle_(req);
  } catch (err) {
    out = { ok: false, error: String((err && err.message) || err) };
  }
  return json_(out);
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

function handle_(req) {
  if (req.action === 'ping') return { ok: true };

  const code = normalize_(req.barcode, req.format);
  if (!code) throw new Error('Κενό barcode');
  const warning = checkDigitOk_(code) ? '' : 'Προσοχή: το barcode ' + code + ' δεν περνά τον έλεγχο (λάθος ανάγνωση/πληκτρολόγηση;)';

  let res;
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sh = SpreadsheetApp.getActive().getSheetByName(PRODUCTS);
    if (!sh) throw new Error('Δεν υπάρχει η καρτέλα Products — τρέξε το setup()');
    const row = findRow_(sh, COL.barcode, code);

    switch (req.action) {
      case 'get':
        res = row ? { ok: true, product: read_(sh, row) } : { ok: true, unknown: true, barcode: code };
        break;

      case 'scan':
        res = row ? { ok: true, product: add_(sh, row, 1) } : { ok: true, unknown: true, barcode: code };
        break;

      case 'create': {
        if (row) { // someone created it in the meantime → count this one as a scan
          res = { ok: true, product: add_(sh, row, 1), note: 'Υπήρχε ήδη — προστέθηκε +1' };
          break;
        }
        const name = String(req.name || '').trim();
        const sku = String(req.sku || '').trim();
        if (!name) throw new Error('Χρειάζεται όνομα προϊόντος');
        const qty = toQty_(req.qty == null ? 1 : req.qty);
        const dup = sku ? findRow_(sh, COL.sku, sku) : 0;
        const r = sh.getLastRow() + 1;
        const range = sh.getRange(r, 1, 1, 5);
        range.setNumberFormats([['@', '@', '@', '0', DATE_FMT]]);
        range.setValues([[code, name, sku, qty, new Date()]]);
        log_(code, name, 'νέο προϊόν, ποσ. ' + qty, qty, 'app');
        res = { ok: true, product: read_(sh, r), created: true };
        if (dup) res.note = 'Προσοχή: το SKU ' + sku + ' υπάρχει ήδη σε άλλο barcode (γραμμή ' + dup + ')';
        break;
      }

      case 'setQty': {
        if (!row) throw new Error('Το barcode δεν υπάρχει στη λίστα');
        const n = toQty_(req.qty);
        const old = Number(sh.getRange(row, COL.qty).getValue()) || 0;
        sh.getRange(row, COL.qty).setValue(n);
        sh.getRange(row, COL.updated).setValue(new Date());
        const p = read_(sh, row);
        log_(code, p.name, 'ορίστηκε ' + old + ' → ' + n, n, 'app');
        res = { ok: true, product: p };
        break;
      }

      default:
        throw new Error('Άγνωστη ενέργεια: ' + req.action);
    }
  } finally {
    lock.releaseLock();
  }

  if (res.unknown) res.hint = hint_(code); // outside the lock: external call
  if (warning) res.warning = warning;
  return res;
}

function add_(sh, row, n) {
  const cell = sh.getRange(row, COL.qty);
  const q = (Number(cell.getValue()) || 0) + n; // current Sheet value, never a cached one
  cell.setValue(q);
  sh.getRange(row, COL.updated).setValue(new Date());
  const p = read_(sh, row);
  log_(p.barcode, p.name, '+' + n, q, 'app');
  return p;
}

function read_(sh, row) {
  const v = sh.getRange(row, 1, 1, 4).getDisplayValues()[0];
  return { barcode: v[0], name: v[1], sku: v[2], qty: Number(v[3]) || 0 };
}

function findRow_(sh, col, value) {
  const last = sh.getLastRow();
  if (last < 2) return 0;
  const hit = sh.getRange(2, col, last - 1, 1).createTextFinder(value).matchEntireCell(true).findNext();
  return hit ? hit.getRow() : 0;
}

function toQty_(v) {
  const n = Number(v);
  if (!isFinite(n) || n < 0 || Math.floor(n) !== n) throw new Error('Η ποσότητα πρέπει να είναι ακέραιος ≥ 0');
  return n;
}

function log_(code, name, change, qty, source) {
  const sh = SpreadsheetApp.getActive().getSheetByName(LOG);
  if (!sh) return;
  const r = sh.getLastRow() + 1;
  const range = sh.getRange(r, 1, 1, 6);
  range.setNumberFormats([[DATE_FMT + ':ss', '@', '@', '@', '0', '@']]);
  range.setValues([[new Date(), code, name, change, qty, source]]);
}

/**
 * One barcode = one text form. Numeric codes become 13 digits (UPC-A 12 → leading 0,
 * GTIN-14 with leading 0 → 13); UPC-E is expanded to its full UPC-A first. EAN-8 stays 8.
 * Other symbologies (Code 128 etc.) are kept as read, upper-cased.
 */
function normalize_(raw, format) {
  let s = String(raw == null ? '' : raw).trim().toUpperCase().replace(/\s+/g, '');
  if (!/^\d+$/.test(s)) return s;
  if (format === 'upc_e' && s.length === 8) s = upcEtoA_(s);
  if (s.length === 14 && s[0] === '0') s = s.slice(1);
  if (s.length === 12) s = '0' + s;
  return s;
}

function upcEtoA_(e) {
  const n = e[0], d = e.slice(1, 7), c = e[7], x = d[5];
  let m;
  if (x === '0' || x === '1' || x === '2') m = d.slice(0, 2) + x + '0000' + d.slice(2, 5);
  else if (x === '3') m = d.slice(0, 3) + '00000' + d.slice(3, 5);
  else if (x === '4') m = d.slice(0, 4) + '00000' + d[4];
  else m = d.slice(0, 5) + '0000' + x;
  return n + m + c;
}

/** GS1 check digit for 8/13-digit codes; anything else is not checked. */
function checkDigitOk_(s) {
  if (!/^\d+$/.test(s) || (s.length !== 8 && s.length !== 13)) return true;
  const body = s.slice(0, -1);
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    const fromRight = body.length - i; // weights 3,1,3,... from the right
    sum += Number(body[i]) * (fromRight % 2 ? 3 : 1);
  }
  return (10 - (sum % 10)) % 10 === Number(s.slice(-1));
}

/** Name suggestion from a free public database; empty if unknown or rate-limited. */
function hint_(code) {
  if (!/^\d{8,14}$/.test(code)) return '';
  try {
    const r = UrlFetchApp.fetch('https://api.upcitemdb.com/prod/trial/lookup?upc=' + code, { muteHttpExceptions: true });
    if (r.getResponseCode() !== 200) return '';
    const it = (JSON.parse(r.getContentText()).items || [])[0];
    if (!it) return '';
    const brand = String(it.brand || '').trim();
    const title = String(it.title || '').trim();
    return (title.toLowerCase().indexOf(brand.toLowerCase()) === -1 ? brand + ' ' : '') + title;
  } catch (e) {
    return '';
  }
}

/** Simple trigger: logs manual Quantity edits in the Sheet and stamps Last updated. Not fired by the script's own writes. */
function onEdit(e) {
  const r = e.range, sh = r.getSheet();
  if (sh.getName() !== PRODUCTS || r.getLastRow() < 2) return;
  const c1 = r.getColumn(), c2 = r.getLastColumn();
  if (c2 < COL.qty || c1 > COL.qty) return; // Quantity column not touched

  const first = Math.max(r.getRow(), 2), last = r.getLastRow();
  for (let row = first; row <= last; row++) {
    const v = sh.getRange(row, 1, 1, 4).getDisplayValues()[0];
    if (!v[0]) continue;
    const single = r.getNumRows() === 1 && r.getNumColumns() === 1;
    const old = single && e.oldValue !== undefined ? e.oldValue : '?';
    sh.getRange(row, COL.updated).setValue(new Date());
    log_(v[0], v[1], 'χειροκίνητα ' + old + ' → ' + v[3], Number(v[3]) || 0, 'sheet');
  }
}
