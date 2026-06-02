// ==UserScript==
// @name         ZUS eZUS Scraper
// @namespace    http://tampermonkey.net/
// @version      0.2.0
// @description  Zbiera salda i wpłaty z kont płatników w eZUS
// @author       Dmytro Tiaptia
// @match        https://www.zus.pl/ezus/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @require      https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ─── STORAGE ────────────────────────────────────────────────────────────────

  const STORAGE_KEY = 'zus_scraper_state';

  async function loadState() {
    return await GM_getValue(STORAGE_KEY, {
      accounts: [],       // [{ name, nip, status, saldo, payments, paymentsSum, lastFetched }]
      currentIndex: null, // index aktualnie przetwarzanego konta
      lastFullRun: null,
    });
  }

  async function saveState(state) {
    await GM_setValue(STORAGE_KEY, state);
  }

  async function clearState() {
    await GM_deleteValue(STORAGE_KEY);
  }

  // ─── SESSION IGNORE LIST (tylko pamięć okna UI) ──────────────────────────────
  // Przechowywana w window opener lub przekazywana przez broadcastchannel
  const channel = new BroadcastChannel('zus_scraper');

  // ─── HELPERS ────────────────────────────────────────────────────────────────

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function waitForElement(selector, timeout = 10000) {
    return new Promise((resolve, reject) => {
      const existing = document.querySelector(selector);
      if (existing) return resolve(existing);
      const observer = new MutationObserver(() => {
        const el = document.querySelector(selector);
        if (el) { observer.disconnect(); resolve(el); }
      });
      observer.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => { observer.disconnect(); reject(new Error(`Timeout waiting for: ${selector}`)); }, timeout);
    });
  }

  function waitForURL(urlPart, timeout = 15000) {
    return new Promise((resolve, reject) => {
      if (location.href.includes(urlPart)) return resolve();
      const interval = setInterval(() => {
        if (location.href.includes(urlPart)) { clearInterval(interval); resolve(); }
      }, 200);
      setTimeout(() => { clearInterval(interval); reject(new Error(`Timeout waiting for URL: ${urlPart}`)); }, timeout);
    });
  }

  function parseAmount(text) {
    // Obsługuje: "- 12 867,82 zł", "+ 420,86 zł", "1\u00a0011,85 zł"
    // \u00a0 = &nbsp; używane przez ZUS jako separator tysięcy
    const normalized = text
      .replace(/\u00a0/g, '')   // usuń &nbsp;
      .replace(/\s/g, '')       // usuń wszystkie whitespace
      .replace(',', '.');       // zamień przecinek na kropkę
    const negative = normalized.includes('-');
    const digits = normalized.replace(/[^\d.]/g, '');
    const value = parseFloat(digits) || 0;
    return negative ? -value : value;
  }

  function clickElement(el) {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  }

  // ─── FAZA 1: ZBIERZ LISTĘ KONT ──────────────────────────────────────────────

  async function collectAccounts() {
    channel.postMessage({ type: 'log', text: 'Zbieram listę kont...' });

    await waitForElement('tr[data-testid="authorized-accounts-row"]');
    await sleep(500); // daj Angular chwilę na wyrenderowanie wszystkich wierszy

    const rows = document.querySelectorAll('tr[data-testid="authorized-accounts-row"]');
    const accounts = [];

    rows.forEach(row => {
      const nameEl = row.querySelector('[data-testid="authorized-accounts-account-name"]');
      const nipCell = row.querySelector('td[aria-label^="Identyfikator konta-"]');
      if (!nameEl || !nipCell) return;

      const name = nameEl.textContent.trim();
      const nipRaw = nipCell.getAttribute('aria-label') || '';
      const nip = nipRaw.replace('Identyfikator konta-NIP ', '').trim();

      accounts.push({ name, nip, status: 'pending', saldo: null, payments: [], paymentsSum: 0, lastFetched: null });
    });

    const state = await loadState();
    state.accounts = accounts;
    state.currentIndex = null;
    await saveState(state);

    channel.postMessage({ type: 'accounts', accounts });
    channel.postMessage({ type: 'log', text: `Znaleziono ${accounts.length} kont.` });
  }

  // ─── NAWIGACJA DO LISTY KONT ─────────────────────────────────────────────────

  async function goToAccountList() {
    // Otwórz panel kontekstowy
    const profileBtn = await waitForElement('button[aria-label^="Otwórz panel kontekstowy"]');
    clickElement(profileBtn);
    await sleep(600);

    // Kliknij "Wszystkie dostępne konta"
    const allAccountsBtn = await waitForElement('button .p-button-label');
    const btns = document.querySelectorAll('.p-button-label');
    const targetBtn = [...btns].find(el => el.textContent.includes('Wszystkie dostępne konta'));
    if (!targetBtn) throw new Error('Nie znaleziono przycisku "Wszystkie dostępne konta"');
    clickElement(targetBtn.closest('button'));

    await waitForURL('/ezus/wybor-kontekstu');
    await sleep(800);
  }

  // ─── FAZA 2: PRZETWÓRZ JEDNO KONTO ──────────────────────────────────────────

  async function processAccount(index, ignoredNips) {
    const state = await loadState();
    const account = state.accounts[index];
    if (!account) return;

    channel.postMessage({ type: 'status', index, status: 'in_progress' });
    channel.postMessage({ type: 'log', text: `Przetwarzam: ${account.name}` });

    // Upewnij się że jesteśmy na liście kont
    if (!location.href.includes('/ezus/wybor-kontekstu')) {
      await goToAccountList();
    }

    // Znajdź wiersz konta po NIP
    await waitForElement('tr[data-testid="authorized-accounts-row"]');
    await sleep(500);

    const rows = document.querySelectorAll('tr[data-testid="authorized-accounts-row"]');
    let targetRow = null;
    for (const row of rows) {
      const nipCell = row.querySelector('td[aria-label^="Identyfikator konta-"]');
      if (nipCell && nipCell.getAttribute('aria-label').includes(account.nip)) {
        targetRow = row;
        break;
      }
    }

    if (!targetRow) throw new Error(`Nie znaleziono wiersza dla NIP: ${account.nip}`);

    // Kliknij "Zobacz szczegóły"
    const detailBtn = targetRow.querySelector('button[aria-label="Zobacz szczegóły"]');
    if (!detailBtn) throw new Error('Nie znaleziono przycisku "Zobacz szczegóły"');
    clickElement(detailBtn);

    await waitForURL('/ezus/obszar-platnika/platnik/dashboard');
    await sleep(800);

    // Kliknij tab "Należne składki i wpłaty"
    await waitForElement('.tab-label');
    const tabs = document.querySelectorAll('.tab-label');
    const targetTab = [...tabs].find(el => el.textContent.includes('Należne składki i wpłaty'));
    if (!targetTab) throw new Error('Nie znaleziono taba "Należne składki i wpłaty"');
    clickElement(targetTab.closest('a'));

    await waitForURL('zakladka=Nalezne_skladki_i_wplaty');
    await sleep(1000);

    // Odczytaj saldo miesięczne
    await waitForElement('.balance-column');
    const balanceCols = document.querySelectorAll('.balance-column');
    let winien = 0;
    let ma = 0;

    balanceCols.forEach(col => {
      const label = col.querySelector('.balance-label')?.textContent || '';
      const value = col.querySelector('.balance-value b')?.textContent || '';
      if (label.includes('Do zapłaty bez odsetek')) winien = parseAmount(value);
      if (label.includes('Nadpłata')) ma = parseAmount(value);
    });

    // Saldo: Winien już jest ujemny (parseAmount zwraca -12867.82),
    // Ma jest dodatni. Jeśli oba są 0, saldo = 0.
    let saldo;
    if (winien < 0) {
      saldo = winien; // już ujemny
    } else if (ma > 0) {
      saldo = ma;     // nadpłata
    } else {
      saldo = 0;
    }

    // Odczytaj tabelkę wpłat
    const payments = [];
    const tables = document.querySelectorAll('table[id]');
    for (const table of tables) {
      const caption = table.querySelector('caption');
      if (!caption || !caption.textContent.includes('Wpłaty')) continue;

      const rows = table.querySelectorAll('tbody tr');
      rows.forEach(row => {
        const cells = row.querySelectorAll('td');
        if (cells.length < 2) return;
        const date = cells[0].textContent.trim();
        const amount = parseAmount(cells[1].textContent);
        if (date && amount) payments.push({ date, amount });
      });
    }

    const paymentsSum = payments.reduce((sum, p) => sum + p.amount, 0);

    // Zapisz wynik
    state.accounts[index] = {
      ...account,
      status: 'done',
      saldo,
      payments,
      paymentsSum,
      lastFetched: new Date().toISOString(),
    };
    state.currentIndex = null;
    await saveState(state);

    channel.postMessage({ type: 'status', index, status: 'done', saldo, paymentsSum });
    channel.postMessage({ type: 'log', text: `✓ ${account.name}: saldo ${saldo > 0 ? '+' : ''}${saldo.toFixed(2)} zł, wpłaty ${paymentsSum.toFixed(2)} zł` });
  }

  // ─── EXPORT XLSX ────────────────────────────────────────────────────────────

  function generateXLSX(accounts) {
    const headers = ['Nazwa', 'NIP', 'Saldo (zł)', 'Suma wpłat (zł)', 'Data wpłaty', 'Kwota wpłaty (zł)'];
    const rows = [];

    accounts.filter(a => a.status === 'done').forEach(a => {
      if (a.payments.length === 0) {
        rows.push([a.name, a.nip, a.saldo, a.paymentsSum, '', '']);
      } else {
        a.payments.forEach(p => {
          rows.push([a.name, a.nip, a.saldo, a.paymentsSum, p.date, p.amount]);
        });
      }
    });

    const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);

    // Szerokości kolumn
    ws['!cols'] = [
      { wch: 32 }, // Nazwa
      { wch: 14 }, // NIP
      { wch: 14 }, // Saldo
      { wch: 16 }, // Suma wpłat
      { wch: 13 }, // Data wpłaty
      { wch: 18 }, // Kwota wpłaty
    ];

    // Zamroź pierwszy wiersz
    ws['!freeze'] = { xSplit: 0, ySplit: 1 };

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'ZUS');
    return wb;
  }

  // ─── GŁÓWNA LOGIKA (uruchamiana na każdej stronie ZUS) ───────────────────────

  async function main() {
    const state = await loadState();

    // Słuchaj komend z okna UI
    channel.onmessage = async (e) => {
      const { type, index, ignoredNips } = e.data;

      if (type === 'collect') {
        await collectAccounts();
      }

      if (type === 'process') {
        try {
          await processAccount(index, ignoredNips || []);
          channel.postMessage({ type: 'processed', index });
        } catch (err) {
          channel.postMessage({ type: 'error', index, text: err.message });
        }
      }

      if (type === 'export_request') {
        const state = await loadState();
        const wb = generateXLSX(state.accounts);
        const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'base64' });
        channel.postMessage({ type: 'export_data', data: wbout });
      }

      if (type === 'get_state') {
        const state = await loadState();
        channel.postMessage({ type: 'state', state });
      }

      if (type === 'reset') {
        await clearState();
        channel.postMessage({ type: 'reset_done' });
      }
    };

    // Przy pierwszym załadowaniu wyślij aktualny stan do UI
    channel.postMessage({ type: 'state', state });
  }

  main();

  // ─── OTWÓRZ OKNO UI ─────────────────────────────────────────────────────────

  // Przycisk otwierający panel — widoczny na każdej stronie
  const launcher = document.createElement('button');
  launcher.textContent = '📋 ZUS Scraper';
  launcher.style.cssText = `
    position: fixed;
    bottom: 20px;
    right: 20px;
    z-index: 999999;
    background: #0052a5;
    color: white;
    border: none;
    border-radius: 8px;
    padding: 10px 16px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    box-shadow: 0 4px 12px rgba(0,82,165,0.4);
    font-family: system-ui, sans-serif;
  `;

  launcher.addEventListener('click', () => {
    const uiWin = window.open('', 'ZUS_Scraper_UI', 'width=600,height=700,resizable=yes');
    if (!uiWin) { alert('Odblokuj popup dla tej strony!'); return; }
    uiWin.document.open();
    uiWin.document.write(buildUI());
    uiWin.document.close();
  });

  document.body.appendChild(launcher);

  // ─── HTML OKNA UI ────────────────────────────────────────────────────────────

  function buildUI() {
    return `<!DOCTYPE html>
<html lang="pl">
<head>
<meta charset="UTF-8">
<title>ZUS Scraper</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --blue: #0052a5;
    --blue-light: #e8f0fb;
    --green: #1a7f4b;
    --green-light: #e6f4ec;
    --orange: #c45c00;
    --orange-light: #fff3e8;
    --gray: #6b7280;
    --gray-light: #f3f4f6;
    --red: #b91c1c;
    --border: #e5e7eb;
    --text: #111827;
    --radius: 8px;
  }

  body {
    font-family: 'Segoe UI', system-ui, sans-serif;
    font-size: 13px;
    color: var(--text);
    background: #f9fafb;
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    height: 100vh;
  }

  h1 {
    font-size: 16px;
    font-weight: 700;
    color: var(--blue);
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .card {
    background: white;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 12px 14px;
  }

  .row {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }

  .row-between {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  button {
    border: none;
    border-radius: 6px;
    padding: 7px 14px;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    transition: opacity .15s;
  }
  button:hover { opacity: .85; }
  button:disabled { opacity: .4; cursor: not-allowed; }

  .btn-primary { background: var(--blue); color: white; }
  .btn-success { background: var(--green); color: white; }
  .btn-danger  { background: var(--red);   color: white; }
  .btn-ghost   { background: var(--gray-light); color: var(--text); }
  .btn-export  { background: var(--blue); color: white; }

  .counter {
    font-size: 12px;
    color: var(--gray);
  }

  /* Tabela kont */
  .accounts-wrapper {
    height: 220px;
    overflow-y: auto;
    border: 1px solid var(--border);
    border-radius: 6px;
    margin-top: 8px;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
  }

  thead th {
    background: var(--gray-light);
    padding: 6px 8px;
    text-align: left;
    font-weight: 600;
    position: sticky;
    top: 0;
    z-index: 1;
    border-bottom: 1px solid var(--border);
  }

  tbody tr { border-bottom: 1px solid var(--border); }
  tbody tr:last-child { border-bottom: none; }
  tbody td { padding: 5px 8px; vertical-align: middle; }
  tbody tr:hover { background: var(--blue-light); }

  .badge {
    display: inline-block;
    padding: 2px 7px;
    border-radius: 12px;
    font-size: 11px;
    font-weight: 600;
  }
  .badge-pending   { background: var(--gray-light);   color: var(--gray); }
  .badge-progress  { background: var(--orange-light);  color: var(--orange); }
  .badge-done      { background: var(--green-light);   color: var(--green); }
  .badge-ignored   { background: #f3f4f6; color: #9ca3af; text-decoration: line-through; }
  .badge-error     { background: #fee2e2; color: var(--red); }

  .saldo-pos { color: var(--green); font-weight: 600; }
  .saldo-neg { color: var(--red);   font-weight: 600; }

  /* Checkboxy opcji */
  .options { display: flex; flex-direction: column; gap: 6px; }
  label.opt {
    display: flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
    font-size: 12px;
  }
  input[type=checkbox] { accent-color: var(--blue); width: 14px; height: 14px; }

  /* Czerwone chcekboxy ignorowania */
  #accountsTable input[type=checkbox] { accent-color: var(--red); }

  /* Log */
  #log {
    flex: 1;
    overflow-y: auto;
    font-size: 11px;
    font-family: 'Consolas', monospace;
    color: #374151;
    background: #f9fafb;
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 8px;
    line-height: 1.6;
  }

  .log-entry { margin-bottom: 2px; }
  .log-entry.error { color: var(--red); }
  .log-entry.ok { color: var(--green); }

  .divider { height: 1px; background: var(--border); margin: 4px 0; }
</style>
</head>
<body>

<h1>📋 ZUS Scraper</h1>

<!-- Faza 1 -->
<div class="card">
  <div class="row-between">
    <div class="row">
      <button class="btn-primary" id="btnCollect">Stwórz listę kont</button>
      <button class="btn-ghost"   id="btnReset">Resetuj</button>
    </div>
    <span class="counter" id="counter">Brak danych</span>
  </div>

  <div class="accounts-wrapper">
    <table id="accountsTable">
      <thead>
        <tr>
          <th style="width:30px">Ignoruj</th>
          <th>Nazwa</th>
          <th>NIP</th>
          <th>Status</th>
          <th>Saldo</th>
          <th>Suma wpłat</th>
        </tr>
      </thead>
      <tbody id="accountsBody">
        <tr><td colspan="5" style="text-align:center;color:#9ca3af;padding:20px">
          Kliknij "Stwórz listę kont"
        </td></tr>
      </tbody>
    </table>
  </div>
</div>

<!-- Opcje + Start/Stop -->
<div class="card">
  <div class="options">
    <label class="opt">
      <input type="checkbox" id="chkAutoContinue" checked>
      Auto-continue — automatycznie przechodzi do następnego konta
    </label>
    <label class="opt">
      <input type="checkbox" id="chkAutoExport" checked>
      Auto-export — pobiera plik CSV po zakończeniu wszystkich kont (wymaga Auto-continue)
    </label>
  </div>
  <div class="divider"></div>
  <div class="row">
    <button class="btn-success" id="btnStart" disabled>▶ Start</button>
    <button class="btn-danger"  id="btnStop"  disabled>■ Stop</button>
    <button class="btn-export"  id="btnExport" disabled>⬇ Eksportuj teraz</button>
  </div>
</div>

<!-- Log -->
<div id="log"></div>

<script>
  const ch = new BroadcastChannel('zus_scraper');

  let accounts = [];
  let ignoredNips = new Set();
  let running = false;
  let stopped = false;
  let currentIndex = 0;

  // ── DOM refs ──
  const tbody       = document.getElementById('accountsBody');
  const counter     = document.getElementById('counter');
  const btnCollect  = document.getElementById('btnCollect');
  const btnReset    = document.getElementById('btnReset');
  const btnStart    = document.getElementById('btnStart');
  const btnStop     = document.getElementById('btnStop');
  const btnExport   = document.getElementById('btnExport');
  const chkAuto     = document.getElementById('chkAutoContinue');
  const chkExport   = document.getElementById('chkAutoExport');
  const log         = document.getElementById('log');

  // ── Log ──
  function addLog(text, type = '') {
    const d = document.createElement('div');
    d.className = 'log-entry' + (type ? ' ' + type : '');
    const time = new Date().toLocaleTimeString('pl-PL');
    d.textContent = '[' + time + '] ' + text;
    log.appendChild(d);
    log.scrollTop = log.scrollHeight;
  }

  // ── Render tabeli ──
  function renderTable() {
    if (!accounts.length) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#9ca3af;padding:20px">Brak danych</td></tr>';
      return;
    }

    tbody.innerHTML = accounts.map((a, i) => {
      const ignored = ignoredNips.has(a.nip);
      const status = ignored ? 'ignored' : a.status;
      const badge = {
        pending:    '<span class="badge badge-pending">pending</span>',
        in_progress:'<span class="badge badge-progress">⏳ w toku</span>',
        done:       '<span class="badge badge-done">✓ done</span>',
        ignored:    '<span class="badge badge-ignored">ignoruj</span>',
        error:      '<span class="badge badge-error">błąd</span>',
      }[status] || '';

      let saldoHtml = '—';
      if (a.saldo !== null && a.saldo !== undefined) {
        const cls = a.saldo >= 0 ? 'saldo-pos' : 'saldo-neg';
        const sign = a.saldo > 0 ? '+' : '';
        saldoHtml = '<span class="' + cls + '">' + sign + Number(a.saldo).toFixed(2) + ' zł</span>';
      }

      let sumaHtml = '—';
      if (a.paymentsSum !== null && a.paymentsSum !== undefined && a.status === 'done') {
        sumaHtml = Number(a.paymentsSum).toFixed(2) + ' zł';
      }

      return '<tr>' +
        '<td style="text-align:center"><input type="checkbox" ' + (ignored ? 'checked' : '') +
          ' onchange="toggleIgnore(' + i + ', this.checked)"></td>' +
        '<td title="' + a.name + '">' + (a.name.length > 20 ? a.name.slice(0,20)+'…' : a.name) + '</td>' +
        '<td>' + a.nip + '</td>' +
        '<td>' + badge + '</td>' +
        '<td>' + saldoHtml + '</td>' +
        '<td>' + sumaHtml + '</td>' +
      '</tr>';
    }).join('');

    const done = accounts.filter(a => a.status === 'done').length;
    const total = accounts.length;
    counter.textContent = total + ' kont | ' + done + ' done';

    btnStart.disabled  = running || !accounts.some(a => a.status === 'pending' && !ignoredNips.has(a.nip));
    btnExport.disabled = done === 0;
  }

  window.toggleIgnore = function(index, checked) {
    const nip = accounts[index].nip;
    if (checked) ignoredNips.add(nip);
    else ignoredNips.delete(nip);
    renderTable();
  };

  // ── Pętla ──
  function nextPendingIndex() {
    return accounts.findIndex((a, i) => i >= currentIndex && a.status === 'pending' && !ignoredNips.has(a.nip));
  }

  function startProcessing() {
    if (running) return;
    running = true;
    stopped = false;
    currentIndex = 0;
    btnStart.disabled = true;
    btnStop.disabled  = false;
    addLog('Start przetwarzania...');
    processNext();
  }

  function processNext() {
    if (stopped) { running = false; btnStart.disabled = false; btnStop.disabled = true; addLog('Zatrzymano.'); return; }
    const idx = nextPendingIndex();
    if (idx === -1) {
      running = false;
      btnStart.disabled = false;
      btnStop.disabled  = true;
      addLog('Wszystkie konta przetworzone!', 'ok');
      return;
    }
    currentIndex = idx;
    accounts[idx].status = 'in_progress';
    renderTable();
    ch.postMessage({ type: 'process', index: idx, ignoredNips: [...ignoredNips] });
  }

  function stopProcessing() {
    stopped = true;
    btnStop.disabled = true;
  }

  // ── Export ──
  function exportNow() {
    ch.postMessage({ type: 'export_request' });
  }

  function downloadXLSX(base64data) {
    const binary = atob(base64data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    const now  = new Date();
    const date = now.toISOString().slice(0, 10);
    const time = now.toTimeString().slice(0, 5).replace(':', '-');
    a.download = 'zus_scraper_' + date + '_' + time + '.xlsx';
    a.click();
    URL.revokeObjectURL(url);
  }

  // ── BroadcastChannel ──
  ch.onmessage = function(e) {
    const d = e.data;

    if (d.type === 'log') {
      addLog(d.text, d.text.startsWith('✓') ? 'ok' : '');
    }

    if (d.type === 'accounts' || d.type === 'state') {
      if (d.accounts) accounts = d.accounts;
      if (d.state && d.state.accounts) accounts = d.state.accounts;
      renderTable();
    }

    if (d.type === 'status') {
      if (accounts[d.index]) {
        accounts[d.index].status = d.status;
        if (d.saldo !== undefined) accounts[d.index].saldo = d.saldo;
      }
      renderTable();
    }

    if (d.type === 'processed') {
      accounts[d.index].status = 'done';
      if (d.paymentsSum !== undefined) accounts[d.index].paymentsSum = d.paymentsSum;
      renderTable();

      // Auto-continue
      if (chkAuto.checked && !stopped) {
        currentIndex = d.index + 1;
        const nextIdx = accounts.findIndex((a, i) => i >= currentIndex && a.status === 'pending' && !ignoredNips.has(a.nip));
        if (nextIdx === -1) {
          // Wszystkie done — zakończ i auto-export jeśli zaznaczony
          running = false;
          btnStart.disabled = false;
          btnStop.disabled  = true;
          addLog('Wszystkie konta przetworzone!', 'ok');
          if (chkExport.checked) {
            addLog('Auto-export: pobieranie pliku...');
            exportNow();
          }
        } else {
          setTimeout(processNext, 800);
        }
      } else {
        running = false;
        btnStart.disabled = false;
        btnStop.disabled  = true;
      }
    }

    if (d.type === 'error') {
      accounts[d.index].status = 'error';
      addLog('BŁĄD [' + (accounts[d.index]?.name || d.index) + ']: ' + d.text, 'error');
      renderTable();

      // Mimo błędu idź dalej jeśli auto-continue
      if (chkAuto.checked && !stopped) {
        currentIndex = d.index + 1;
        const nextIdx = accounts.findIndex((a, i) => i >= currentIndex && a.status === 'pending' && !ignoredNips.has(a.nip));
        if (nextIdx === -1) {
          running = false;
          btnStart.disabled = false;
          btnStop.disabled  = true;
          addLog('Przetwarzanie zakończone (z błędami).', 'ok');
          if (chkExport.checked) {
            addLog('Auto-export: pobieranie pliku...');
            exportNow();
          }
        } else {
          setTimeout(processNext, 800);
        }
      } else {
        running = false;
        btnStart.disabled = false;
        btnStop.disabled  = true;
      }
    }

    if (d.type === 'reset_done') {
      addLog('Stan wyczyszczony — kliknij "Stwórz listę kont" aby zacząć od nowa.');
      btnStart.disabled = true;
      btnExport.disabled = true;
    }

    if (d.type === 'export_data') {
      downloadXLSX(d.data);
    }
  };

  // ── Przyciski ──
  btnCollect.addEventListener('click', () => {
    accounts = [];
    renderTable();
    ch.postMessage({ type: 'collect' });
  });

  btnReset.addEventListener('click', () => {
    if (!confirm('Wyczyścić cały stan scraperа?')) return;
    accounts = [];
    ignoredNips.clear();
    running = false;
    stopped = false;
    currentIndex = 0;
    renderTable();
    addLog('Stan wyczyszczony.');
    ch.postMessage({ type: 'reset' });
  });

  btnStart.addEventListener('click',  startProcessing);
  btnStop.addEventListener('click',   stopProcessing);
  btnExport.addEventListener('click', exportNow);

  // ── Init: pobierz stan z karty ZUS ──
  ch.postMessage({ type: 'get_state' });
  addLog('Panel gotowy. Kliknij "Stwórz listę kont" aby rozpocząć.');
</script>
</body>
</html>`;
  }

})();