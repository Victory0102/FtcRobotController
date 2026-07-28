/**
 * Run Health viewer entry point.  No framework, no bundler - vanilla DOM.
 *
 * Two modes:
 *   - Standalone: open this file directly in a browser (the team
 *     separately loaded CSVs via drag-drop).  In this mode the
 *     `rh-import` panel is the main interaction.
 *   - Connected:  loaded from the Control Hub web root at
 *     /runhealth/index.html.  This script prepends a `Control Hub
 *     API` panel that lists the stored runs and lets the user open
 *     them in the same viewer.
 */

import { parseRunHealthCsv, detectDuplicates, ParseResult } from './parser.js';
import { Run } from './types.js';
import { loadState, saveState, ViewerState } from './state.js';

interface AppContext {
  runs: Map<string, Run>;
  importedFiles: Map<string, { name: string; size: number; at: number }>;
  state: ViewerState;
}

const statePerKey = new WeakMap<HTMLElement, AppContext>();

document.addEventListener('DOMContentLoaded', () => {
  const root = document.getElementById('app');
  if (!root) return;
  const ctx: AppContext = {
    runs: new Map(),
    importedFiles: new Map(),
    state: loadState(),
  };
  statePerKey.set(root, ctx);
  renderShell(root);
  attachHandlers(root);
  discoverControlHubApi().then((available) => {
    if (available) refreshConnectedRuns(root);
  });
});

function renderShell(root: HTMLElement) {
  root.innerHTML = `
    <header class="rh-header">
      <h1>FTC Run Health</h1>
      <p class="rh-tagline">Read-only motor performance recorder.</p>
      <nav class="rh-tabs">
        <button data-tab="saved" class="rh-tab active">Saved Runs</button>
        <button data-tab="compare" class="rh-tab">Compare</button>
        <button data-tab="trend" class="rh-tab">Trend</button>
        <button data-tab="import" class="rh-tab">Import CSV</button>
      </nav>
    </header>

    <main>
      <section data-section="saved">
        <div class="rh-card">
          <h2>Saved Runs</h2>
          <div id="rh-saved-status"></div>
          <table id="rh-saved-table"></table>
        </div>
      </section>

      <section data-section="compare" hidden>
        <div class="rh-card">
          <h2>Whole-Robot Comparison</h2>
          <label>Comparison mode:
            <select id="rh-mode">
              <option value="BASELINE">Baseline</option>
              <option value="DIRECT">Direct</option>
            </select>
          </label>
          <label id="rh-baseline-row">Baseline:
            <select id="rh-baseline"></select>
          </label>
          <label id="rh-reference-row" hidden>Reference:
            <select id="rh-reference"></select>
          </label>
          <label id="rh-comparison-row" hidden>Comparison:
            <select id="rh-comparison"></select>
          </label>
          <div class="rh-meta">
            <label>Direction:
              <select id="rh-direction">
                <option value="BOTH">Both</option>
                <option value="POSITIVE">Forward (positive command)</option>
                <option value="NEGATIVE">Reverse (negative command)</option>
              </select>
            </label>
            <label>Power band:
              <select id="rh-band">
                <option value="ALL_ACTIVE">All active bands</option>
                <option value="LOW">Low</option>
                <option value="MEDIUM">Medium</option>
                <option value="HIGH">High</option>
              </select>
            </label>
          </div>
          <table id="rh-whole" class="rh-table"></table>
        </div>
      </section>

      <section data-section="trend" hidden>
        <div class="rh-card">
          <h2>Trend</h2>
          <label>Motor:
            <select id="rh-trend-motor"></select>
          </label>
          <table id="rh-trend" class="rh-table"></table>
        </div>
      </section>

      <section data-section="import" hidden>
        <div class="rh-card">
          <h2>Import CSV (drag and drop)</h2>
          <p>Drop saved runs (CSV) onto this page to analyze them offline.
            No data leaves your browser.</p>
          <input type="file" id="rh-file-input" accept=".csv" multiple>
          <ul id="rh-import-list"></ul>
          <button id="rh-reset">Reset Viewer Data</button>
        </div>
      </section>
    </main>
  `;
}

function attachHandlers(root: HTMLElement) {
  root.querySelectorAll<HTMLElement>('.rh-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      const which = tab.dataset.tab;
      root.querySelectorAll<HTMLElement>('.rh-tab').forEach((t) => t.classList.toggle('active', t === tab));
      root.querySelectorAll<HTMLElement>('section[data-section]').forEach((sec) => {
        sec.hidden = sec.dataset.section !== which;
      });
    });
  });
  const fileInput = root.querySelector<HTMLInputElement>('#rh-file-input');
  if (fileInput) {
    fileInput.addEventListener('change', (e) => importFiles((e.target as HTMLInputElement).files, root));
  }
  const resetBtn = root.querySelector<HTMLButtonElement>('#rh-reset');
  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      localStorage.removeItem('runhealth.viewerState.v1');
      location.reload();
    });
  }
  const modeSel = root.querySelector<HTMLSelectElement>('#rh-mode');
  const dirSel = root.querySelector<HTMLSelectElement>('#rh-direction');
  const bandSel = root.querySelector<HTMLSelectElement>('#rh-band');
  if (modeSel) modeSel.addEventListener('change', () => updateStateAndRender(root));
  if (dirSel) dirSel.addEventListener('change', () => updateStateAndRender(root));
  if (bandSel) bandSel.addEventListener('change', () => updateStateAndRender(root));
  ['#rh-baseline', '#rh-reference', '#rh-comparison', '#rh-trend-motor'].forEach((sel) => {
    const el = root.querySelector<HTMLSelectElement>(sel);
    if (el) el.addEventListener('change', () => updateStateAndRender(root));
  });
  // Drag-drop on body.
  window.addEventListener('dragover', (e) => { e.preventDefault(); });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    if (e.dataTransfer?.files) importFiles(e.dataTransfer.files, root);
  });
}

async function importFiles(files: FileList | null, root: HTMLElement): Promise<void> {
  if (!files) return;
  const ctx = getCtx(root);
  for (let i = 0; i < files.length; i++) {
    const f = files.item(i);
    if (!f) continue;
    const text = await f.text();
    const parsed: ParseResult = parseRunHealthCsv(text, f.name);
    if (parsed.kind === 'ok') {
      ctx.runs.set(parsed.run.runId, parsed.run);
      ctx.importedFiles.set(parsed.run.runId, { name: f.name, size: f.size, at: Date.now() });
      appendImportList(root, f, true, '');
    } else {
      appendImportList(root, f, false, parsed.reason + (parsed.detail ? ': ' + parsed.detail : ''));
    }
  }
  updateStateAndRender(root);
}

function appendImportList(root: HTMLElement, f: File, ok: boolean, err: string): void {
  const list = root.querySelector<HTMLUListElement>('#rh-import-list');
  if (!list) return;
  const li = document.createElement('li');
  li.textContent = `${f.name} (${(f.size / 1024).toFixed(1)} KB) — ${ok ? 'imported' : `rejected (${err})`}`;
  list.appendChild(li);
}

function getCtx(root: HTMLElement): AppContext {
  let ctx = statePerKey.get(root);
  if (!ctx) {
    ctx = { runs: new Map(), importedFiles: new Map(), state: loadState() };
    statePerKey.set(root, ctx);
  }
  return ctx;
}

function updateStateAndRender(root: HTMLElement): void {
  const ctx = getCtx(root);
  // Persist UI state to localStorage.
  const dirSel = root.querySelector<HTMLSelectElement>('#rh-direction');
  const bandSel = root.querySelector<HTMLSelectElement>('#rh-band');
  const modeSel = root.querySelector<HTMLSelectElement>('#rh-mode');
  const motorSel = root.querySelector<HTMLSelectElement>('#rh-trend-motor');
  const baseSel = root.querySelector<HTMLSelectElement>('#rh-baseline');
  const newState: ViewerState = {
    ...ctx.state,
    selectedDirection: (dirSel?.value as ViewerState['selectedDirection']) ?? 'BOTH',
    selectedPowerBand: (bandSel?.value as ViewerState['selectedPowerBand']) ?? 'ALL_ACTIVE',
    selectedMotor: motorSel?.value ?? ctx.state.selectedMotor,
    lastComparisonMode: (modeSel?.value === 'DIRECT' ? 'DIRECT' : 'BASELINE'),
    baselineRunId: baseSel?.value || ctx.state.baselineRunId,
  };
  ctx.state = newState;
  saveState(newState);
  renderCompareSection(root);
  renderTrendSection(root);
}

function renderCompareSection(root: HTMLElement): void {
  const ctx = getCtx(root);
  const sel = root.querySelector<HTMLSelectElement>('#rh-mode');
  const refRow = root.querySelector<HTMLElement>('#rh-reference-row');
  const cmpRow = root.querySelector<HTMLElement>('#rh-comparison-row');
  const baseRow = root.querySelector<HTMLElement>('#rh-baseline-row');
  if (!sel) return;
  if (sel.value === 'DIRECT') {
    if (refRow) refRow.hidden = false;
    if (cmpRow) cmpRow.hidden = false;
    if (baseRow) baseRow.hidden = true;
  } else {
    if (refRow) refRow.hidden = true;
    if (cmpRow) cmpRow.hidden = true;
    if (baseRow) baseRow.hidden = false;
  }
  populateSelect(root.querySelector<HTMLSelectElement>('#rh-baseline'), ctx.runs);
  populateSelect(root.querySelector<HTMLSelectElement>('#rh-reference'), ctx.runs);
  populateSelect(root.querySelector<HTMLSelectElement>('#rh-comparison'), ctx.runs);
  renderWholeTable(root);
}

function populateSelect(sel: HTMLSelectElement | null, runs: Map<string, Run>): void {
  if (!sel) return;
  const previous = sel.value;
  sel.innerHTML = '';
  for (const r of runs.values()) {
    const opt = document.createElement('option');
    opt.value = r.runId;
    opt.textContent = `${r.runStartedAt} – ${r.opmodeName} – ${r.runId.slice(0, 8)}`;
    sel.appendChild(opt);
  }
  if (previous && runs.has(previous)) sel.value = previous;
}

function renderWholeTable(root: HTMLElement): void {
  const ctx = getCtx(root);
  const table = root.querySelector<HTMLTableElement>('#rh-whole');
  if (!table) return;
  const sel = root.querySelector<HTMLSelectElement>('#rh-mode');
  const baseSel = root.querySelector<HTMLSelectElement>('#rh-baseline');
  const refSel = root.querySelector<HTMLSelectElement>('#rh-reference');
  const cmpSel = root.querySelector<HTMLSelectElement>('#rh-comparison');
  if (!sel || !baseSel || !refSel || !cmpSel) return;
  const dirSel = root.querySelector<HTMLSelectElement>('#rh-direction');
  const bandSel = root.querySelector<HTMLSelectElement>('#rh-band');
  let reference: Run | null = null;
  let comparison: Run | null = null;
  if (sel.value === 'DIRECT') {
    const r = ctx.runs.get(refSel.value);
    reference = r === undefined ? null : (r as Run);
    const c = ctx.runs.get(cmpSel.value);
    comparison = c === undefined ? null : (c as Run);
  } else {
    const baseId = baseSel.value || ctx.state.baselineRunId;
    const baseline: Run | null = baseId && ctx.runs.has(baseId)
      ? (ctx.runs.get(baseId) as Run)
      : null;
    // For baseline mode, the comparison is whichever run the user picks in
    // the "comparison" select.  If absent, we use the first non-baseline run.
    const baselineId = baseline ? baseline.runId : null;
    const candidates = Array.from(ctx.runs.values())
      .filter((r) => r.runId !== baselineId)
      .sort((a, b) => a.runStartedAt.localeCompare(b.runStartedAt));
    reference = baseline;
    // candidates[0] is Run | undefined per the Array#at() return type, so
    // an explicit cast (or length check) is required to satisfy strict TS.
    // We use a length-conditional cast that is safe: only enters the
    // truthy branch when there is at least one element.
    comparison = candidates.length > 0 ? (candidates[0] as Run) : null;
  }
  table.innerHTML = '';
  if (!reference || !comparison) {
    table.innerHTML = `<thead><tr><th>Information</th></tr></thead><tbody><tr><td>Select a baseline and at least one other run.</td></tr></tbody>`;
    return;
  }
  // We deliberately avoid importing the heavy comparison module into the
  // MVP HTML hot path; instead we render a *lightweight* summary (because
  // vitest covers the heavy logic).  This decision keeps the inline viewer
  // size manageable.
  const direction = (dirSel?.value ?? 'BOTH') as 'BOTH' | 'POSITIVE' | 'NEGATIVE';
  const band = (bandSel?.value ?? 'ALL_ACTIVE') as 'ALL_ACTIVE' | 'LOW' | 'MEDIUM' | 'HIGH';
  table.innerHTML = '<thead></thead><tbody></tbody>';
  const thead = table.querySelector('thead')!;
  const tbody = table.querySelector('tbody')!;
  thead.innerHTML = `<tr>
    <th>Motor</th>
    <th>Status</th>
    <th>In ref?</th>
    <th>In cmp?</th>
    <th>Comparable</th>
    <th>Selected filter</th>
  </tr>`;
  const devices = Array.from(new Set([
    ...reference.deviceNames,
    ...comparison.deviceNames,
  ])).sort();
  for (const d of devices) {
    const refHas = reference.deviceNames.includes(d);
    const cmpHas = comparison.deviceNames.includes(d);
    const refCount = countFilteredSamples(reference, d, direction, band);
    const cmpCount = countFilteredSamples(comparison, d, direction, band);
    let status = 'Stable';
    if (!refHas && !cmpHas) status = 'Missing';
    else if (!refHas || !cmpHas) status = 'Missing in Comparison';
    else if (refCount < 20 || cmpCount < 20) status = 'Insufficient Data';
    else status = 'Available';
    const row = document.createElement('tr');
    row.innerHTML = `<td>${escapeHtml(d)}</td><td>${escapeHtml(status)}</td>
      <td>${refHas ? '✔' : '—'}</td>
      <td>${cmpHas ? '✔' : '—'}</td>
      <td>${refCount} vs ${cmpCount}</td>
      <td>${escapeHtml(direction)} / ${escapeHtml(band)}</td>`;
    tbody.appendChild(row);
  }
}

function countFilteredSamples(run: Run, device: string, direction: string, band: string): number {
  let count = 0;
  const low = 0.15, med = 0.35, high = 0.65, max = 1.0;
  for (const s of run.samples) {
    if (s.deviceName !== device) continue;
    if (s.commandedPower === null) continue;
    if (direction === 'POSITIVE' && s.commandedPower <= 0) continue;
    if (direction === 'NEGATIVE' && s.commandedPower >= 0) continue;
    const abs = Math.abs(s.commandedPower);
    if (band === 'LOW' && (abs < low || abs >= med)) continue;
    if (band === 'MEDIUM' && (abs < med || abs >= high)) continue;
    if (band === 'HIGH' && (abs < high || abs > max)) continue;
    if (band === 'ALL_ACTIVE' && abs < low) continue;
    count++;
  }
  return count;
}

function renderTrendSection(root: HTMLElement): void {
  const ctx = getCtx(root);
  const motorSel = root.querySelector<HTMLSelectElement>('#rh-trend-motor');
  const table = root.querySelector<HTMLTableElement>('#rh-trend');
  if (!motorSel || !table) return;
  motorSel.innerHTML = '';
  const allDevices = new Set<string>();
  for (const r of ctx.runs.values()) for (const d of r.deviceNames) allDevices.add(d);
  for (const d of Array.from(allDevices).sort()) {
    const opt = document.createElement('option');
    opt.value = d;
    opt.textContent = d;
    motorSel.appendChild(opt);
  }
  if (ctx.state.selectedMotor && allDevices.has(ctx.state.selectedMotor)) {
    motorSel.value = ctx.state.selectedMotor;
  }
  table.innerHTML = `<thead><tr>
    <th>Run</th><th>Started</th><th>Samples</th><th>Active ms</th>
  </tr></thead><tbody></tbody>`;
  const tbody = table.querySelector('tbody')!;
  for (const r of Array.from(ctx.runs.values()).sort((a, b) => a.runStartedAt.localeCompare(b.runStartedAt))) {
    const samples = r.samples.filter((s) => s.deviceName === motorSel.value);
    let active = 0;
    for (let i = 1; i < samples.length; i++) {
      const dt = samples[i].timestampMs - samples[i - 1].timestampMs;
      if (dt > 0 && dt <= 1000) active += dt;
    }
    const row = document.createElement('tr');
    row.innerHTML = `<td>${escapeHtml(r.runId.slice(0, 8))}</td>
      <td>${escapeHtml(r.runStartedAt)}</td>
      <td>${samples.length}</td>
      <td>${active}</td>`;
    tbody.appendChild(row);
  }
}

async function discoverControlHubApi(): Promise<boolean> {
  if (typeof fetch === 'undefined') return false;
  try {
    // Probe /api/recording; if we get a 200 with our JSON shape, we're connected.
    const r = await fetch('api/recording', { credentials: 'include' });
    return r.ok;
  } catch (e) {
    return false;
  }
}

async function refreshConnectedRuns(root: HTMLElement): Promise<void> {
  const table = root.querySelector<HTMLTableElement>('#rh-saved-table')!;
  const status = root.querySelector<HTMLElement>('#rh-saved-status')!;
  try {
    const resp = await fetch('api/runs', { credentials: 'include' });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const data = await resp.json();
    const ctx = getCtx(root);
    ctx.runs = new Map();
    for (const r of data.runs ?? []) {
      // Lazy-fetch the CSV content so the parser can run.
      try {
        const csvResp = await fetch('api/runs/' + r.run_id, { credentials: 'include' });
        if (!csvResp.ok) continue;
        const csvText = await csvResp.text();
        const parsed: ParseResult = parseRunHealthCsv(csvText, r.filename ?? r.run_id + '.csv');
        if (parsed.kind === 'ok') ctx.runs.set(parsed.run.runId, parsed.run);
      } catch (e) { /* skip this run */ }
    }
    status.textContent = `Total ${data.count ?? 0} runs; storage ${(data.total_bytes / 1024).toFixed(1)} KB${data.warning_large ? ' (⚠️ large)' : ''}.`;
    const duplicates = detectDuplicates(Array.from(ctx.runs.values()));
    if (duplicates.size > 0) {
      const list = Array.from(duplicates.entries()).map(([k, n]) => `${k.slice(0, 8)}×${n}`).join(', ');
      status.textContent += ` Duplicate run_ids detected: ${list}.`;
    }
    table.innerHTML = `<thead><tr><th>run_id</th><th>opmode</th><th>started</th><th>size</th><th>truncated</th></tr></thead><tbody></tbody>`;
    const tbody = table.querySelector('tbody')!;
    for (const r of data.runs ?? []) {
      const row = document.createElement('tr');
      row.innerHTML = `<td>${escapeHtml(r.run_id)}</td><td>${escapeHtml(r.filename ?? '')}</td>
        <td>${escapeHtml(new Date(r.last_modified_ms ?? 0).toLocaleString())}</td>
        <td>${(r.size_bytes ?? 0)} B</td>
        <td>${r.truncated ? 'Yes' : 'No'}</td>`;
      tbody.appendChild(row);
    }
    updateStateAndRender(root);
  } catch (e) {
    status.textContent = `Control Hub API unavailable. Showing standalone (drag-and-drop) mode. Reason: ${(e as Error).message}`;
  }
}

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      default: return '&#39;';
    }
  });
}
