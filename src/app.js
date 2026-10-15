/* QR-Scanner · TekiDeki - application logic
 * SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Kristian Mario Miskovic (TekiDeki)
 *
 * Decoding: native BarcodeDetector when the browser has it, ZXing (bundled
 * below in this same page, Apache-2.0) as the fallback for everyone else.
 * Product data: Open Food Facts, queried only for product codes, only when
 * enrichment is enabled, with a local cache and honest offline behaviour.
 */
(function () {
  'use strict';

  // ---------- short helpers ----------
  const $ = id => document.getElementById(id);
  const el = (tag, opts = {}, children = []) => {
    const node = document.createElement(tag);
    if (opts.class) node.className = opts.class;
    if (opts.text !== undefined) node.textContent = opts.text;
    if (opts.attrs) for (const [k, v] of Object.entries(opts.attrs)) node.setAttribute(k, v);
    if (opts.on) for (const [k, v] of Object.entries(opts.on)) node.addEventListener(k, v);
    for (const child of children) node.appendChild(child);
    return node;
  };

  let currentLang = 'en';
  function t(key, vars) {
    const dict = I18N[currentLang] || I18N.en;
    let text = dict[key];
    if (text === undefined) text = (I18N.en[key] !== undefined ? I18N.en[key] : key);
    if (vars) for (const [k, v] of Object.entries(vars)) text = text.replace(new RegExp('\\{' + k + '\\}', 'g'), String(v));
    return text;
  }
  const locale = () => LOCALES[currentLang] || 'en-GB';
  const fmtCount = n => new Intl.NumberFormat(locale(), { maximumFractionDigits: 0 }).format(Number(n) || 0);
  const fmtDateTime = ts => new Intl.DateTimeFormat(locale(), { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(ts));

  // ---------- storage ----------
  const KEYS = {
    history: 'qr_scanner_history_v1',
    cache: 'qr_scanner_products_v1',
    settings: 'qr_scanner_settings_v1',
  };
  const BACKUP_PREFIX = 'qr_scanner_history_v1_backup_';
  const HISTORY_MAX = 500;
  const CACHE_MAX = 300;
  const CACHE_TTL = 30 * 24 * 60 * 60 * 1000;
  const FILE_MAX = 12 * 1024 * 1024;

  const memory = {};
  let storageWorks = true;
  try {
    localStorage.setItem('__qr_probe__', '1');
    localStorage.removeItem('__qr_probe__');
  } catch (e) { storageWorks = false; }

  function storeGet(key) {
    if (!storageWorks) return memory[key] !== undefined ? memory[key] : null;
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }
  function storeSet(key, value) {
    if (!storageWorks) { memory[key] = value; return false; }
    try { localStorage.setItem(key, value); return true; } catch (e) { return false; }
  }
  function storeRemove(key) {
    if (!storageWorks) { delete memory[key]; return; }
    try { localStorage.removeItem(key); } catch (e) { /* ignore */ }
  }

  let dataState = 'ok';        // ok | memory | unreadable
  let skippedEntries = 0;
  let rawHistoryStored = null;

  // ---------- settings ----------
  const DEFAULT_SETTINGS = { dark: null, enrich: true, vibrate: true, sound: true, lang: null, continuous: false };
  let settings = Object.assign({}, DEFAULT_SETTINGS);
  function loadSettings() {
    const raw = storeGet(KEYS.settings);
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          settings = Object.assign({}, DEFAULT_SETTINGS, {
            dark: typeof parsed.dark === 'boolean' ? parsed.dark : null,
            enrich: parsed.enrich !== false,
            vibrate: parsed.vibrate !== false,
            sound: parsed.sound !== false,
            lang: I18N[parsed.lang] ? parsed.lang : null,
            continuous: parsed.continuous === true,
          });
        }
      } catch (e) { /* keep defaults */ }
    }
  }
  function saveSettings() {
    storeSet(KEYS.settings, JSON.stringify(settings));
  }

  // ---------- history ----------
  let history = [];
  function validEntry(entry) {
    return entry && typeof entry === 'object'
      && typeof entry.code === 'string' && entry.code.length > 0 && entry.code.length <= 4096
      && Number.isFinite(entry.ts) && entry.ts > 0
      && typeof entry.format === 'string'
      && typeof entry.type === 'string';
  }
  function loadHistory() {
    const raw = storeGet(KEYS.history);
    rawHistoryStored = raw;
    skippedEntries = 0;
    if (raw === null || raw === '') { dataState = storageWorks ? 'ok' : 'memory'; history = []; return; }
    if (!storageWorks) { try { const parsed = JSON.parse(raw); history = Array.isArray(parsed) ? parsed.filter(validEntry) : []; } catch (e) { history = []; } dataState = 'memory'; return; }
    let parsed;
    try { parsed = JSON.parse(raw); } catch (e) { dataState = 'unreadable'; history = []; return; }
    if (!Array.isArray(parsed)) { dataState = 'unreadable'; history = []; return; }
    const kept = [];
    for (const item of parsed) {
      if (validEntry(item)) kept.push(item); else skippedEntries++;
    }
    kept.sort((a, b) => b.ts - a.ts);
    history = kept.slice(0, HISTORY_MAX);
    dataState = 'ok';
    if (skippedEntries > 0) {
      storeSet(KEYS.history, JSON.stringify(history));
      rawHistoryStored = raw;
    }
  }
  function persistHistory() {
    if (dataState === 'unreadable') return false;
    const ok = storeSet(KEYS.history, JSON.stringify(history));
    if (!ok && storageWorks) {
      storageWorks = false;
      dataState = 'memory';
      refreshBanner();
      toast(t('banner_memory'));
    }
    return true;
  }
  function addHistory(entry) {
    if (dataState === 'unreadable') {
      // The old data is preserved; a new entry must never overwrite it silently.
      toast(t('banner_unreadable'));
      return false;
    }
    history.unshift(entry);
    if (history.length > HISTORY_MAX) history = history.slice(0, HISTORY_MAX);
    persistHistory();
    renderHistory();
    return true;
  }
  function removeHistory(id) {
    history = history.filter(item => item.id !== id);
    persistHistory();
    renderHistory();
  }
  function duplicateHistoryKey(entry) { return entry.code + '|' + entry.format + '|' + entry.ts; }

  // ---------- product cache ----------
  let productCache = {};
  function loadCache() {
    const raw = storeGet(KEYS.cache);
    if (!raw) { productCache = {}; return; }
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) productCache = parsed;
    } catch (e) { productCache = {}; }
  }
  function saveCache() {
    const keys = Object.keys(productCache);
    if (keys.length > CACHE_MAX) {
      keys.sort((a, b) => (productCache[b].ts || 0) - (productCache[a].ts || 0));
      const trimmed = {};
      for (const k of keys.slice(0, CACHE_MAX)) trimmed[k] = productCache[k];
      productCache = trimmed;
    }
    storeSet(KEYS.cache, JSON.stringify(productCache));
  }
  function cacheGet(code) {
    const hit = productCache[code];
    if (!hit || typeof hit !== 'object') return null;
    return hit;
  }
  function cacheSet(code, product) {
    productCache[code] = { ts: Date.now(), p: product };
    saveCache();
    updateCacheCount();
  }

  // ---------- banner / toast / dialog ----------
  let bannerActions = [];
  function setBanner(kind, text, actions) {
    const banner = $('statusBanner'), textEl = $('statusText'), actionsEl = $('statusActions');
    if (!text) { banner.hidden = true; textEl.textContent = ''; actionsEl.textContent = ''; bannerActions = []; return; }
    banner.className = 'status-banner' + (kind ? ' ' + kind : '');
    textEl.textContent = text;
    actionsEl.textContent = '';
    bannerActions = actions || [];
    bannerActions.forEach((action, index) => {
      actionsEl.appendChild(el('button', {
        class: index === 0 ? 'btn-primary btn-sm' : 'btn-ghost btn-sm',
        text: action.label,
        attrs: { type: 'button', 'data-banner-action': String(index) },
      }));
    });
    banner.hidden = false;
  }
  function refreshBanner() {
    if (dataState === 'memory') {
      setBanner('', t('banner_memory'), [{ label: t('action_export'), run: exportHistory }]);
      return;
    }
    if (dataState === 'unreadable') {
      setBanner('danger', t('banner_unreadable'), [
        { label: t('action_download_raw'), run: downloadRawHistory },
        { label: t('action_start_fresh'), run: startFreshHistory },
        { label: t('action_retry'), run: () => { loadHistory(); renderHistory(); refreshBanner(); } },
      ]);
      return;
    }
    if (skippedEntries > 0) {
      setBanner('info', skippedEntries === 1 ? t('banner_skipped_one') : t('banner_skipped_many', { n: fmtCount(skippedEntries) }), [{ label: t('action_download_raw'), run: downloadRawHistory }]);
      return;
    }
    setBanner(null, '');
  }
  let toastTimer = null;
  function toast(message) {
    const node = $('toast');
    node.textContent = message;
    node.hidden = false;
    node.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      node.classList.remove('show');
      setTimeout(() => { node.hidden = true; }, 250);
    }, 2800);
  }
  function askConfirm(title, body, confirmLabel, danger) {
    return new Promise(resolve => {
      const dialog = $('appDialog');
      if (!dialog || typeof dialog.showModal !== 'function') { resolve(window.confirm(title + '\n\n' + (body || ''))); return; }
      $('appDialogTitle').textContent = title;
      $('appDialogBody').textContent = body || '';
      const confirmBtn = $('appDialogConfirm'), cancelBtn = $('appDialogCancel');
      confirmBtn.textContent = confirmLabel || t('confirm');
      confirmBtn.className = danger ? 'btn-danger' : 'btn-primary';
      cancelBtn.textContent = t('cancel');
      const close = result => {
        confirmBtn.removeEventListener('click', onConfirm);
        cancelBtn.removeEventListener('click', onCancel);
        dialog.removeEventListener('close', onClose);
        if (dialog.open) dialog.close();
        resolve(result);
      };
      const onConfirm = () => close(true);
      const onCancel = () => close(false);
      const onClose = () => close(false);
      confirmBtn.addEventListener('click', onConfirm);
      cancelBtn.addEventListener('click', onCancel);
      dialog.addEventListener('close', onClose);
      dialog.showModal();
      confirmBtn.focus();
    });
  }

  // ---------- decoding ----------
  const NATIVE_FORMATS = ['qr_code', 'data_matrix', 'aztec', 'pdf417', 'ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'code_93', 'itf', 'codabar'];
  const ZXING_FORMAT_NAMES = ['QR_CODE', 'DATA_MATRIX', 'AZTEC', 'PDF_417', 'EAN_13', 'EAN_8', 'UPC_A', 'UPC_E', 'CODE_128', 'CODE_39', 'CODE_93', 'ITF', 'CODABAR'];
  const PRODUCT_FORMATS = new Set(['EAN_13', 'EAN_8', 'UPC_A', 'UPC_E']);

  let nativeDetector = null;
  let zxingReader = null;
  let engineLabel = 'zxing';

  async function initDecoder() {
    if ('BarcodeDetector' in window) {
      try {
        const supported = await window.BarcodeDetector.getSupportedFormats();
        const usable = NATIVE_FORMATS.filter(f => supported.includes(f));
        if (usable.length) {
          nativeDetector = new window.BarcodeDetector({ formats: usable });
          engineLabel = 'native';
        }
      } catch (e) { nativeDetector = null; }
    }
    if (window.ZXing) {
      zxingReader = new ZXing.MultiFormatReader();
      const hints = new Map();
      const formats = ZXING_FORMAT_NAMES.filter(name => ZXing.BarcodeFormat[name] !== undefined).map(name => ZXing.BarcodeFormat[name]);
      if (formats.length) hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, formats);
      hints.set(ZXing.DecodeHintType.TRY_HARDER, true);
      zxingReader.setHints(hints);
    }
    updateEngineNote();
  }
  function updateEngineNote() {
    const node = $('engineNote');
    if (!node) return;
    const hasNative = engineLabel === 'native';
    node.textContent = (hasNative ? (currentLang === 'ro' ? 'Motor: nativ + ZXing' : currentLang === 'sr-latn' ? 'Motor: nativni + ZXing' : currentLang === 'sr-cyrl' ? 'Мотор: нативни + ZXing' : 'Engine: native + ZXing')
      : (currentLang === 'ro' ? 'Motor: ZXing (inclus)' : currentLang === 'sr-latn' ? 'Motor: ZXing (ugrađen)' : currentLang === 'sr-cyrl' ? 'Мотор: ZXing (уграђен)' : 'Engine: ZXing (bundled)'));
  }

  function ensureZxing() {
    if (zxingReader || !window.ZXing) return;
    try {
      zxingReader = new ZXing.MultiFormatReader();
      const hints = new Map();
      const formats = ZXING_FORMAT_NAMES.filter(name => ZXing.BarcodeFormat[name] !== undefined).map(name => ZXing.BarcodeFormat[name]);
      if (formats.length) hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, formats);
      hints.set(ZXing.DecodeHintType.TRY_HARDER, true);
      zxingReader.setHints(hints);
    } catch (e) { zxingReader = null; }
  }
  function zxingDecode(canvas) {
    ensureZxing();
    if (!zxingReader) return null;
    const binarizers = [ZXing.HybridBinarizer, ZXing.GlobalHistogramBinarizer];
    const inversions = [false, true];
    for (const invert of inversions) {
      for (const Binarizer of binarizers) {
        try {
          const source = new ZXing.HTMLCanvasElementLuminanceSource(canvas, invert);
          const bitmap = new ZXing.BinaryBitmap(new Binarizer(source));
          const result = zxingReader.decode(bitmap);
          const text = result.getText();
          if (text) return { text, format: ZXing.BarcodeFormat[result.getBarcodeFormat()] || 'UNKNOWN' };
        } catch (e) { /* keep trying */ }
      }
    }
    return null;
  }

  const nativeFormatMap = {
    qr_code: 'QR_CODE', data_matrix: 'DATA_MATRIX', aztec: 'AZTEC', pdf417: 'PDF_417',
    ean_13: 'EAN_13', ean_8: 'EAN_8', upc_a: 'UPC_A', upc_e: 'UPC_E',
    code_128: 'CODE_128', code_39: 'CODE_39', code_93: 'CODE_93', itf: 'ITF', codabar: 'CODABAR',
  };

  async function decodeCanvas(canvas) {
    if (nativeDetector) {
      try {
        const found = await nativeDetector.detect(canvas);
        if (found && found.length) {
          const raw = found[0].rawValue;
          if (raw) return { text: raw, format: nativeFormatMap[found[0].format] || String(found[0].format).toUpperCase() };
        }
      } catch (e) { /* fall through to the library */ }
    }
    return zxingDecode(canvas);
  }

  // ---------- content classification ----------
  function classify(text, format) {
    const raw = String(text || '');
    if (PRODUCT_FORMATS.has(format) && /^\d{8,14}$/.test(raw.trim())) return { type: 'product', code: raw.trim() };
    if (/^https?:\/\//i.test(raw)) return { type: 'link', url: raw, safe: /^https:/i.test(raw) };
    if (/^www\.[^\s]+\.[a-z]{2,}/i.test(raw)) return { type: 'link', url: 'https://' + raw, safe: true };
    const wifi = raw.match(/^WIFI:/i);
    if (wifi) return { type: 'wifi', wifi: parseWifi(raw) };
    if (/^BEGIN:VCARD/i.test(raw)) return { type: 'vcard', card: parseVCard(raw) };
    if (/^mailto:/i.test(raw)) return { type: 'email', email: raw.slice(7).split('?')[0] };
    if (/^MATMSG:/i.test(raw)) {
      const to = (raw.match(/TO:([^;]*)/i) || [])[1] || '';
      return { type: 'email', email: to };
    }
    if (/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(raw.trim())) return { type: 'email', email: raw.trim() };
    if (/^tel:/i.test(raw)) return { type: 'phone', phone: raw.slice(4).trim() };
    if (/^SMSTO:/i.test(raw)) {
      const parts = raw.slice(6).split(':');
      return { type: 'sms', phone: (parts[0] || '').trim(), body: (parts.slice(1).join(':') || '').trim() };
    }
    if (/^smsto:/i.test(raw)) {
      const parts = raw.slice(6).split(':');
      return { type: 'sms', phone: (parts[0] || '').trim(), body: (parts.slice(1).join(':') || '').trim() };
    }
    if (/^geo:/i.test(raw)) {
      const m = raw.match(/^geo:(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/i);
      if (m) return { type: 'geo', lat: m[1], lng: m[2] };
    }
    if (/^\+?[\d][\d\s().-]{6,}$/.test(raw.trim())) return { type: 'phone', phone: raw.trim() };
    return { type: 'text' };
  }
  function parseWifi(raw) {
    const out = { ssid: '', password: '', security: '', hidden: false };
    const fields = raw.replace(/^WIFI:/i, '').split(';');
    for (const field of fields) {
      const idx = field.indexOf(':');
      if (idx < 0) continue;
      const key = field.slice(0, idx).toUpperCase();
      const value = field.slice(idx + 1);
      if (key === 'S') out.ssid = value;
      else if (key === 'P') out.password = value;
      else if (key === 'T') out.security = value;
      else if (key === 'H') out.hidden = /^true$/i.test(value);
    }
    return out;
  }
  function parseVCard(raw) {
    const pick = prefix => {
      const re = new RegExp('^' + prefix + '[^:]*:(.*)$', 'im');
      const m = raw.match(re);
      return m ? m[1].trim() : '';
    };
    const name = (raw.match(/^FN[^:]*:(.*)$/im) || [])[1];
    return {
      name: name ? name.trim() : '',
      org: pick('ORG'),
      tel: (raw.match(/^TEL[^:]*:(.*)$/im) || [])[1] || '',
      email: (raw.match(/^EMAIL[^:]*:(.*)$/im) || [])[1] || '',
      url: pick('URL'),
      raw,
    };
  }

  // ---------- result rendering ----------
  let currentResult = null;
  let lastDetection = { code: null, ts: 0 };

  function typeLabel(type) {
    const map = { link: 'type_link', text: 'type_text', wifi: 'type_wifi', vcard: 'type_vcard', email: 'type_email', phone: 'type_phone', sms: 'type_sms', geo: 'type_geo', product: 'type_product' };
    return t(map[type] || 'type_unknown');
  }

  function renderResult(result) {
    currentResult = result;
    const panel = $('resultPanel');
    panel.textContent = '';
    panel.classList.remove('flash');
    if (!result) {
      panel.appendChild(el('p', { class: 'muted', text: t('no_result_yet') }));
      return;
    }
    const head = el('div', { class: 'result-head' }, [
      el('h3', { text: t('result_title'), attrs: { tabindex: '-1', id: 'resultHeading' } }),
      el('div', { class: 'badges' }, [
        el('span', { class: 'badge', text: result.format || '' }),
        el('span', { class: 'badge badge-type', text: typeLabel(result.type) }),
      ]),
    ]);
    panel.appendChild(head);
    panel.appendChild(el('p', { class: 'small muted', text: t('code_label') }));
    panel.appendChild(el('div', { class: 'code-value', text: result.code }));

    const actions = el('div', { class: 'actions' });
    const addButton = (label, handler, primary) => actions.appendChild(el('button', { class: (primary ? 'btn-primary' : 'btn-ghost'), text: label, attrs: { type: 'button' }, on: { click: handler } }));
    const copyButton = (value, label) => addButton(label || t('action_copy'), async () => { await copyText(value); toast(t('action_copied')); });

    if (result.type === 'link') {
      addButton(t('action_open_link'), () => window.open(result.url, '_blank', 'noopener'), true);
      copyButton(result.url, t('action_copy_link'));
      if (navigator.share) addButton(t('action_share'), () => navigator.share({ text: result.url }).catch(() => {}));
      panel.appendChild(el('p', { class: 'small muted', text: t('action_link_safe') }));
    } else if (result.type === 'wifi') {
      const w = result.wifi || {};
      const dl = el('dl', { class: 'kv' });
      if (w.ssid) { dl.appendChild(el('dt', { text: t('wifi_ssid') })); dl.appendChild(el('dd', { text: w.ssid })); }
      dl.appendChild(el('dt', { text: t('wifi_password') }));
      dl.appendChild(el('dd', { text: w.password ? w.password : t('wifi_no_password') }));
      if (w.security) { dl.appendChild(el('dt', { text: t('wifi_security') })); dl.appendChild(el('dd', { text: w.security })); }
      if (w.hidden) { dl.appendChild(el('dt', { text: t('wifi_hidden') })); dl.appendChild(el('dd', { text: 'da / yes' })); }
      panel.appendChild(dl);
      if (w.password) addButton(t('wifi_copy_password'), async () => { await copyText(w.password); toast(t('action_copied')); }, true);
      addButton(t('action_copy'), async () => { await copyText(result.code); toast(t('action_copied')); });
      panel.appendChild(el('p', { class: 'small muted', text: t('wifi_note') }));
    } else if (result.type === 'vcard') {
      const c = result.card || {};
      const dl = el('dl', { class: 'kv' });
      if (c.name) { dl.appendChild(el('dt', { text: t('vcard_name') })); dl.appendChild(el('dd', { text: c.name })); }
      if (c.org) { dl.appendChild(el('dt', { text: t('vcard_org') })); dl.appendChild(el('dd', { text: c.org })); }
      if (c.tel) { dl.appendChild(el('dt', { text: t('vcard_tel') })); dl.appendChild(el('dd', { text: c.tel })); }
      if (c.email) { dl.appendChild(el('dt', { text: t('vcard_email') })); dl.appendChild(el('dd', { text: c.email })); }
      if (c.url) { dl.appendChild(el('dt', { text: t('vcard_url') })); dl.appendChild(el('dd', { text: c.url })); }
      panel.appendChild(dl);
      addButton(t('action_download_vcf'), () => downloadVCard(c), true);
      if (c.tel) addButton(t('action_call'), () => { window.location.href = 'tel:' + c.tel.replace(/[^\d+]/g, ''); });
      if (c.email) addButton(t('action_write_email'), () => { window.location.href = 'mailto:' + c.email; });
      panel.appendChild(el('p', { class: 'small muted', text: t('vcard_note') }));
    } else if (result.type === 'email') {
      addButton(t('action_write_email'), () => { window.location.href = 'mailto:' + result.email; }, true);
      copyButton(result.email);
    } else if (result.type === 'phone') {
      addButton(t('action_call'), () => { window.location.href = 'tel:' + result.phone.replace(/[^\d+]/g, ''); }, true);
      copyButton(result.phone);
    } else if (result.type === 'sms') {
      addButton(t('action_send_sms'), () => { window.location.href = 'sms:' + result.phone + (result.body ? '?body=' + encodeURIComponent(result.body) : ''); }, true);
      copyButton(result.phone);
    } else if (result.type === 'geo') {
      addButton(t('action_open_map'), () => window.open('https://www.openstreetmap.org/?mlat=' + encodeURIComponent(result.lat) + '&mlon=' + encodeURIComponent(result.lng) + '#map=17/' + encodeURIComponent(result.lat) + '/' + encodeURIComponent(result.lng), '_blank', 'noopener'), true);
      copyButton(result.lat + ',' + result.lng);
    } else if (result.type === 'product') {
      copyButton(result.code, t('action_copy'));
      addButton(t('product_open'), () => window.open('https://world.openfoodfacts.org/product/' + encodeURIComponent(result.code), '_blank', 'noopener'));
      renderProduct(panel, result.code);
    } else {
      copyButton(result.code);
      if (navigator.share) addButton(t('action_share'), () => navigator.share({ text: result.code }).catch(() => {}));
    }
    panel.appendChild(actions);
    if (result.fresh) {
      panel.classList.add('flash');
      const heading = $('resultHeading');
      if (heading) heading.focus({ preventScroll: false });
    }
  }

  // ---------- Open Food Facts ----------
  const OFF_FIELDS = 'code,product_name,brands,quantity,nutriscore_grade,nova_group,ingredients_text,allergens,image_front_small_url';
  let productRequestId = 0;

  async function renderProduct(panel, code) {
    const box = el('div', { class: 'product-block' });
    panel.appendChild(box);
    const cached = cacheGet(code);
    if (!settings.enrich) {
      box.appendChild(el('p', { class: 'small muted', text: t('product_disabled') }));
      return;
    }
    if (cached && cached.p && (Date.now() - cached.ts) < CACHE_TTL) {
      drawProduct(box, cached.p, code, true, cached.ts);
      return;
    }
    if (!navigator.onLine) {
      if (cached && cached.p) drawProduct(box, cached.p, code, true, cached.ts);
      else box.appendChild(el('p', { class: 'small muted', text: t('product_offline') }));
      return;
    }
    const loading = el('p', { class: 'small muted', attrs: { 'aria-live': 'polite' } }, [
      el('span', { class: 'spinner', attrs: { 'aria-hidden': 'true' } }),
      el('span', { text: ' ' + t('product_lookup') }),
    ]);
    box.appendChild(loading);
    const requestId = ++productRequestId;
    try {
      const url = 'https://world.openfoodfacts.org/api/v2/product/' + encodeURIComponent(code) + '.json?fields=' + OFF_FIELDS;
      const response = await fetch(url, { headers: { 'X-User-Agent': 'QR-Scanner/1.0 (+https://tekideki.github.io/QR-Scanner/)' } });
      if (requestId !== productRequestId) return;
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const doc = await response.json();
      box.textContent = '';
      if (doc && doc.status === 1 && doc.product) {
        cacheSet(code, doc.product);
        drawProduct(box, doc.product, code, false, Date.now());
      } else {
        box.appendChild(el('p', { class: 'small muted', text: t('product_not_found') }));
        box.appendChild(el('p', { class: 'small muted', text: t('product_not_found_hint') }));
        box.appendChild(el('p', {}, [el('a', { text: t('product_add'), attrs: { href: 'https://world.openfoodfacts.org/cgi/product.pl?type=add&code=' + encodeURIComponent(code), target: '_blank', rel: 'noopener noreferrer' } })]));
      }
    } catch (e) {
      if (requestId !== productRequestId) return;
      box.textContent = '';
      if (cached && cached.p) drawProduct(box, cached.p, code, true, cached.ts);
      else {
        box.appendChild(el('p', { class: 'small muted', text: navigator.onLine ? t('product_error') : t('product_offline') }));
        box.appendChild(el('p', {}, [el('button', { class: 'btn-ghost btn-sm', text: t('product_retry'), attrs: { type: 'button' }, on: { click: () => { box.remove(); renderProduct(panel, code); } } })]));
      }
    }
  }

  function drawProduct(box, product, code, fromCache, cacheTs) {
    const wrap = el('div', { class: 'product' });
    if (product.image_front_small_url) {
      const img = el('img', { attrs: { src: product.image_front_small_url, alt: product.product_name || code, loading: 'lazy', referrerpolicy: 'no-referrer' } });
      img.addEventListener('error', () => { img.replaceWith(el('div', { class: 'badge', text: 'OFF' })); });
      wrap.appendChild(img);
    } else {
      wrap.appendChild(el('div', { class: 'badge', text: 'OFF' }));
    }
    const info = el('div');
    info.appendChild(el('p', {}, [el('strong', { text: product.product_name || t('product_no_name') })]));
    if (product.brands) info.appendChild(el('p', { class: 'small muted', text: t('product_brand') + ': ' + product.brands }));
    if (product.quantity) info.appendChild(el('p', { class: 'small muted', text: t('product_quantity') + ': ' + product.quantity }));
    const badges = el('div', { class: 'badges' });
    const grade = (product.nutriscore_grade || '').toLowerCase();
    if (/^[a-e]$/.test(grade)) {
      badges.appendChild(el('span', { class: 'badge' }, [
        el('span', { class: 'nutri nutri-' + grade, text: grade, attrs: { 'aria-hidden': 'true' } }),
        el('span', { text: ' ' + t('product_nutri') }),
      ]));
    }
    if (product.nova_group) badges.appendChild(el('span', { class: 'badge', text: t('product_nova') + ': ' + product.nova_group }));
    badges.appendChild(el('span', { class: 'badge', text: fromCache ? t('product_from_cache') : t('product_found') }));
    info.appendChild(badges);
    if (fromCache && cacheTs) info.appendChild(el('p', { class: 'small muted', text: fmtDateTime(cacheTs) }));
    if (product.allergens) info.appendChild(el('p', { class: 'small' }, [el('strong', { text: t('product_allergens') + ': ' }), el('span', { text: product.allergens })]));
    if (product.ingredients_text) {
      const details = el('details', { class: 'ingredients' }, [
        el('summary', { text: t('product_ingredients') }),
        el('p', { class: 'small', text: product.ingredients_text }),
      ]);
      info.appendChild(details);
    }
    info.appendChild(el('p', { class: 'small muted' }, [el('a', { text: 'Open Food Facts (ODbL)', attrs: { href: 'https://world.openfoodfacts.org/product/' + encodeURIComponent(code), target: '_blank', rel: 'noopener noreferrer' } })]));
    wrap.appendChild(info);
    box.appendChild(wrap);
  }

  // ---------- clipboard / download helpers ----------
  async function copyText(value) {
    const text = String(value);
    try {
      if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; }
    } catch (e) { /* fall through */ }
    try {
      const area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', 'readonly');
      area.style.position = 'fixed';
      area.style.left = '-9999px';
      document.body.appendChild(area);
      area.select();
      document.execCommand('copy');
      area.remove();
      return true;
    } catch (e) { return false; }
  }
  function downloadBlob(filename, content, mime) {
    const blob = new Blob([content], { type: mime || 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function downloadVCard(card) {
    downloadBlob('contact.vcf', card.raw || buildVCard(card), 'text/vcard');
  }
  function buildVCard(card) {
    const lines = ['BEGIN:VCARD', 'VERSION:3.0', 'FN:' + (card.name || ''), card.org ? 'ORG:' + card.org : '', card.tel ? 'TEL:' + card.tel : '', card.email ? 'EMAIL:' + card.email : '', card.url ? 'URL:' + card.url : '', 'END:VCARD'];
    return lines.filter(Boolean).join('\n');
  }
  function localStamp() {
    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    return now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate());
  }

  // ---------- history export / import ----------
  function exportHistory() {
    downloadBlob('qr-scanner-istoric-' + localStamp() + '.json', JSON.stringify({ schemaVersion: 1, exportedAt: new Date().toISOString(), count: history.length, entries: history }, null, 2));
    toast(t('history_exported'));
  }
  function downloadRawHistory() {
    const raw = rawHistoryStored !== null ? rawHistoryStored : storeGet(KEYS.history);
    if (raw === null) { toast(t('history_empty')); return; }
    downloadBlob('qr-scanner-copie-bruta-' + localStamp() + '.json', raw);
    toast(t('toast_backup_saved'));
  }
  async function startFreshHistory() {
    const confirmed = await askConfirm(t('history_clear_title'), t('banner_unreadable'), t('action_start_fresh'), true);
    if (!confirmed) return;
    const raw = storeGet(KEYS.history);
    if (raw !== null && raw !== '') storeSet(BACKUP_PREFIX + new Date().toISOString(), raw);
    storeSet(KEYS.history, '[]');
    dataState = 'ok';
    skippedEntries = 0;
    history = [];
    loadHistory();
    renderHistory();
    refreshBanner();
    toast(t('toast_fresh'));
  }
  async function importHistory(file) {
    if (file.size > FILE_MAX) { toast(t('file_too_large')); return; }
    const text = await file.text().catch(() => null);
    if (text === null) { toast(t('history_import_error')); return; }
    let doc;
    try { doc = JSON.parse(text); } catch (e) { toast(t('history_import_error')); return; }
    const entries = Array.isArray(doc) ? doc : (doc && Array.isArray(doc.entries) ? doc.entries : null);
    if (!entries) { toast(t('history_import_error')); return; }
    const seen = new Set(history.map(duplicateHistoryKey));
    const additions = [];
    let duplicates = 0, broken = 0;
    for (const item of entries) {
      if (!validEntry(item)) { broken++; continue; }
      const entry = { id: item.id || (Date.now() + additions.length), ts: item.ts, code: String(item.code).slice(0, 4096), format: String(item.format).slice(0, 32), type: String(item.type).slice(0, 32), label: typeof item.label === 'string' ? item.label.slice(0, 200) : '' };
      const key = duplicateHistoryKey(entry);
      if (seen.has(key)) { duplicates++; continue; }
      seen.add(key);
      additions.push(entry);
    }
    if (!additions.length) {
      toast(duplicates ? (duplicates === 1 ? t('history_import_none_one') : t('history_import_none', { d: fmtCount(duplicates) })) : t('history_import_error'));
      return;
    }
    if (duplicates || broken) {
      const parts = [additions.length === 1 ? t('history_part_new_one', { n: fmtCount(additions.length) }) : t('history_part_new_many', { n: fmtCount(additions.length) })];
      if (duplicates) parts.push(duplicates === 1 ? t('history_part_dup_one', { d: fmtCount(duplicates) }) : t('history_part_dup_many', { d: fmtCount(duplicates) }));
      if (broken) parts.push(broken === 1 ? t('history_part_bad_one', { b: fmtCount(broken) }) : t('history_part_bad_many', { b: fmtCount(broken) }));
      const confirmed = await askConfirm(t('history_import'), t('history_import_prefix') + ' ' + parts.join('; ') + '. ' + t('history_import_ask'), t('confirm'));
      if (!confirmed) return;
    }
    history = additions.concat(history).sort((a, b) => b.ts - a.ts).slice(0, HISTORY_MAX);
    persistHistory();
    renderHistory();
    toast(additions.length === 1 ? t('history_imported_one') : t('history_imported', { n: fmtCount(additions.length) }));
  }

  // ---------- history rendering ----------
  let historyFilter = 'all';
  let historyQuery = '';
  function entryLabel(entry) {
    if (entry.label) return entry.label;
    if (entry.type === 'link') return entry.code.replace(/^https?:\/\//i, '').split('/')[0];
    return entry.code.length > 70 ? entry.code.slice(0, 70) + '…' : entry.code;
  }
  function relativeTime(ts) {
    const diff = Date.now() - ts;
    const minutes = Math.round(diff / 60000);
    if (minutes < 1) return t('time_just_now');
    if (minutes === 1) return t('time_minute');
    if (minutes < 60) return t('time_minutes', { n: fmtCount(minutes) });
    const hours = Math.round(minutes / 60);
    if (hours === 1) return t('time_hour');
    if (hours < 24) return t('time_hours', { n: fmtCount(hours) });
    const days = Math.round(hours / 24);
    if (days === 1) return t('time_yesterday');
    return t('time_days', { n: fmtCount(days) });
  }
  function matchesFilter(entry) {
    if (historyFilter === 'all') return true;
    if (historyFilter === 'links') return entry.type === 'link';
    if (historyFilter === 'products') return entry.type === 'product';
    if (historyFilter === 'contacts') return entry.type === 'vcard' || entry.type === 'email' || entry.type === 'phone';
    if (historyFilter === 'wifi') return entry.type === 'wifi';
    if (historyFilter === 'text') return entry.type === 'text' || entry.type === 'sms' || entry.type === 'geo';
    return true;
  }
  function renderHistory() {
    const list = $('historyList');
    const empty = $('historyEmpty');
    const stats = $('historyStats');
    const entries = history.filter(entry => matchesFilter(entry) && (historyQuery === '' || entry.code.toLowerCase().includes(historyQuery) || (entry.label || '').toLowerCase().includes(historyQuery)));
    if (stats) {
      const products = history.filter(e => e.type === 'product').length;
      const parts = [t('history_total') + ': ' + fmtCount(history.length), t('history_products') + ': ' + fmtCount(products)];
      if (history.length) parts.push(t('history_last') + ': ' + relativeTime(history[0].ts));
      stats.textContent = parts.join(' · ');
    }
    list.textContent = '';
    if (!entries.length) {
      empty.textContent = history.length ? t('history_empty_filter') : t('history_empty');
      empty.hidden = false;
      return;
    }
    empty.hidden = true;
    for (const entry of entries) {
      const item = el('li', { class: 'history-item' });
      const main = el('div', { class: 'history-main' }, [
        el('div', { class: 'history-title', text: entryLabel(entry) }),
        el('div', { class: 'history-code', text: entry.code }),
        el('div', { class: 'history-meta' }, [
          el('span', { class: 'badge', text: entry.format }),
          el('span', { class: 'badge badge-type', text: typeLabel(entry.type) }),
          el('span', { class: 'small muted', text: fmtDateTime(entry.ts) + ' · ' + relativeTime(entry.ts), attrs: { title: fmtDateTime(entry.ts) } }),
        ]),
      ]);
      const actions = el('div', { class: 'history-actions' }, [
        el('button', { class: 'btn-ghost btn-sm', text: t('history_show'), attrs: { type: 'button', 'data-show': entry.id } }),
        el('button', { class: 'btn-ghost btn-sm', text: t('history_copy'), attrs: { type: 'button', 'data-copy': entry.id } }),
        el('button', { class: 'btn-danger btn-sm', text: t('history_delete'), attrs: { type: 'button', 'data-delete': entry.id } }),
      ]);
      item.appendChild(main);
      item.appendChild(actions);
      list.appendChild(item);
    }
  }
  function showEntry(id) {
    const entry = history.find(item => item.id === id);
    if (!entry) return;
    switchTab('scan');
    const info = classify(entry.code, entry.format);
    renderResult({ code: entry.code, format: entry.format, type: info.type, fresh: false, ...info });
  }
  async function deleteEntry(id) {
    const entry = history.find(item => item.id === id);
    if (!entry) return;
    const confirmed = await askConfirm(t('history_delete_title'), t('history_delete_body'), t('history_delete'), true);
    if (!confirmed) return;
    removeHistory(id);
    toast(t('history_deleted'));
  }
  async function clearHistory() {
    if (!history.length) { toast(t('history_empty')); return; }
    const confirmed = await askConfirm(t('history_clear_title'), t('history_clear_body'), t('history_clear'), true);
    if (!confirmed) return;
    history = [];
    persistHistory();
    renderHistory();
    toast(t('history_cleared'));
  }

  // ---------- camera ----------
  const video = $('video');
  const frameCanvas = document.createElement('canvas');
  const frameCtx = frameCanvas.getContext('2d', { willReadFrequently: true });
  let stream = null, videoTrack = null, scanning = false, rafId = null, lastFrameAt = 0, cameraFacing = 'environment';

  function setScannerStatus(key) {
    const node = $('scannerStatus');
    node.textContent = t(key);
    const live = $('scanAnnounce');
    if (live) live.textContent = t(key);
  }
  function mapCameraError(error) {
    const name = error && error.name;
    if (name === 'NotAllowedError' || name === 'SecurityError') return 'camera_denied';
    if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'camera_not_found';
    if (name === 'NotReadableError' || name === 'AbortError') return 'camera_busy';
    return 'camera_error';
  }
  function cameraSupported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.isSecureContext);
  }
  async function startCamera() {
    if (scanning) return;
    if (!cameraSupported()) {
      toast(window.isSecureContext ? t('camera_unsupported') : t('camera_insecure'));
      return;
    }
    setScannerStatus('camera_starting');
    $('startCamera').disabled = true;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: cameraFacing, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
    } catch (error) {
      $('startCamera').disabled = false;
      const key = mapCameraError(error);
      /* keep the reason visible in the status line after the toast fades */
      setScannerStatus(key);
      $('scannerPlaceholder').hidden = false;
      video.hidden = true;
      await updateCameraControls();
      toast(t(key));
      return;
    }
    video.srcObject = stream;
    video.hidden = false;
    $('scannerPlaceholder').hidden = true;
    try { await video.play(); } catch (e) { /* autoplay guard */ }
    videoTrack = stream.getVideoTracks()[0] || null;
    await updateCameraControls();
    scanning = true;
    $('startCamera').disabled = false;
    $('stopCamera').disabled = false;
    $('startCamera').hidden = true;
    $('stopCamera').hidden = false;
    setScannerStatus('scanner_scanning');
    lastFrameAt = 0;
    rafId = requestAnimationFrame(scanLoop);
  }
  function stopCamera() {
    scanning = false;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
    if (stream) {
      for (const track of stream.getTracks()) { try { track.stop(); } catch (e) { /* ignore */ } }
      stream = null;
    }
    videoTrack = null;
    video.srcObject = null;
    video.hidden = true;
    $('scannerPlaceholder').hidden = false;
    $('startCamera').hidden = false;
    $('stopCamera').hidden = true;
    $('torchToggle').hidden = true;
    setScannerStatus('scanner_idle');
  }
  async function updateCameraControls() {
    const torch = $('torchToggle');
    let hasTorch = false;
    try {
      const caps = videoTrack && videoTrack.getCapabilities ? videoTrack.getCapabilities() : {};
      hasTorch = !!caps.torch;
    } catch (e) { hasTorch = false; }
    torch.hidden = !hasTorch;
    if (!hasTorch) torch.setAttribute('aria-pressed', 'false');
    /* device labels are only known after a permission grant, but the count is always available */
    let cameras = 0;
    try {
      if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
        const devices = await navigator.mediaDevices.enumerateDevices();
        cameras = devices.filter(d => d.kind === 'videoinput').length;
      }
    } catch (e) { cameras = 0; }
    $('switchCamera').hidden = cameras < 2;
  }
  function scanLoop(timestamp) {
    if (!scanning) return;
    const interval = nativeDetector ? 90 : 160;
    if (timestamp - lastFrameAt >= interval && video.readyState >= 2 && video.videoWidth) {
      lastFrameAt = timestamp;
      const scale = Math.min(1, 900 / video.videoWidth);
      frameCanvas.width = Math.round(video.videoWidth * scale);
      frameCanvas.height = Math.round(video.videoHeight * scale);
      frameCtx.drawImage(video, 0, 0, frameCanvas.width, frameCanvas.height);
      decodeCanvas(frameCanvas).then(found => {
        if (found && found.text) onDetected(found.text, found.format, 'camera');
      }).catch(() => { /* keep scanning */ });
    }
    rafId = requestAnimationFrame(scanLoop);
  }
  async function toggleTorch() {
    if (!videoTrack) return;
    const button = $('torchToggle');
    const next = button.getAttribute('aria-pressed') !== 'true';
    try {
      await videoTrack.applyConstraints({ advanced: [{ torch: next }] });
      button.setAttribute('aria-pressed', next ? 'true' : 'false');
      button.title = next ? t('torch_off') : t('torch_on');
      button.setAttribute('aria-label', button.title);
    } catch (e) { toast(t('camera_error')); }
  }
  async function switchCamera() {
    cameraFacing = cameraFacing === 'environment' ? 'user' : 'environment';
    if (scanning) { stopCamera(); await startCamera(); }
  }

  // ---------- feedback ----------
  let audioCtx = null;
  function feedback() {
    if (settings.vibrate && navigator.vibrate) { try { navigator.vibrate(35); } catch (e) { /* ignore */ } }
    if (!settings.sound) return;
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = 880;
      gain.gain.value = 0.06;
      osc.connect(gain).connect(audioCtx.destination);
      osc.start();
      osc.stop(audioCtx.currentTime + 0.12);
    } catch (e) { /* audio is optional */ }
  }

  // ---------- detection ----------
  function onDetected(text, format, source) {
    const info = classify(text, format);
    const now = Date.now();
    const isDuplicateFrame = lastDetection.code === text && (now - lastDetection.ts) < 2500;
    if (isDuplicateFrame && settings.continuous) return;
    lastDetection = { code: text, ts: now };
    feedback();
    const entry = {
      id: now + Math.floor(Math.random() * 1000),
      ts: now,
      code: String(text).slice(0, 4096),
      format: String(format || 'UNKNOWN').slice(0, 32),
      type: info.type,
      label: info.type === 'product' ? t('type_product') + ' ' + info.code : (info.type === 'link' ? info.url.replace(/^https?:\/\//i, '').split('/')[0] : ''),
    };
    addHistory(entry);
    renderResult({ code: entry.code, format: entry.format, type: info.type, fresh: true, ...info });
    setScannerStatus('scanner_found');
    if (!settings.continuous) stopCamera();
    else setTimeout(() => { if (scanning) setScannerStatus('scanner_scanning'); }, 1200);
  }

  // ---------- image scanning ----------
  async function scanImageFile(file) {
    if (!file) return;
    if (file.size > FILE_MAX) { toast(t('file_too_large')); return; }
    setScannerStatus('image_scanning');
    let bitmap = null;
    try {
      bitmap = await createImageBitmap(file);
    } catch (e) {
      toast(t('image_error'));
      setScannerStatus('scanner_idle');
      return;
    }
    const scale = Math.min(1, 1400 / Math.max(bitmap.width, bitmap.height));
    frameCanvas.width = Math.round(bitmap.width * scale);
    frameCanvas.height = Math.round(bitmap.height * scale);
    frameCtx.drawImage(bitmap, 0, 0, frameCanvas.width, frameCanvas.height);
    const found = await decodeCanvas(frameCanvas);
    if (bitmap.close) bitmap.close();
    if (!found) {
      toast(t('image_no_code'));
      setScannerStatus(scanning ? 'scanner_scanning' : 'scanner_idle');
      return;
    }
    onDetected(found.text, found.format, 'image');
  }

  // ---------- tabs ----------
  function switchTab(name) {
    for (const button of document.querySelectorAll('[role="tab"]')) {
      const selected = button.dataset.tab === name;
      button.setAttribute('aria-selected', selected ? 'true' : 'false');
      button.tabIndex = selected ? 0 : -1;
    }
    for (const panel of document.querySelectorAll('[role="tabpanel"]')) {
      panel.hidden = panel.dataset.panel !== name;
    }
  }

  // ---------- language / theme ----------
  function applyLanguage(lang, persist) {
    currentLang = I18N[lang] ? lang : 'en';
    if (persist) { settings.lang = currentLang; saveSettings(); }
    document.documentElement.lang = HTML_LANGS[currentLang] || currentLang;
    for (const node of document.querySelectorAll('[data-i18n]')) node.textContent = t(node.getAttribute('data-i18n'));
    for (const node of document.querySelectorAll('[data-i18n-aria]')) node.setAttribute('aria-label', t(node.getAttribute('data-i18n-aria')));
    for (const node of document.querySelectorAll('[data-i18n-placeholder]')) node.setAttribute('placeholder', t(node.getAttribute('data-i18n-placeholder')));
    document.title = t('app_title') + ' - TekiDeki';
    const meta = document.querySelector('meta[name="description"]');
    if (meta) meta.setAttribute('content', t('app_subtitle') + '. ' + t('about_privacy_text'));
    $('langSelect').value = currentLang;
    $('langSelect').setAttribute('aria-label', t('lang_label'));
    $('themeToggle').setAttribute('aria-label', t('theme_toggle'));
    $('themeToggle').title = t('theme_toggle');
    updateEngineNote();
    setScannerStatus(scanning ? 'scanner_scanning' : 'scanner_idle');
    renderResult(currentResult);
    renderHistory();
    updateCacheCount();
  }
  function applyTheme(dark) {
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', dark ? '#0f172a' : '#f4f6f9');
    $('themeToggle').textContent = dark ? '☀️' : '🌙';
    $('themeToggle').setAttribute('aria-pressed', dark ? 'true' : 'false');
  }
  function detectDark() {
    if (settings.dark !== null) return settings.dark;
    return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  }

  // ---------- settings UI ----------
  function updateCacheCount() {
    const node = $('cacheCount');
    if (!node) return;
    const count = Object.keys(productCache).length;
    node.textContent = t('settings_cache_count', { n: fmtCount(count) });
    $('clearCache').disabled = count === 0;
  }
  async function clearProductCache() {
    if (!Object.keys(productCache).length) return;
    const confirmed = await askConfirm(t('settings_clear_cache'), t('settings_cache_count', { n: fmtCount(Object.keys(productCache).length) }), t('settings_clear_cache'), true);
    if (!confirmed) return;
    productCache = {};
    storeRemove(KEYS.cache);
    updateCacheCount();
    toast(t('settings_cache_cleared'));
  }

  // ---------- install prompt ----------
  let installEvent = null;
  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    installEvent = event;
    $('installWrap').hidden = false;
  });
  async function installApp() {
    if (installEvent) {
      installEvent.prompt();
      try { await installEvent.userChoice; } catch (e) { /* ignore */ }
      installEvent = null;
      $('installWrap').hidden = true;
      return;
    }
    const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent);
    toast(isIos ? t('install_hint_ios') : t('install_hint_other'));
  }

  /* Language priority: explicit ?lang= link, then the saved choice, then the browser. */
  function pickInitialLang(params) {
    const requested = (params.get('lang') || '').toLowerCase();
    if (I18N[requested]) return requested;
    if (settings.lang && I18N[settings.lang]) return settings.lang;
    const nav = (navigator.language || 'en').toLowerCase();
    if (nav.startsWith('ro')) return 'ro';
    if (nav.startsWith('sr')) return /cyrl|cyrillic/.test(nav) ? 'sr-cyrl' : 'sr-latn';
    return 'en';
  }

  // ---------- wiring ----------
  function init() {
    loadSettings();
    initDecoder().catch(() => {});
    updateCameraControls().catch(() => {});
    const params = new URLSearchParams(location.search);
    const initialLang = pickInitialLang(params);
    loadHistory();
    loadCache();
    applyTheme(detectDark());
    applyLanguage(initialLang, false);
    refreshBanner();
    renderResult(null);
    renderHistory();

    // tabs (deep links: ?tab=history or ?tab=about)
    for (const button of document.querySelectorAll('[role="tab"]')) {
      button.addEventListener('click', () => switchTab(button.dataset.tab));
    }
    const requestedTab = (params.get('tab') || '').toLowerCase();
    if (requestedTab === 'history' || requestedTab === 'about') switchTab(requestedTab);
    // scanner buttons
    $('startCamera').addEventListener('click', startCamera);
    $('stopCamera').addEventListener('click', stopCamera);
    $('torchToggle').addEventListener('click', toggleTorch);
    $('switchCamera').addEventListener('click', switchCamera);
    $('scanAgain').addEventListener('click', () => { renderResult(null); startCamera(); });
    $('imageInput').addEventListener('change', event => {
      const file = event.target.files && event.target.files[0];
      if (file) scanImageFile(file);
      event.target.value = '';
    });
    const zone = $('dropZone');
    zone.addEventListener('dragover', event => { event.preventDefault(); zone.classList.add('dragover'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
    zone.addEventListener('drop', event => {
      event.preventDefault();
      zone.classList.remove('dragover');
      const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
      if (file) scanImageFile(file);
    });
    window.addEventListener('paste', event => {
      const items = event.clipboardData && event.clipboardData.items;
      if (!items) return;
      for (const item of items) {
        if (item.type && item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (file) { scanImageFile(file); event.preventDefault(); }
          return;
        }
      }
    });
    // history controls
    $('historySearch').addEventListener('input', event => { historyQuery = event.target.value.trim().toLowerCase(); renderHistory(); });
    for (const button of document.querySelectorAll('[data-filter]')) {
      button.addEventListener('click', () => {
        historyFilter = button.dataset.filter;
        for (const other of document.querySelectorAll('[data-filter]')) other.setAttribute('aria-pressed', other === button ? 'true' : 'false');
        renderHistory();
      });
    }
    $('historyExport').addEventListener('click', exportHistory);
    $('historyImportBtn').addEventListener('click', () => $('historyImportInput').click());
    $('historyImportInput').addEventListener('change', event => {
      const file = event.target.files && event.target.files[0];
      if (file) importHistory(file);
      event.target.value = '';
    });
    $('historyClear').addEventListener('click', clearHistory);
    $('historyList').addEventListener('click', event => {
      const button = event.target.closest('button');
      if (!button) return;
      const id = Number(button.dataset.show || button.dataset.copy || button.dataset.delete);
      if (button.dataset.show) showEntry(id);
      else if (button.dataset.copy) { const entry = history.find(item => item.id === id); if (entry) copyText(entry.code).then(() => toast(t('action_copied'))); }
      else if (button.dataset.delete) deleteEntry(id);
    });
    // settings
    $('enrichToggle').addEventListener('change', event => { settings.enrich = event.target.checked; saveSettings(); renderResult(currentResult); });
    $('continuousToggle').addEventListener('change', event => { settings.continuous = event.target.checked; saveSettings(); });
    $('vibrateToggle').addEventListener('change', event => { settings.vibrate = event.target.checked; saveSettings(); });
    $('soundToggle').addEventListener('change', event => { settings.sound = event.target.checked; saveSettings(); });
    $('clearCache').addEventListener('click', clearProductCache);
    $('chooseImageBtn').addEventListener('click', () => $('imageInput').click());
    $('installBtn').addEventListener('click', installApp);
    // header
    $('themeToggle').addEventListener('click', () => {
      settings.dark = document.documentElement.getAttribute('data-theme') !== 'dark';
      saveSettings();
      applyTheme(settings.dark);
    });
    $('langSelect').addEventListener('change', event => applyLanguage(event.target.value, true));
    $('statusActions').addEventListener('click', event => {
      const button = event.target.closest('button[data-banner-action]');
      if (!button) return;
      const action = bannerActions[Number(button.dataset.bannerAction)];
      if (action) action.run();
    });
    // keyboard shortcuts
    document.addEventListener('keydown', event => {
      const target = event.target;
      const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT');
      /* never steal Space or number keys from a focused control */
      const interactive = target && target.closest && target.closest('button, a, [role="tab"], [role="switch"], [contenteditable="true"]');
      if (typing || interactive) return;
      if (event.code === 'Space') { event.preventDefault(); scanning ? stopCamera() : startCamera(); }
      else if (event.key === '1') switchTab('scan');
      else if (event.key === '2') switchTab('history');
      else if (event.key === '3') switchTab('about');
    });
    // settings switches reflect stored values
    $('enrichToggle').checked = settings.enrich;
    $('vibrateToggle').checked = settings.vibrate;
    $('soundToggle').checked = settings.sound;
    $('continuousToggle').checked = settings.continuous;
    updateCacheCount();

    // service worker (not available from file://)
    if ('serviceWorker' in navigator && location.protocol !== 'file:') {
      window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => { /* offline support is optional */ }));
    }
    if (!cameraSupported()) {
      $('startCamera').disabled = true;
      setScannerStatus(window.isSecureContext ? 'camera_unsupported' : 'camera_insecure');
    } else {
      setScannerStatus('scanner_idle');
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
