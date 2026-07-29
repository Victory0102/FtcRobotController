/**
 * FTC Run Health viewer entry point.  Vanilla TypeScript, no framework,
 * no bundler — single bundled assets/main.js is loaded from
 * /runhealth/index.html.
 *
 * Architecture:
 *   - Two modes: standalone (drag-drop CSVs) and connected (the file is
 *     loaded from the Control Hub web root and can call /api/*).
 *   - Eight tabs: Live, Saved Runs, Compare, Replay, Channels, Field, Trends, Import.
 *   - One shared replay clock (replay.globalReplayClock) drives every
 *     visualisation that participates in the replay panel.
 *   - All cross-run comparison numbers come from comparison.wholeRobotComparison
 *     and trends.* builders.  The renderer never re-derives a metric.
 */
import { parseRunHealthCsv, detectDuplicates, } from './parser.js';
import { wholeRobotComparison, perMotorTrend, } from './comparison.js';
import { motorMetricSeries, defaultColor, seriesDomain, downsample, drawSeries, } from './graphs.js';
import { drawField, poseSeriesToPath, DEFAULT_ZOOM_PAN, } from './field.js';
import { globalReplayClock, lookupNumeric, lookupBoolean, lookupText, lookupPose, runDurationMs, PLAYBACK_SPEEDS, } from './replay.js';
import { applyDeltas, customChannelTrend, } from './trends.js';
import { LivePoller, LiveStore, liveSnapshotStats, safeText, LIVE_LIMITS, } from './live.js';
import { getStatusClass, getStatusLabel } from './status.js';
import { formatPower, formatTps, formatAmps, formatFractionPct, formatFractionPctSigned, formatSignedDiff, } from './format.js';
import { buildCompareSummary, buildImportSummary, buildLiveSummaryChips, buildMotorCardDescriptors, buildConditionRows, } from './cards.js';
import { analyzeLiveConditions, } from './observations.js';
const statePerKey = new WeakMap();
/* =========================================================== entry */
document.addEventListener('DOMContentLoaded', () => {
    const root = document.getElementById('app');
    if (!root)
        return;
    const ctx = {
        runs: new Map(),
        importedFiles: new Map(),
        replayByRun: new Map(),
    };
    statePerKey.set(root, ctx);
    renderShell(root);
    attachHandlers(root);
    discoverControlHubApi().then((available) => {
        if (available)
            refreshConnectedRuns(root);
    });
});
/* =========================================================== tabs / shell */
const TABS = [
    { id: 'live', label: 'Live' },
    { id: 'saved', label: 'Saved Runs' },
    { id: 'compare', label: 'Compare' },
    { id: 'replay', label: 'Replay' },
    { id: 'channels', label: 'Channels' },
    { id: 'field', label: 'Field' },
    { id: 'trend', label: 'Trends' },
    { id: 'import', label: 'Import' },
];
function renderShell(root) {
    const tabs = TABS.map((t, i) => `<button data-tab="${t.id}" class="rh-tab${i === 0 ? ' active' : ''}">${escapeHtml(t.label)}</button>`).join('');
    root.innerHTML = `
    <header class="rh-header">
      <h1>FTC Run Health</h1>
      <p class="rh-tagline">Read-only robot observability, recording, replay, and diagnostics.</p>
      <p class="rh-descriptor">Understand what changed. Inspect the evidence. Keep the robot under team control.</p>
      <nav class="rh-tabs">${tabs}</nav>
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
          <p class="rh-card__subtitle">Select a baseline and another run to compare. Read the summary chips first, expand a motor for the detailed metric table.</p>
          <label>Mode:
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
                <option value="POSITIVE">Forward</option>
                <option value="NEGATIVE">Reverse</option>
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
            <label>Motor (graphs):
              <select id="rh-graph-motor"></select>
            </label>
          </div>
          <div id="rh-compare-summary" class="rh-grid--summary" aria-live="polite"></div>
          <div id="rh-compare-cards" class="rh-compare-cards" aria-live="polite"></div>
          <details id="rh-compare-details-wrap">
            <summary class="rh-compare-summary-title">Detailed metric table</summary>
            <p class="rh-card__subtitle">All 25 metrics per motor in one dense view. The collapsible cards above are usually easier to read.</p>
            <table id="rh-whole" class="rh-table"></table>
          </details>
          <div class="rh-card-inner">
            <h3>Motor graphs</h3>
            <canvas id="rh-graph-canvas" class="rh-canvas"></canvas>
          </div>
        </div>
      </section>

      <section data-section="replay" hidden>
        <div class="rh-card">
          <h2>Replay</h2>
          <p class="rh-replay-banner-note" role="note">Replay displays recorded data only. It does not send commands to the robot.</p>
          <label>Run:
            <select id="rh-replay-run"></select>
          </label>
          <div class="rh-replay-toolbar rh-replay-controls">
            <button id="rh-replay-play">Play</button>
            <button id="rh-replay-pause">Pause</button>
            <button id="rh-replay-restart">Restart</button>
            <label>Speed:
              <select id="rh-replay-speed">
                ${PLAYBACK_SPEEDS.map((s) => `<option value="${s}"${s === 1 ? ' selected' : ''}>${s}x</option>`).join('')}
              </select>
            </label>
            <span id="rh-replay-time" class="rh-replay-clock">0 / 0 ms</span>
          </div>
          <input id="rh-replay-scrubber" type="range" min="0" max="1000" value="0">
          <div class="rh-card-inner">
            <h3>Motor graphs at replay time</h3>
            <canvas id="rh-replay-canvas" class="rh-canvas"></canvas>
          </div>
          <h3>Live values</h3>
          <table id="rh-replay-values" class="rh-table"></table>
        </div>
      </section>

      <section data-section="channels" hidden>
        <div class="rh-card">
          <h2>Custom Channels (selected run)</h2>
          <label>Run:
            <select id="rh-channels-run"></select>
          </label>
          <div id="rh-channel-cards"></div>
        </div>
      </section>

      <section data-section="field" hidden>
        <div class="rh-card">
          <h2>Generic 12 ft × 12 ft Field View</h2>
          <div class="rh-meta">
            <button id="rh-field-reset">Reset</button>
            <button id="rh-field-fit">Fit to content</button>
            <button id="rh-field-zoomin">Zoom +</button>
            <button id="rh-field-zoomout">Zoom −</button>
          </div>
          <div class="rh-field-square-wrap">
            <canvas id="rh-field-canvas" class="rh-canvas rh-field-canvas"></canvas>
          </div>
        </div>
      </section>

      <section data-section="trend" hidden>
        <div class="rh-card">
          <h2>Trends</h2>
          <label>Motor:
            <select id="rh-trend-motor"></select>
          </label>
          <label>Series:
            <select id="rh-trend-series">
              <option value="medianVelocity">Median velocity</option>
              <option value="velocityEfficiency">Velocity efficiency</option>
              <option value="currentCost">Current cost</option>
              <option value="p95Current">P95 current</option>
              <option value="possibleStallPct">Stall %</option>
              <option value="batteryMin">Battery min</option>
              <option value="batteryMedian">Battery median</option>
              <option value="loopTimeMsMedian">Loop-time median (ms)</option>
              <option value="loopTimeMsP95">Loop-time p95 (ms)</option>
            </select>
          </label>
          <table id="rh-trend" class="rh-table"></table>
          <div class="rh-card-inner">
            <h3>Trend chart</h3>
            <canvas id="rh-trend-canvas" class="rh-canvas"></canvas>
          </div>
        </div>
      </section>

      <section data-section="import" hidden>
        <div class="rh-card">
          <h2>Import recordings</h2>
          <p class="rh-card__subtitle">Analyze recordings locally in this browser. Files are not uploaded anywhere.</p>
          <div id="rh-import-dnd" class="rh-dnd-area" role="button" tabindex="0"
               aria-label="Drag and drop Run Health recording files here, or press Enter / Space to browse">
            <p class="rh-dnd-area__title">Drag and drop Run Health recordings here</p>
            <p class="rh-dnd-area__hint">or press Enter / Space to browse. Accepted: motor CSV, channels companion (.channels.csv), manifest companion (.manifest.json). Older motor-only CSV recordings remain supported.</p>
            <p>
              <button type="button" id="rh-import-browse">Browse files</button>
              <input type="file" id="rh-file-input"
                     accept=".csv,.channels.csv,.manifest.json" multiple hidden>
            </p>
            <div id="rh-import-status" class="rh-meta" aria-live="polite">
              <div><span class="rh-meta-label">Recognized files</span><span id="rh-import-recognized" class="rh-meta-value">0</span></div>
              <div><span class="rh-meta-label">Imported runs</span><span id="rh-import-runs" class="rh-meta-value">0</span></div>
              <div><span class="rh-meta-label">Warnings</span><span id="rh-import-warnings" class="rh-meta-value">0</span></div>
            </div>
            <ul id="rh-import-list" class="rh-import-list" aria-live="polite"></ul>
          </div>
          <p class="rh-empty-actions">
            <button type="button" id="rh-import-open" disabled>Open latest imported run</button>
            <button type="button" id="rh-reset">Clear imported recordings</button>
          </p>
        </div>
      </section>
    </main>
  `;
}
function attachHandlers(root) {
    root.querySelectorAll('.rh-tab').forEach((tab) => {
        tab.addEventListener('click', () => {
            sectionSwitch(root, tab.dataset.tab);
        });
    });
    root.querySelector('#rh-file-input')
        ?.addEventListener('change', (e) => importFiles(e.target.files, root));
    root.querySelector('#rh-reset')
        ?.addEventListener('click', () => {
        if (!confirm('Clear imported recordings from this browser?'))
            return;
        const ctx = getCtx(root);
        ctx.importedFiles.clear();
        ctx.runs.clear();
        localStorage.clear();
        location.reload();
    });
    // Import drag-and-drop area - real button + keyboard + drop wiring.
    const dnd = root.querySelector('#rh-import-dnd');
    const dndBrowse = root.querySelector('#rh-import-browse');
    const dndFileInput = root.querySelector('#rh-file-input');
    dndBrowse?.addEventListener('click', () => dndFileInput?.click());
    dnd?.addEventListener('click', (e) => {
        // Ignore the inner Browse button click bubbling.
        if (e.target.closest('button'))
            return;
        dndFileInput?.click();
    });
    dnd?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            dndFileInput?.click();
        }
    });
    // Area-level drag-and-drop visual feedback; window-level handler below also
    // dispatches to importFiles so behaviour matches for anywhere on the page.
    dnd?.addEventListener('dragenter', () => dnd.classList.add('rh-dnd-area--active'));
    dnd?.addEventListener('dragover', (e) => {
        e.preventDefault();
        dnd.classList.add('rh-dnd-area--active');
    });
    dnd?.addEventListener('dragleave', () => dnd.classList.remove('rh-dnd-area--active'));
    dnd?.addEventListener('drop', () => dnd.classList.remove('rh-dnd-area--active'));
    // Open latest imported run = jump to the Replay tab + attach the run.
    root.querySelector('#rh-import-open')
        ?.addEventListener('click', () => {
        const ctx = getCtx(root);
        const last = Array.from(ctx.importedFiles.keys()).pop();
        if (!last)
            return;
        sectionSwitch(root, 'replay');
        attachReplayRun(root, last);
    });
    ['#rh-mode', '#rh-direction', '#rh-band', '#rh-baseline', '#rh-reference',
        '#rh-comparison', '#rh-trend-motor', '#rh-trend-series', '#rh-graph-motor',
    ].forEach((sel) => {
        const el = root.querySelector(sel);
        if (el)
            el.addEventListener('change', () => updateStateAndRender(root));
    });
    // Replay panel handlers.
    root.querySelector('#rh-replay-play')
        ?.addEventListener('click', () => globalReplayClock.play());
    root.querySelector('#rh-replay-pause')
        ?.addEventListener('click', () => globalReplayClock.pause());
    root.querySelector('#rh-replay-restart')
        ?.addEventListener('click', () => globalReplayClock.restart());
    root.querySelector('#rh-replay-speed')
        ?.addEventListener('change', (e) => {
        globalReplayClock.setSpeed(Number(e.target.value));
    });
    root.querySelector('#rh-replay-scrubber')
        ?.addEventListener('input', (e) => {
        const t = Number(e.target.value);
        const total = globalReplayClock.getDuration();
        globalReplayClock.seek((t / 1000) * total);
    });
    root.querySelector('#rh-replay-run')
        ?.addEventListener('change', (e) => attachReplayRun(root, e.target.value));
    // Field view controls.
    let fieldZp = { ...DEFAULT_ZOOM_PAN };
    const redrawField = () => renderFieldView(root, fieldZp);
    root.querySelector('#rh-field-reset')
        ?.addEventListener('click', () => { fieldZp = { ...DEFAULT_ZOOM_PAN }; redrawField(); });
    root.querySelector('#rh-field-fit')
        ?.addEventListener('click', () => { fieldZp = { ...DEFAULT_ZOOM_PAN, fitToField: true }; redrawField(); });
    root.querySelector('#rh-field-zoomin')
        ?.addEventListener('click', () => { fieldZp.zoomX *= 1.25; fieldZp.zoomY *= 1.25; redrawField(); });
    root.querySelector('#rh-field-zoomout')
        ?.addEventListener('click', () => { fieldZp.zoomX /= 1.25; fieldZp.zoomY /= 1.25; redrawField(); });
    // Drag-drop on body for offline replay / import.
    window.addEventListener('dragover', (e) => { e.preventDefault(); });
    window.addEventListener('drop', (e) => {
        e.preventDefault();
        if (e.dataTransfer?.files)
            importFiles(e.dataTransfer.files, root);
    });
}
function sectionSwitch(root, which) {
    root.querySelectorAll('.rh-tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === which));
    root.querySelectorAll('section[data-section]').forEach((s) => {
        s.hidden = s.dataset.section !== which;
    });
    updateStateAndRender(root);
}
function getCtx(root) {
    let ctx = statePerKey.get(root);
    if (!ctx) {
        ctx = { runs: new Map(), importedFiles: new Map(), replayByRun: new Map() };
        statePerKey.set(root, ctx);
    }
    return ctx;
}
function updateStateAndRender(root) {
    renderSavedSection(root);
    renderCompareSection(root);
    renderReplaySection(root);
    renderChannelsSection(root);
    renderTrendSection(root);
    renderImportSummary(root);
    // The Live tab runs on its own bounded poller; calling here is safe
    // and idempotent — the poller checks isRunning() before scheduling.
    renderLiveSection(root);
}
/* =========================================================== Saved Runs */
function renderSavedSection(root) {
    const ctx = getCtx(root);
    const table = root.querySelector('#rh-saved-table');
    const status = root.querySelector('#rh-saved-status');
    if (ctx.runs.size === 0 && ctx.importedFiles.size === 0) {
        status.textContent = 'No runs loaded. Drag CSVs onto this page or connect to a Control Hub.';
        table.innerHTML = '';
        return;
    }
    const baselineId = getBaselineId();
    const rows = [];
    for (const r of ctx.runs.values()) {
        rows.push({ run: r, name: r.sourceFileName, imported: false, isBaseline: r.runId === baselineId });
    }
    for (const [runId, f] of ctx.importedFiles.entries()) {
        const r = ctx.runs.get(runId);
        if (!r)
            continue;
        rows.push({ run: r, name: f.name, imported: true, isBaseline: r.runId === baselineId });
    }
    status.textContent = `${rows.length} run(s). Click Open to enter the Replay panel.`;
    table.innerHTML = `
    <thead>
      <tr>
        <th>OpMode</th><th>Run ID</th><th>Started</th><th>Size</th>
        <th>Motors</th><th>Channels</th><th>Samples</th><th>Build</th>
        <th>Truncated</th><th>Baseline</th><th>Actions</th>
      </tr>
    </thead>
    <tbody></tbody>`;
    const tbody = table.querySelector('tbody');
    for (const row of rows) {
        const tr = document.createElement('tr');
        const motors = row.run.deviceNames.length;
        const channelCount = row.run.channels?.channelNames.length ?? 0;
        const samples = row.run.samples.length;
        tr.innerHTML = `
      <td>${escapeHtml(row.run.opmodeName)}</td>
      <td><code>${escapeHtml(row.run.runId.slice(0, 8))}</code></td>
      <td>${escapeHtml(row.run.runStartedAt)}</td>
      <td>${row.run.samples.length > 0 ? '~' + Math.round(samples * 0.1) + ' KB' : '—'}</td>
      <td>${motors}</td>
      <td>${channelCount}</td>
      <td>${samples}</td>
      <td>${escapeHtml(row.run.buildIdentifier || '—')}</td>
      <td>${row.run.truncated ? 'Yes' : 'No'}</td>
      <td>${row.isBaseline ? '✓' : ''}</td>
      <td>
        <button data-act="open" data-id="${escapeHtml(row.run.runId)}">Open</button>
        <button data-act="baseline" data-id="${escapeHtml(row.run.runId)}">Set Baseline</button>
        <button data-act="delete" data-id="${escapeHtml(row.run.runId)}">Delete</button>
        <button data-act="dl" data-id="${escapeHtml(row.run.runId)}">Download</button>
      </td>`;
        tbody.appendChild(tr);
    }
    table.querySelectorAll('button[data-act]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const id = btn.dataset.id;
            const act = btn.dataset.act;
            if (act === 'open') {
                sectionSwitch(root, 'replay');
                attachReplayRun(root, id);
            }
            else if (act === 'baseline') {
                setBaselineId(id);
                updateStateAndRender(root);
            }
            else if (act === 'delete') {
                if (confirm('Delete this run and its companion files?')) {
                    void apiDeleteRun(root, id);
                }
            }
            else if (act === 'dl') {
                void apiDownloadRun(id);
            }
        });
    });
    const duplicates = detectDuplicates(Array.from(ctx.runs.values()));
    if (duplicates.size > 0) {
        const list = Array.from(duplicates.entries()).map(([k, n]) => `${k.slice(0, 8)}×${n}`).join(', ');
        status.textContent += ` Duplicate run_ids detected: ${list}.`;
    }
}
function getBaselineId() {
    try {
        const raw = localStorage.getItem('runhealth.viewerState.v1');
        if (!raw)
            return '';
        const obj = JSON.parse(raw);
        return obj.baselineRunId ?? '';
    }
    catch (e) {
        return '';
    }
}
function setBaselineId(id) {
    try {
        const raw = localStorage.getItem('runhealth.viewerState.v1');
        const obj = raw ? JSON.parse(raw) : {};
        obj.baselineRunId = id;
        localStorage.setItem('runhealth.viewerState.v1', JSON.stringify(obj));
    }
    catch (e) { /* ignore */ }
}
/* =========================================================== Compare */
/**
 * Render per-motor expandable cards BELOW the summary strip and ABOVE the
 * 25-col detail table.  Each rh-compare-card is a <details> block carrying
 * the canonical semantic table for one motor.  The dense 25-col table
 * remains available inside an opt-in "Detailed metric table" <details>.
 */
function renderCompareCards(root) {
    const container = root.querySelector('#rh-compare-cards');
    if (!container)
        return;
    const ctx = getCtx(root);
    const sel = root.querySelector('#rh-mode');
    const baseSel = root.querySelector('#rh-baseline');
    const refSel = root.querySelector('#rh-reference');
    const cmpSel = root.querySelector('#rh-comparison');
    let ref = null, cmp = null;
    if (sel.value === 'DIRECT') {
        ref = refSel.value ? ctx.runs.get(refSel.value) ?? null : null;
        cmp = cmpSel.value ? ctx.runs.get(cmpSel.value) ?? null : null;
    }
    else {
        const baseId = baseSel.value || getBaselineId();
        ref = baseId ? ctx.runs.get(baseId) ?? null : null;
        const candidates = Array.from(ctx.runs.values())
            .filter((r) => r.runId !== baseId)
            .sort((a, b) => a.runStartedAt.localeCompare(b.runStartedAt));
        cmp = candidates[0] ?? null;
    }
    const dirSel = root.querySelector('#rh-direction');
    const bandSel = root.querySelector('#rh-band');
    const filter = {
        direction: dirSel?.value ?? 'BOTH',
        powerBand: bandSel?.value ?? 'ALL_ACTIVE',
    };
    if (!ref || !cmp) {
        container.innerHTML = '<p class="rh-empty">Choose a reference run and a comparison run to begin.</p>';
        return;
    }
    const summary = buildCompareSummary({
        ref, cmp, out: wholeRobotComparison({ reference: ref, comparison: cmp, filter }),
    });
    if (summary.cards.length === 0) {
        container.innerHTML = '<p class="rh-empty">No comparable motors in the selected runs.</p>';
        return;
    }
    container.innerHTML = summary.cards.map((card) => {
        const statusKlass = `rh-compare-card ${card.statusClass}`;
        const rowsHtml = card.expandedRows.map((r) => `
      <tr>
        <td>${escapeHtml(r.metric)}</td>
        <td>${escapeHtml(r.reference)}</td>
        <td>${escapeHtml(r.comparison)}</td>
        <td>${escapeHtml(r.rawDifference)}</td>
        <td>${escapeHtml(r.percentDifference)}</td>
      </tr>`).join('');
        return `<details class="${statusKlass}" data-compare-card="${escapeHtml(card.deviceName)}"><summary class="rh-compare-card__summary"><span class="rh-card--motor__name">${escapeHtml(card.deviceName)}</span><span class="rh-status ${card.statusClass}">${escapeHtml(card.statusLabel)}</span><span class="rh-compare-card__presence">${escapeHtml(card.presence)}</span><span class="rh-compare-card__samples">${escapeHtml(card.sampleConfidence)} samples</span></summary><div class="rh-compare-card__body"><table class="rh-table"><thead><tr><th>Metric</th><th>Reference</th><th>Comparison</th><th>Raw diff</th><th>Percent diff</th></tr></thead><tbody>${rowsHtml}</tbody></table></div></details>`;
    }).join('');
}
function renderCompareSection(root) {
    const ctx = getCtx(root);
    const sel = root.querySelector('#rh-mode');
    const baseRow = root.querySelector('#rh-baseline-row');
    const refRow = root.querySelector('#rh-reference-row');
    const cmpRow = root.querySelector('#rh-comparison-row');
    if (sel.value === 'DIRECT') {
        refRow.hidden = false;
        cmpRow.hidden = false;
        baseRow.hidden = true;
    }
    else {
        refRow.hidden = true;
        cmpRow.hidden = true;
        baseRow.hidden = false;
    }
    populateSelect(root.querySelector('#rh-baseline'), ctx.runs);
    populateSelect(root.querySelector('#rh-reference'), ctx.runs);
    populateSelect(root.querySelector('#rh-comparison'), ctx.runs);
    populateSelect(root.querySelector('#rh-graph-motor'), ctx.runs, /* devicesOnly */ true);
    renderCompareSummaryStrip(root);
    renderCompareCards(root);
    renderWholeTable(root);
    renderMotorGraphCanvas(root);
}
/**
 * Fill the rh-grid--summary strip above the comparison table with
 * aggregate counts (stable / changed / large-change / missing / insufficient)
 * plus battery and loop-time medians from the user-selected reference and
 * comparison runs.  Pure data comes from buildCompareSummary(); this
 * function only renders DOM into an existing rh-grid--summary container.
 *
 * The summary strip is the FIRST interpretation the user sees, before the
 * detailed 25-column comparison table.
 */
function renderCompareSummaryStrip(root) {
    const ctx = getCtx(root);
    const strip = root.querySelector('#rh-compare-summary');
    if (!strip)
        return;
    const sel = root.querySelector('#rh-mode');
    const baseSel = root.querySelector('#rh-baseline');
    const refSel = root.querySelector('#rh-reference');
    const cmpSel = root.querySelector('#rh-comparison');
    let ref = null, cmp = null;
    if (sel.value === 'DIRECT') {
        ref = refSel.value ? ctx.runs.get(refSel.value) ?? null : null;
        cmp = cmpSel.value ? ctx.runs.get(cmpSel.value) ?? null : null;
    }
    else {
        const baseId = baseSel.value || getBaselineId();
        ref = baseId ? ctx.runs.get(baseId) ?? null : null;
        const candidates = Array.from(ctx.runs.values())
            .filter((r) => r.runId !== baseId)
            .sort((a, b) => a.runStartedAt.localeCompare(b.runStartedAt));
        cmp = candidates[0] ?? null;
    }
    const dirSel = root.querySelector('#rh-direction');
    const bandSel = root.querySelector('#rh-band');
    const filter = {
        direction: dirSel?.value ?? 'BOTH',
        powerBand: bandSel?.value ?? 'ALL_ACTIVE',
    };
    const summary = buildCompareSummary({
        ref, cmp, out: ref && cmp ? wholeRobotComparison({ reference: ref, comparison: cmp, filter }) : null,
    });
    strip.innerHTML = '';
    for (const chip of summary.chips) {
        const cell = document.createElement('div');
        cell.className = 'rh-live-strip__chip rh-compare-summary__chip';
        const label = document.createElement('span');
        label.className = 'rh-metric__label';
        label.textContent = chip.label;
        cell.appendChild(label);
        const value = document.createElement('span');
        if (chip.statusClass)
            value.className = `rh-status ${chip.statusClass}`;
        else
            value.className = 'rh-metric__value';
        value.textContent = chip.value;
        cell.appendChild(value);
        if (chip.unit) {
            const u = document.createElement('span');
            u.className = 'rh-metric__unit';
            u.textContent = chip.unit;
            cell.appendChild(u);
        }
        strip.appendChild(cell);
    }
}
/**
 * Render per-motor expandable cards BELOW the summary strip and ABOVE the
 * 25-col detail table.  Each rh-compare-card is a <details> block carrying
 * the canonical semantic table for one motor.  The dense 25-col table
 * remains available inside an opt-in "Detailed metric table" <details>.
 */
// (orphan body of misplaced renderCompareCards removed by cleanup)
function renderWholeTable(root) {
    const ctx = getCtx(root);
    const table = root.querySelector('#rh-whole');
    const sel = root.querySelector('#rh-mode');
    const baseSel = root.querySelector('#rh-baseline');
    const refSel = root.querySelector('#rh-reference');
    const cmpSel = root.querySelector('#rh-comparison');
    const dirSel = root.querySelector('#rh-direction');
    const bandSel = root.querySelector('#rh-band');
    let reference = null;
    let comparison = null;
    if (sel.value === 'DIRECT') {
        reference = ctx.runs.get(refSel.value) ?? null;
        comparison = ctx.runs.get(cmpSel.value) ?? null;
    }
    else {
        const baseId = baseSel.value || getBaselineId();
        const baseline = baseId ? (ctx.runs.get(baseId) ?? null) : null;
        const candidates = Array.from(ctx.runs.values())
            .filter((r) => r.runId !== baseId)
            .sort((a, b) => a.runStartedAt.localeCompare(b.runStartedAt));
        reference = baseline;
        comparison = candidates[0] ?? null;
    }
    if (!reference || !comparison) {
        table.innerHTML = '<thead><tr><th>Information</th></tr></thead>'
            + '<tbody><tr><td>Select a baseline and at least one other run.</td></tr></tbody>';
        return;
    }
    const filter = {
        direction: dirSel?.value ?? 'BOTH',
        powerBand: bandSel?.value ?? 'ALL_ACTIVE',
    };
    const out = wholeRobotComparison({ reference, comparison, filter });
    table.innerHTML = '';
    const thead = table.createTHead();
    const trh = thead.insertRow();
    for (const h of COMPARISON_HEADERS) {
        const th = document.createElement('th');
        th.textContent = h;
        trh.appendChild(th);
    }
    const tbody = table.createTBody();
    for (const row of out.rows) {
        const tr = tbody.insertRow();
        appendCell(tr, row.deviceName);
        appendCell(tr, `${getStatusLabel(row.status)} · ${row.presenceStatus}`, getStatusClass(row.status));
        appendCell(tr, formatTps(row.refMedianVelocity));
        appendCell(tr, formatTps(row.cmpMedianVelocity));
        appendCell(tr, formatSignedDiff(row.absDiffMedianVelocity));
        appendCell(tr, formatFractionPctSigned(row.medianVelocityChangePct));
        appendCell(tr, formatFractionPct(row.refVelocityEfficiency));
        appendCell(tr, formatFractionPct(row.cmpVelocityEfficiency));
        appendCell(tr, formatSignedDiff(row.absDiffVelocityEfficiency));
        appendCell(tr, formatFractionPctSigned(row.velocityEfficiencyChangePct));
        appendCell(tr, formatPower(row.refCurrentCost));
        appendCell(tr, formatPower(row.cmpCurrentCost));
        appendCell(tr, formatSignedDiff(row.absDiffCurrentCost));
        appendCell(tr, formatFractionPctSigned(row.currentCostChangePct));
        appendCell(tr, formatAmps(row.refP95Current));
        appendCell(tr, formatAmps(row.cmpP95Current));
        appendCell(tr, formatSignedDiff(row.absDiffP95Current));
        appendCell(tr, formatFractionPctSigned(row.p95CurrentChangePct));
        appendCell(tr, formatFractionPct(row.refStallPct));
        appendCell(tr, formatFractionPct(row.cmpStallPct));
        appendCell(tr, formatSignedDiff(row.absDiffStallPct));
        appendCell(tr, formatFractionPctSigned(row.possibleStallChangePct));
        appendCell(tr, `${row.comparableSampleCountA} / ${row.comparableSampleCountB}`);
        appendCell(tr, signalsShort(row));
        appendCell(tr, row.motorModeMismatch ? '❗' : '');
    }
    const baselineId = getBaselineId();
    const tfoot = table.createTFoot();
    const fr1 = tfoot.insertRow();
    appendCell(fr1, 'Reference', 'rh-bold');
    appendCell(fr1, runInfoLabel(reference, baselineId === reference.runId), 'rh-info');
    const fr2 = tfoot.insertRow();
    appendCell(fr2, 'Comparison', 'rh-bold');
    appendCell(fr2, runInfoLabel(comparison, baselineId === comparison.runId), 'rh-info');
}
const COMPARISON_HEADERS = [
    'Motor', 'Status / Presence',
    'Vel Ref', 'Vel Cmp', 'Δ vel (raw)', 'Δ vel %',
    'Eff Ref', 'Eff Cmp', 'Δ eff (raw)', 'Δ eff %',
    'Cost Ref', 'Cost Cmp', 'Δ cost', 'Δ cost %',
    'p95 Ref', 'p95 Cmp', 'Δ p95', 'Δ p95 %',
    'Stall % Ref', 'Stall % Cmp', 'Δ stall %', 'Δ stall %',
    'Samples R/C', 'Current / Voltage', 'Mode Warn',
];
function signalsShort(r) {
    const ar = r.hasCurrentRef ? '\u2713' : '\u2014';
    const ac = r.hasCurrentCmp ? '\u2713' : '\u2014';
    const vr = r.hasVoltageRef ? '\u2713' : '\u2014';
    const vc = r.hasVoltageCmp ? '\u2713' : '\u2014';
    return `I:${ar}/${ac} V:${vr}/${vc}`;
}
/* =========================================================== Graph canvas (Compare tab) */
function renderMotorGraphCanvas(root) {
    const ctx = getCtx(root);
    const canvas = root.querySelector('#rh-graph-canvas');
    if (!canvas)
        return;
    const motorSel = root.querySelector('#rh-graph-motor');
    if (!motorSel)
        return;
    const motor = motorSel.value;
    const refSel = root.querySelector('#rh-baseline');
    const cmpSel = root.querySelector('#rh-comparison');
    const ref = refSel?.value ? ctx.runs.get(refSel.value) : null;
    const cmp = cmpSel?.value ? ctx.runs.get(cmpSel.value) : null;
    if (!motor || !ref)
        return;
    sizeCanvas(canvas);
    const ctx2d = canvas.getContext('2d');
    if (!ctx2d)
        return;
    ctx2d.save();
    ctx2d.clearRect(0, 0, canvas.width, canvas.height);
    // Reference series for one motor.
    const refSamp = ref.samples.filter((s) => s.deviceName === motor);
    const cmpSamp = cmp?.samples.filter((s) => s.deviceName === motor) ?? [];
    const series = motorMetricSeries(motor, refSamp, 0);
    if (cmpSamp.length > 0) {
        series.push(...motorMetricSeries(motor, cmpSamp, 1));
    }
    series.forEach((s) => { s.label = `${motor} – ${s.id.split('.').pop()}–${defaultColor(0)}`; });
    const points = refSamp.length + (cmp?.samples.length ?? 0);
    const targetPx = Math.max(80, points === 0 ? 80 : Math.round(800 * 3 / Math.max(2, points)));
    for (const s of series) {
        if (s.points.length > 1500)
            s.points = downsample(s.points, Math.max(80, targetPx));
    }
    const dom = seriesDomain(series);
    if (!dom) {
        ctx2d.fillText('No data for selected motor', 8, 18);
        ctx2d.restore();
        return;
    }
    drawSeries(ctx2d, series, dom, canvas.width - 20, canvas.height - 20, null);
    ctx2d.restore();
}
/* =========================================================== Replay */
function attachReplayRun(root, runId) {
    if (!runId)
        return;
    const ctx = getCtx(root);
    const run = ctx.runs.get(runId);
    if (!run)
        return;
    // Build (or rebuild) the slice.
    const byChannelSamples = new Map();
    if (run.channels) {
        for (const [name, list] of Object.entries(run.channels.byChannel)) {
            byChannelSamples.set(name, list.slice());
        }
    }
    const endMs = runDurationMs(run.samples, run.durationMs ?? null);
    ctx.replayByRun.set(runId, { run, byChannelSamples, endMs });
    globalReplayClock.loadRun(0, endMs);
    renderReplaySection(root);
}
function renderReplaySection(root) {
    const ctx = getCtx(root);
    const sel = root.querySelector('#rh-replay-run');
    if (!sel)
        return;
    sel.innerHTML = '';
    for (const r of ctx.runs.values()) {
        const opt = document.createElement('option');
        opt.value = r.runId;
        opt.textContent = `${r.runStartedAt} – ${r.opmodeName}`;
        sel.appendChild(opt);
    }
    const scrub = root.querySelector('#rh-replay-scrubber');
    const time = root.querySelector('#rh-replay-time');
    const totals = `${globalReplayClock.getDuration() | 0}`;
    const cur = globalReplayClock.getTime();
    if (time)
        time.textContent = `${cur | 0} / ${totals} ms`;
    if (scrub && globalReplayClock.getDuration() > 0) {
        scrub.value = String(Math.min(1000, Math.round((cur / globalReplayClock.getDuration()) * 1000)));
    }
    // Subscribe the replay panel + canvas to clock ticks (idempotent).
    const update = (t) => {
        if (time)
            time.textContent = `${t | 0} / ${totals} ms`;
        if (scrub && globalReplayClock.getDuration() > 0) {
            scrub.value = String(Math.min(1000, Math.round((t / globalReplayClock.getDuration()) * 1000)));
        }
        renderReplayCanvas(root, t);
        renderReplayValues(root, t);
    };
    globalReplayClock.registerConsumer(update);
    // Initial fill.
    update(globalReplayClock.getTime());
}
function renderReplayCanvas(root, t) {
    const ctx = getCtx(root);
    const canvas = root.querySelector('#rh-replay-canvas');
    if (!canvas)
        return;
    // Determine which run is being replayed.
    const sel = root.querySelector('#rh-replay-run');
    const runId = sel?.value ?? '';
    const slice = ctx.replayByRun.get(runId);
    if (!slice)
        return;
    sizeCanvas(canvas);
    const ctx2d = canvas.getContext('2d');
    if (!ctx2d)
        return;
    ctx2d.save();
    ctx2d.clearRect(0, 0, canvas.width, canvas.height);
    // Show 5 motor channels per device, time-sliced to [t-windowMs, t].
    const windowMs = Math.min(slice.endMs, Math.max(500, t + 1));
    const startMs = Math.max(0, windowMs - 2000);
    const series = [];
    for (const device of slice.run.deviceNames) {
        const samps = slice.run.samples.filter((x) => x.deviceName === device && x.timestampMs >= startMs && x.timestampMs <= t);
        const m = motorMetricSeries(device, samps, 0);
        for (const s of m)
            series.push(s);
    }
    const dom = seriesDomain(series);
    if (!dom) {
        ctx2d.fillText('No recent samples at this replay time', 8, 18);
        ctx2d.restore();
        return;
    }
    drawSeries(ctx2d, series, dom, canvas.width - 20, canvas.height - 20, t);
    ctx2d.restore();
}
function renderReplayValues(root, t) {
    const ctx = getCtx(root);
    const table = root.querySelector('#rh-replay-values');
    if (!table)
        return;
    const sel = root.querySelector('#rh-replay-run');
    const runId = sel?.value ?? '';
    const slice = ctx.replayByRun.get(runId);
    if (!slice) {
        table.innerHTML = `<thead><tr><th>Information</th></tr></thead>
      <tbody><tr><td>Attach a run from Saved Runs first.</td></tr></tbody>`;
        return;
    }
    const rows = [];
    for (const [name, list] of slice.byChannelSamples.entries()) {
        if (list.length === 0)
            continue;
        const k = list[0].kind;
        let valueStr = '—';
        if (k === 'number') {
            const v = lookupNumeric(list, t);
            valueStr = v === null ? '—' : v.toFixed(3);
        }
        else if (k === 'boolean') {
            const v = lookupBoolean(list, t);
            valueStr = v === null ? '—' : (v ? 'true' : 'false');
        }
        else if (k === 'text') {
            const v = lookupText(list, t);
            valueStr = v === null ? '—' : escapeHtml(v);
        }
        else if (k === 'pose') {
            const p = lookupPose(list, t);
            valueStr = p === null
                ? '—'
                : `x=${p.x.toFixed(1)}in y=${p.y.toFixed(1)}in h=${(p.heading ?? 0).toFixed(2)}rad`;
        }
        else if (k === 'event') {
            valueStr = list.length === 0 ? '—' : `${list.length} events`;
        }
        rows.push({ name, kind: k, value: valueStr });
    }
    table.innerHTML = `<thead><tr><th>Channel</th><th>Kind</th>
    <th>Value at t = ${t | 0} ms</th></tr></thead><tbody></tbody>`;
    const tbody = table.querySelector('tbody');
    for (const row of rows) {
        const tr = tbody.insertRow();
        appendCell(tr, row.name);
        appendCell(tr, row.kind);
        appendCell(tr, row.value);
    }
}
/* =========================================================== Channels */
function renderChannelsSection(root) {
    const ctx = getCtx(root);
    const sel = root.querySelector('#rh-channels-run');
    if (!sel)
        return;
    sel.innerHTML = '';
    for (const r of ctx.runs.values()) {
        const opt = document.createElement('option');
        opt.value = r.runId;
        opt.textContent = `${r.runStartedAt} – ${r.opmodeName}`;
        sel.appendChild(opt);
    }
    const cards = root.querySelector('#rh-channel-cards');
    if (!cards)
        return;
    cards.innerHTML = '';
    const run = ctx.runs.get(sel.value);
    if (!run?.channels) {
        cards.innerHTML =
            '<div class="rh-empty" role="status">' +
                '<p class="rh-empty__title">This recording contains motor data only.</p>' +
                '<p class="rh-empty__hint">No custom telemetry was recorded for this run.</p>' +
                '<p class="rh-empty__detail">Older motor-only recordings remain fully supported.</p>' +
                '</div>';
        return;
    }
    for (const channelName of run.channels.channelNames) {
        const chs = run.channels.byChannel[channelName];
        if (!chs)
            continue;
        const meta = run.manifest?.channels.find((m) => m.name === channelName);
        const div = document.createElement('div');
        div.className = 'rh-card rh-channel-card';
        const h = document.createElement('h4');
        h.textContent = `${channelName} - ${chs[0]?.kind ?? '?'}`;
        div.appendChild(h);
        if (chs[0]?.kind === 'number') {
            const v = chs.map((x) => x.valueNumber).filter((x) => x !== null);
            const med = v.length ? median(v) : null;
            const min = v.length ? Math.min(...v) : null;
            const max = v.length ? Math.max(...v) : null;
            const last = lastNumeric(chs);
            const tbl = makeTable([
                ['Unit', String(meta?.unit ?? '-')],
                ['Group', String(meta?.group ?? '-')],
                ['Description', String(meta?.description ?? '-')],
                ['Samples', String(chs.length)],
                ['Min', min === null ? '-' : min.toFixed(3)],
                ['Median', med === null ? '-' : med.toFixed(3)],
                ['Max', max === null ? '-' : max.toFixed(3)],
                ['Final', last === null ? '-' : last.toFixed(3)],
            ]);
            div.appendChild(tbl);
        }
        else if (chs[0]?.kind === 'boolean') {
            let trans = 0, timeTrue = 0;
            let prev = null;
            let prevT = NaN;
            for (const x of chs) {
                if (x.valueBoolean === null)
                    continue;
                if (prev !== null && x.valueBoolean !== prev)
                    trans++;
                if (x.valueBoolean === true)
                    timeTrue += Math.max(0, x.timestampMs - prevT);
                prev = x.valueBoolean;
                prevT = x.timestampMs;
            }
            const first = chs.find((x) => x.valueBoolean !== null)?.valueBoolean ?? null;
            const lastB = lastBoolean(chs);
            const tbl = makeTable([
                ['Transitions', String(trans)],
                ['Time true', (timeTrue / 1000).toFixed(1) + ' s'],
                ['First', first === null ? '-' : (first ? 'true' : 'false')],
                ['Final', lastB === null ? '-' : (lastB ? 'true' : 'false')],
            ]);
            div.appendChild(tbl);
        }
        else if (chs[0]?.kind === 'text') {
            const first = chs.find((x) => x.valueText !== null)?.valueText ?? null;
            const lastT = lastText(chs);
            const transList = [];
            let prevText = null;
            for (const x of chs) {
                if (x.valueText === null)
                    continue;
                if (prevText !== null && x.valueText !== prevText) {
                    transList.push({ at: x.timestampMs, value: x.valueText });
                }
                prevText = x.valueText;
            }
            const tbl = makeTable([
                ['First', first ?? '-'],
                ['Final', lastT ?? '-'],
                ['Transitions', String(transList.length)],
            ]);
            div.appendChild(tbl);
            const ul = document.createElement('ul');
            ul.className = 'rh-transition-list';
            for (const t of transList.slice(-12)) {
                const li = document.createElement('li');
                li.textContent = ((t.at | 0) + 'ms - ' + t.value);
                ul.appendChild(li);
            }
            div.appendChild(ul);
        }
        else if (chs[0]?.kind === 'pose') {
            const last = lastPose(chs);
            const ranges = poseSeriesToPath(chs);
            const tbl = makeTable([
                ['Samples', String(chs.length)],
                ['Path points', String(ranges.length)],
                ['X last', last === null ? '-' : last.x.toFixed(2)],
                ['Y last', last === null ? '-' : last.y.toFixed(2)],
            ]);
            div.appendChild(tbl);
        }
        else {
            const p = document.createElement('p');
            p.textContent = chs.length + ' event markers (visible in Replay timeline).';
            div.appendChild(p);
        }
        cards.appendChild(div);
    }
}
/* Tiny DOM-table helpers - safer than huge template-literal nesting
 * and never produce HTML-injection because every cell goes through
 * textContent. */
function makeTable(rows) {
    const t = document.createElement('table');
    t.className = 'rh-table';
    for (const [k, v] of rows) {
        const tr = document.createElement('tr');
        const td1 = document.createElement('td');
        td1.textContent = k;
        const td2 = document.createElement('td');
        td2.textContent = v;
        tr.appendChild(td1);
        tr.appendChild(td2);
        t.appendChild(tr);
    }
    return t;
}
function lastNumeric(chs) {
    for (let i = chs.length - 1; i >= 0; i--) {
        const s = chs[i];
        if (s && s.valueNumber !== null && s.valueNumber !== undefined)
            return s.valueNumber;
    }
    return null;
}
function lastBoolean(chs) {
    for (let i = chs.length - 1; i >= 0; i--) {
        const s = chs[i];
        if (s && s.valueBoolean !== null && s.valueBoolean !== undefined)
            return s.valueBoolean;
    }
    return null;
}
function lastText(chs) {
    for (let i = chs.length - 1; i >= 0; i--) {
        const s = chs[i];
        if (s && s.valueText !== null && s.valueText !== undefined)
            return s.valueText;
    }
    return null;
}
function lastPose(chs) {
    for (let i = chs.length - 1; i >= 0; i--) {
        const s = chs[i];
        if (s && s.valueX !== null && s.valueX !== undefined
            && s.valueY !== null && s.valueY !== undefined) {
            return { x: s.valueX, y: s.valueY };
        }
    }
    return null;
}
function median(v) {
    if (v.length === 0)
        return NaN;
    const s = [...v].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
/* =========================================================== Field */
function renderFieldView(root, zp) {
    const ctx = getCtx(root);
    const canvas = root.querySelector('#rh-field-canvas');
    if (!canvas)
        return;
    sizeCanvas(canvas);
    const c = canvas.getContext('2d');
    if (!c)
        return;
    // Build a travelled path from the first run with a pose channel.
    let path = [];
    let robot = null;
    // If a replay is attached, use the replay clock + pose channel.
    const replaySel = root.querySelector('#rh-replay-run');
    const runId = replaySel?.value;
    const slice = runId ? ctx.replayByRun.get(runId) : null;
    if (slice) {
        const t = globalReplayClock.getTime();
        const poseCh = slice.byChannelSamples.get('robot.pose');
        if (poseCh?.length) {
            path = poseSeriesToPath(poseCh, 500).filter(Boolean).map((p) => ({ x: p.x, y: p.y, tMs: p.tMs }));
            // Trailing only up to replay time.
            path = path.filter((p) => (p.tMs ?? 0) <= t);
            const p = lookupPose(poseCh, t);
            if (p)
                robot = { x: p.x, y: p.y, headingRad: p.heading ?? 0 };
        }
    }
    else {
        // Otherwise fall back to the first run that has a pose channel.
        for (const r of ctx.runs.values()) {
            const pose = r.channels?.byChannel['robot.pose'];
            if (pose && pose.length > 0) {
                path = poseSeriesToPath(pose, 500).filter(Boolean).map((p) => ({ x: p.x, y: p.y, tMs: p.tMs }));
                const last = pose[pose.length - 1];
                robot = { x: last.valueX ?? 0, y: last.valueY ?? 0, headingRad: last.valueHeading ?? 0 };
                break;
            }
        }
    }
    drawField(c, canvas.width, canvas.height, { zp, path, robot });
}
/* =========================================================== Trend */
function renderTrendSection(root) {
    const ctx = getCtx(root);
    const motorSel = root.querySelector('#rh-trend-motor');
    const seriesSel = root.querySelector('#rh-trend-series');
    const table = root.querySelector('#rh-trend');
    if (!motorSel || !seriesSel || !table)
        return;
    motorSel.innerHTML = '';
    const allDevices = new Set();
    for (const r of ctx.runs.values())
        for (const d of r.deviceNames)
            allDevices.add(d);
    for (const d of Array.from(allDevices).sort()) {
        const opt = document.createElement('option');
        opt.value = d;
        opt.textContent = d;
        motorSel.appendChild(opt);
    }
    // Build a Custom channels optgroup if any run defines numeric channels.
    // The optgroup is appended AFTER the canonical core-metric options.
    seriesSel.innerHTML = '';
    const CORE_OPTIONS = [
        ['medianVelocity', 'Median velocity'],
        ['velocityEfficiency', 'Velocity efficiency'],
        ['currentCost', 'Current cost'],
        ['p95Current', 'P95 current'],
        ['possibleStallPct', 'Stall %'],
        ['batteryMin', 'Battery min'],
        ['batteryMedian', 'Battery median'],
        ['loopTimeMsMedian', 'Loop-time median (ms)'],
        ['loopTimeMsP95', 'Loop-time p95 (ms)'],
    ];
    for (const [val, lbl] of CORE_OPTIONS) {
        const opt = document.createElement('option');
        opt.value = val;
        opt.textContent = lbl;
        seriesSel.appendChild(opt);
    }
    // Add custom numeric channels gathered across all runs (deduplicated).
    const customNames = new Map();
    for (const r of ctx.runs.values()) {
        const names = r.channels?.channelNames ?? [];
        for (const n of names) {
            if (!customNames.has(n))
                customNames.set(n, { unit: undefined, kind: 'number' });
        }
    }
    if (customNames.size > 0) {
        const grp = document.createElement('optgroup');
        grp.label = 'Custom channels';
        // Choose motor='(none)' for channel-level trends; customChannelTrend
        // in trends.ts accepts a channelName arg via the value prefix.
        for (const n of Array.from(customNames.keys()).sort()) {
            const opt = document.createElement('option');
            opt.value = `custom:${n}`;
            opt.textContent = n;
            grp.appendChild(opt);
        }
        seriesSel.appendChild(grp);
        // Switch motor picker labelling hint when a custom option is selected.
        const onSeriesChange = () => {
            const v = seriesSel.value;
            if (v.startsWith('custom:')) {
                motorSel.disabled = true;
            }
            else {
                motorSel.disabled = false;
            }
        };
        seriesSel.onchange = onSeriesChange;
        onSeriesChange();
    }
    const baselineId = getBaselineId();
    const motor = motorSel.value;
    const seriesKey = seriesSel.value;
    const runs = Array.from(ctx.runs.values());
    const filter = { direction: 'BOTH', powerBand: 'ALL_ACTIVE' };
    const trend = buildTrendSeries(seriesKey, runs, motor, filter);
    const deltaed = applyDeltas(trend, { baselineRunId: baselineId || null });
    table.innerHTML = `<thead><tr>
    <th>Date</th><th>Build</th><th>Value</th>
    <th>Δ baseline</th><th>Δ previous</th><th>Status</th>
  </tr></thead><tbody></tbody>`;
    const tbody = table.querySelector('tbody');
    for (const p of deltaed) {
        const tr = tbody.insertRow();
        appendCell(tr, p.runStartedAt);
        appendCell(tr, p.buildIdentifier || '\u2014');
        appendCell(tr, p.value === null ? '\u2014' : p.value.toFixed(3));
        appendCell(tr, p.baselineDelta === null ? '\u2014' : (p.baselineDelta >= 0 ? '+' : '') + p.baselineDelta.toFixed(3));
        appendCell(tr, p.previousDelta === null ? '\u2014' : (p.previousDelta >= 0 ? '+' : '') + p.previousDelta.toFixed(3));
        appendCell(tr, p.insufficient || p.value === null ? 'gap' : 'ok');
    }
    // Draw the trend chart.
    const canvas = root.querySelector('#rh-trend-canvas');
    if (canvas && deltaed.length > 0) {
        sizeCanvas(canvas);
        const c = canvas.getContext('2d');
        if (c) {
            c.save();
            c.clearRect(0, 0, canvas.width, canvas.height);
            const series = [{ id: seriesKey, label: seriesKey, color: '#2a6df4', visible: true,
                    points: deltaed.map((p, i) => ({
                        t: Date.parse(p.runStartedAt) || i,
                        v: p.value ?? NaN,
                        gap: p.value === null,
                    })),
                }];
            const dom = seriesDomain(series);
            if (dom)
                drawSeries(c, series, dom, canvas.width - 20, canvas.height - 20, null);
            c.restore();
        }
    }
}
function buildTrendSeries(key, runs, motor, filter) {
    const runById = new Map(runs.map((r) => [r.runId, r]));
    const trendRows = perMotorTrend(runs, motor, filter);
    const mapTrend = (pick) => trendRows.map((row) => {
        const run = runById.get(row.runId);
        return {
            runId: row.runId,
            runStartedAt: row.runStartedAt,
            opmodeName: run?.opmodeName ?? '',
            buildIdentifier: run?.buildIdentifier ?? '',
            value: pick(row),
            baselineDelta: null,
            previousDelta: null,
            insufficient: row.comparableSamples === 0,
        };
    });
    if (key.startsWith('custom:')) {
        const name = key.slice('custom:'.length);
        return customChannelTrend(runs, name).map((cp) => ({
            runId: cp.runId,
            runStartedAt: cp.runStartedAt,
            opmodeName: cp.opmodeName,
            buildIdentifier: cp.buildIdentifier,
            value: typeof cp.value === 'number' ? cp.value : null,
            baselineDelta: null,
            previousDelta: null,
            insufficient: cp.insufficient,
        }));
    }
    switch (key) {
        case 'medianVelocity':
            return mapTrend((r) => r.medianVelocity);
        case 'velocityEfficiency':
            return mapTrend((r) => r.velocityEfficiency);
        case 'currentCost':
            return mapTrend((r) => r.currentCost);
        case 'p95Current':
            return mapTrend((r) => r.p95Current);
        case 'possibleStallPct':
            return mapTrend((r) => r.possibleStallPct);
        case 'batteryMin':
            return batteryMinPoints(runs);
        case 'batteryMedian':
            return batteryMedianPoints(runs);
        case 'loopTimeMsMedian':
            return loopTimeMedianPoints(runs);
        case 'loopTimeMsP95':
            return loopTimeP95Points(runs);
        default:
            return [];
    }
}
function batteryMinPoints(runs) {
    return runs.map((r) => {
        let mn = null;
        for (const s of r.samples) {
            if (s.batteryVoltage === null)
                continue;
            if (Number.isFinite(s.batteryVoltage) && s.batteryVoltage > 0 && (mn === null || s.batteryVoltage < mn)) {
                mn = s.batteryVoltage;
            }
        }
        return { runId: r.runId, runStartedAt: r.runStartedAt, opmodeName: r.opmodeName,
            buildIdentifier: r.buildIdentifier ?? '', value: mn,
            baselineDelta: null, previousDelta: null, insufficient: mn === null };
    }).sort((a, b) => a.runStartedAt.localeCompare(b.runStartedAt));
}
function batteryMedianPoints(runs) {
    return runs.map((r) => {
        const v = [];
        for (const s of r.samples) {
            if (s.batteryVoltage === null)
                continue;
            if (Number.isFinite(s.batteryVoltage) && s.batteryVoltage > 0)
                v.push(s.batteryVoltage);
        }
        if (v.length < 5)
            return { runId: r.runId, runStartedAt: r.runStartedAt,
                opmodeName: r.opmodeName, buildIdentifier: r.buildIdentifier ?? '',
                value: null, baselineDelta: null, previousDelta: null, insufficient: true };
        return { runId: r.runId, runStartedAt: r.runStartedAt, opmodeName: r.opmodeName,
            buildIdentifier: r.buildIdentifier ?? '', value: median(v),
            baselineDelta: null, previousDelta: null, insufficient: false };
    }).sort((a, b) => a.runStartedAt.localeCompare(b.runStartedAt));
}
function loopTimeHelper(runs, p) {
    return runs.map((r) => {
        const dt = [];
        for (let i = 1; i < r.samples.length; i++) {
            const a = r.samples[i - 1].timestampMs, b = r.samples[i].timestampMs;
            const g = b - a;
            if (g > 0 && g <= 1000)
                dt.push(g);
        }
        if (dt.length < 5)
            return { runId: r.runId, runStartedAt: r.runStartedAt,
                opmodeName: r.opmodeName, buildIdentifier: r.buildIdentifier ?? '',
                value: null, baselineDelta: null, previousDelta: null, insufficient: true };
        const sorted = [...dt].sort((a, b) => a - b);
        const idx = Math.floor((sorted.length - 1) * p);
        const lo = Math.floor(idx), hi = Math.ceil(idx);
        const v = lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
        return { runId: r.runId, runStartedAt: r.runStartedAt, opmodeName: r.opmodeName,
            buildIdentifier: r.buildIdentifier ?? '', value: v,
            baselineDelta: null, previousDelta: null, insufficient: false };
    }).sort((a, b) => a.runStartedAt.localeCompare(b.runStartedAt));
}
function loopTimeMedianPoints(runs) { return loopTimeHelper(runs, 0.5); }
function loopTimeP95Points(runs) { return loopTimeHelper(runs, 0.95); }
/* =========================================================== Stage 10: Downloads */
async function apiDownloadRun(runId) {
    try {
        const url = `/api/runs/${encodeURIComponent(runId)}/download`;
        const blob = await fetchAsBlob(url);
        triggerDownload(blob, `${runId}.csv`);
    }
    catch (e) {
        alert(`Failed to download ${runId}: ${e.message}`);
    }
}
async function apiDeleteRun(root, runId) {
    try {
        const resp = await fetch(`/api/runs/${encodeURIComponent(runId)}/delete`, { method: 'POST', credentials: 'include' });
        if (!resp.ok)
            throw new Error(`HTTP ${resp.status}`);
        const ctx = getCtx(root);
        ctx.runs.delete(runId);
        ctx.importedFiles.delete(runId);
        ctx.replayByRun.delete(runId);
        if (getBaselineId() === runId)
            setBaselineId('');
        updateStateAndRender(root);
    }
    catch (e) {
        alert(`Delete failed: ${e.message}`);
    }
}
async function fetchAsBlob(url) {
    const r = await fetch(url, { credentials: 'include' });
    if (!r.ok)
        throw new Error(`HTTP ${r.status} for ${url}`);
    return await r.blob();
}
/* Stage 10 sequential-per-file download is wired via Saved Runs UI:
 * apiDownloadRun(runId) downloads one run's CSV blob.  Bulk
 * multi-select download is intentionally NOT exposed in this build
 * because the saved-runs tab has no per-row checkbox; the per-run
 * Download button is the visible UI action.  End-of-Stage-10 marker. */
function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    // Revoke slightly later so the browser has time to start the download.
    setTimeout(() => {
        URL.revokeObjectURL(url);
        if (a.parentNode)
            a.parentNode.removeChild(a);
    }, 1000);
}
/* =========================================================== Import / Online */
async function importFiles(files, root) {
    if (!files)
        return;
    const ctx = getCtx(root);
    for (let i = 0; i < files.length; i++) {
        const f = files.item(i);
        if (!f)
            continue;
        const text = await f.text();
        // Try unified parser first; fall back to legacy v1 motor CSV.
        let parsed;
        if (f.name.endsWith('.csv') && !f.name.includes('.channels.csv') && !f.name.includes('.manifest.json')) {
            parsed = parseRunHealthCsv(text, f.name);
        }
        else {
            parsed = { kind: 'error', reason: 'unsupported', detail: f.name };
        }
        if (parsed.kind === 'ok') {
            ctx.runs.set(parsed.run.runId, parsed.run);
            ctx.importedFiles.set(parsed.run.runId, { name: f.name, size: f.size, at: Date.now() });
        }
        else {
            // Surface a parse failure on the import list.
            appendImportList(root, f, false, parsed.reason);
        }
    }
    updateStateAndRender(root);
    renderImportSummary(root);
}
function appendImportList(root, f, ok, err) {
    const list = root.querySelector('#rh-import-list');
    if (!list)
        return;
    const li = document.createElement('li');
    li.textContent = `${f.name} (${(f.size / 1024).toFixed(1)} KB) — ${ok ? 'imported' : `rejected (${err})`}`;
    list.appendChild(li);
}
/**
 * Update the Import section's recognized-run / warning counters and enable
 * the "Open latest imported run" button when at least one import succeeded.
 * Called after every importFiles() and during the initial render pass.
 */
function renderImportSummary(root) {
    const ctx = getCtx(root);
    const rejected = [];
    const list = root.querySelector('#rh-import-list');
    if (list) {
        for (const li of Array.from(list.children)) {
            const text = li.textContent ?? '';
            const m = /rejected \(/.exec(text);
            if (m) {
                const reasonClose = text.indexOf(')', m.index);
                const sizeMatch = /\(([0-9.]+) KB\)/.exec(text);
                rejected.push({
                    filename: text.split(' ')[0],
                    ok: false,
                    sizeKb: sizeMatch ? Number(sizeMatch[1]) : 0,
                    reason: reasonClose > m.index ? text.slice(m.index + 'rejected ('.length, reasonClose) : 'unknown',
                });
            }
        }
    }
    const summary = buildImportSummary({
        importedRunIds: Array.from(ctx.importedFiles.keys()),
        rejected,
    });
    const recognized = root.querySelector('#rh-import-recognized');
    const runs = root.querySelector('#rh-import-runs');
    const warnings = root.querySelector('#rh-import-warnings');
    if (recognized)
        recognized.textContent = String(summary.recognizedFiles);
    if (runs)
        runs.textContent = String(summary.runCount);
    if (warnings)
        warnings.textContent = String(summary.warningCount);
    const openBtn = root.querySelector('#rh-import-open');
    if (openBtn) {
        openBtn.disabled = summary.openRunId == null;
        openBtn.textContent = summary.openRunId
            ? `Open latest imported run (${summary.openRunId.slice(0, 8)})`
            : 'Open latest imported run';
    }
}
async function discoverControlHubApi() {
    if (typeof fetch === 'undefined')
        return false;
    try {
        const r = await fetch('api/recording', { credentials: 'include' });
        return r.ok;
    }
    catch (e) {
        return false;
    }
}
async function refreshConnectedRuns(root) {
    const status = root.querySelector('#rh-saved-status');
    try {
        const resp = await fetch('api/runs', { credentials: 'include' });
        if (!resp.ok)
            throw new Error('HTTP ' + resp.status);
        const data = await resp.json();
        const ctx = getCtx(root);
        ctx.runs = new Map();
        for (const r of data.runs ?? []) {
            const csvResp = await fetch('api/runs/' + r.run_id, { credentials: 'include' });
            if (!csvResp.ok)
                continue;
            const csvText = await csvResp.text();
            const parsed = parseRunHealthCsv(csvText, r.filename ?? r.run_id + '.csv');
            if (parsed.kind === 'ok') {
                ctx.runs.set(parsed.run.runId, parsed.run);
            }
        }
        status.textContent = `Connected: ${data.count ?? 0} runs found on the hub.`;
        updateStateAndRender(root);
    }
    catch (e) {
        status.textContent = `Control Hub API unavailable. Showing standalone (drag-and-drop) mode. Reason: ${e.message}`;
    }
}
/* =========================================================== helpers */
// Status classes are centralised in ./status.ts (getStatusClass, imported at
// top of file).  Numeric formatters live in ./format.ts and metric help text
// in ./metricHelp.ts; both are imported on demand by individual render
// functions when their consumer needs them.
function appendCell(tr, text, klass) {
    const td = tr.insertCell();
    td.textContent = text;
    if (klass)
        td.className = klass;
}
function runInfoLabel(run, isBaseline) {
    if (!run)
        return '';
    const motors = run.deviceNames.length;
    const channels = run.channels?.channelNames?.length ?? 0;
    const buildId = run.buildIdentifier || '—';
    const truncated = run.truncated ? 'yes' : 'no';
    const baseline = isBaseline ? 'baseline' : '';
    const total = run.samples.length;
    return `motors=${motors}, channels=${channels}, samples=${total}, build=${buildId}, truncated=${truncated}${baseline ? `, ${baseline}` : ''}`;
}
function populateSelect(sel, runs, devicesOnly = false) {
    if (!sel)
        return;
    const previous = sel.value;
    sel.innerHTML = '';
    if (devicesOnly) {
        const devices = new Set();
        for (const r of runs.values())
            for (const d of r.deviceNames)
                devices.add(d);
        for (const d of Array.from(devices).sort()) {
            const opt = document.createElement('option');
            opt.value = d;
            opt.textContent = d;
            sel.appendChild(opt);
        }
    }
    else {
        for (const r of runs.values()) {
            const opt = document.createElement('option');
            opt.value = r.runId;
            opt.textContent = `${r.runStartedAt} – ${r.opmodeName} – ${r.runId.slice(0, 8)}`;
            sel.appendChild(opt);
        }
    }
    if (previous && (runs.has(previous) || (devicesOnly && Array.from(sel.options).some((o) => o.value === previous)))) {
        sel.value = previous;
    }
}
function sizeCanvas(canvas) {
    const parent = canvas.parentElement;
    if (!parent)
        return;
    const w = parent.clientWidth - 4 || 800;
    canvas.width = Math.max(300, w);
    canvas.height = Math.max(180, canvas.height || 220);
}
function escapeHtml(s) {
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
/** CSS-safe identifier segment derived from a device name.  No HTML injection. */
function cssIdSafe(s) {
    return String(s).replace(/[^A-Za-z0-9_.\-]/g, '_');
}
/** Compact elapsed-time formatter: 0s..59s as "Ns", minutes as "Mm SSs".  Missing → MISSING. */
function formatElapsed(ms) {
    if (ms == null || !Number.isFinite(ms) || ms < 0)
        return '\u2014';
    const totalSec = Math.floor(ms / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec - m * 60;
    if (m > 0)
        return `${m}m ${String(s).padStart(2, '0')}s`;
    return `${s}s`;
}
const liveState = {
    poller: new LivePoller(),
    store: new LiveStore(),
    paused: false,
    containerEl: null,
    lastSnapshotAtMs: null,
    lastSnap: null,
    connectionState: 'connecting',
    connectionStateAtMs: Date.now(),
};
// setConnectionState was previously a helper; the Live tab mutates
// liveState.connectionState inline inside its onSnap/onErr handlers,
// so the helper is no longer needed and has been removed to keep the
// screen-side state shape self-contained.
function renderLiveSection(root) {
    // Build (or replace) the Live section container.
    let el = root.querySelector('section[data-section="live"]');
    if (!el) {
        el = document.createElement('section');
        el.setAttribute('data-section', 'live');
        el.style.padding = '12px';
        root.appendChild(el);
    }
    liveState.containerEl = el;
    renderLiveDashboard(liveState);
    // Start polling (idempotent).
    if (!liveState.poller.isRunning()) {
        liveState.poller.start((snap) => {
            liveState.lastSnapshotAtMs = Date.now();
            liveState.lastSnap = snap;
            liveState.connectionState = 'connected';
            liveState.connectionStateAtMs = Date.now();
            if (!liveState.paused) {
                liveState.store.apply(snap);
            }
            if (liveState.containerEl)
                renderLiveDashboard(liveState);
        }, ({ reason, attempt }) => {
            liveState.connectionState = 'disconnected';
            liveState.connectionStateAtMs = Date.now();
            if (liveState.containerEl)
                renderLiveDashboard(liveState);
            // Quiet: console only, no UI flash to avoid flicker.
            // eslint-disable-next-line no-console
            console.warn('[RunHealth live] poll error attempt=' + attempt + ' reason=' + reason);
        });
    }
}
function renderLiveDashboard(s) {
    const el = s.containerEl;
    if (!el)
        return;
    const stats = liveSnapshotStats(s.store);
    const lastSeenAgo = s.lastSnapshotAtMs == null ? 'never' :
        Math.max(0, Math.round((Date.now() - s.lastSnapshotAtMs) / 1000)) + 's';
    const conn = s.connectionState;
    const connText = conn === 'connected' ? 'Connected' :
        conn === 'connecting' ? 'Connecting…' :
            conn === 'no_session' ? 'No active session' :
                'Disconnected (will retry)';
    // Buttons (Pause/Resume/Clear)
    const btns = `
    <div class="rh-live-toolbar" style="display:flex; gap:8px; margin-bottom:8px;">
      <button data-live-action="pause">${s.paused ? 'Resume rendering' : 'Pause rendering'}</button>
      <button data-live-action="clear">Clear visible history</button>
    </div>
  `;
    // Channel cards table (legacy <table> for compatibility with existing CSS).
    const channelNames = Array.from(s.store.channelHistoryByName.keys());
    let channelTable = '<table class="rh-live-channels"><thead><tr><th>name</th><th>current</th><th>unit</th><th>group</th></tr></thead><tbody>';
    for (const name of channelNames.slice(0, LIVE_LIMITS.MAX_CHANNEL_SERIES_PER_KIND)) {
        const slice = s.store.getChannel(name);
        if (!slice)
            continue;
        let current = '';
        if (slice.kind === 'number') {
            const last = slice.history[slice.history.length - 1];
            current = last && last.v != null ? String(last.v) : '—';
        }
        else if (slice.kind === 'boolean') {
            const last = slice.booleanHistory[slice.booleanHistory.length - 1];
            current = last && last.v != null ? (last.v ? 'true' : 'false') : '—';
        }
        else if (slice.kind === 'text') {
            const last = slice.textHistory[slice.textHistory.length - 1];
            current = last && last.text != null ? last.text : '—';
        }
        else if (slice.kind === 'pose') {
            const last = slice.poseHistory[slice.poseHistory.length - 1];
            current = last ? `(${last.x?.toFixed(1)},${last.y?.toFixed(1)})` : '—';
        }
        channelTable += `<tr><td>${escapeHtml(name)}</td><td>${escapeHtml(current)}</td><td>${escapeHtml(slice.unit ?? '')}</td><td>${escapeHtml(slice.group ?? '')}</td></tr>`;
    }
    channelTable += '</tbody></table>';
    // Field canvas (reuses drawField via build-only — see renderLiveField).
    const fieldCanvas = '<canvas data-live-field width="280" height="280" style="display:block; border:1px solid #ccc;"></canvas>';
    // Events list.
    const evs = s.store.getEvents().slice(-10);
    let evList = '<ol class="rh-live-events">';
    for (const e of evs) {
        evList += `<li><code>${escapeHtml(safeText(e.t))}</code> ${escapeHtml(e.label)}</li>`;
    }
    evList += '</ol>';
    // === build design-system DOM via cards.ts + observations.ts ===
    const liveStoreLike = s.store;
    const snapLike = s.lastSnap;
    const chips = buildLiveSummaryChips({
        store: liveStoreLike,
        snap: s.lastSnap,
        connectionState: s.connectionState === 'connected' ? 'connected' :
            s.connectionState === 'connecting' ? 'connecting' : 'disconnected',
        observedHz: stats.observedHz,
        motorCount: stats.motorCount,
        channelCount: stats.channelCount,
        eventCount: stats.eventCount,
        lastSnapshotAtMs: s.lastSnapshotAtMs,
        conditions: analyzeLiveConditions(liveStoreLike, snapLike),
    });
    const motorCards = buildMotorCardDescriptors({
        store: liveStoreLike,
        snap: s.lastSnap,
        observedNowMs: Date.now(),
    });
    const conditions = analyzeLiveConditions(liveStoreLike, snapLike);
    const conditionRows = buildConditionRows(conditions);
    const chipsHtml = chips.map((c) => {
        const klass = `rh-live-strip__chip${c.statusClass ? ' ' + c.statusClass : ''}`;
        const valueClass = c.statusClass ? `rh-status ${c.statusClass}` : 'rh-metric__value';
        return `<div class="${klass}"><span class="rh-metric__label">${escapeHtml(c.label)}</span><span class="${valueClass}">${escapeHtml(c.value)}</span>${c.unit ? `<span class="rh-metric__unit">${escapeHtml(c.unit)}</span>` : ''}${c.secondary ? `<span class="rh-metric__secondary">${escapeHtml(c.secondary)}</span>` : ''}</div>`;
    }).join('');
    const motorCardsHtml = motorCards.length === 0
        ? '<p class="rh-empty">No motor data yet.</p>'
        : motorCards.map((mc) => {
            const baseId = `rh-live-motor-${cssIdSafe(mc.deviceName)}`;
            const rowsHtml = mc.metricRows.map((r) => {
                const tone = r.tone === 'missing' ? ' rh-metric--missing' : '';
                return `<div class="rh-metric${tone}"><span class="rh-metric__label">${escapeHtml(r.label)}</span><span class="rh-metric__value">${escapeHtml(r.value)}</span></div>`;
            }).join('');
            return `<article class="rh-card--motor" data-live-motor="${escapeHtml(mc.deviceName)}"><header class="rh-card--motor__head"><span class="rh-card--motor__name">${escapeHtml(mc.deviceName)}</span><span class="rh-card--motor__mode">${escapeHtml(mc.mode)}</span></header><div class="rh-card--motor__metrics">${rowsHtml}</div><div class="rh-card--motor__graphs"><figure class="rh-card--motor__graph"><figcaption class="rh-card--motor__graph-label">Power</figcaption><canvas id="${baseId}-power" width="240" height="60" data-live-metric="power" data-motor="${escapeHtml(mc.deviceName)}"></canvas></figure><figure class="rh-card--motor__graph"><figcaption class="rh-card--motor__graph-label">Velocity</figcaption><canvas id="${baseId}-velocity" width="240" height="60" data-live-metric="velocity" data-motor="${escapeHtml(mc.deviceName)}"></canvas></figure><figure class="rh-card--motor__graph"><figcaption class="rh-card--motor__graph-label">Current</figcaption><canvas id="${baseId}-current" width="240" height="60" data-live-metric="current" data-motor="${escapeHtml(mc.deviceName)}"></canvas></figure></div></article>`;
        }).join('');
    const conditionsHtml = conditionRows.length === 0
        ? '<p class="rh-empty rh-empty--info">No advisories this window.</p>'
        : `<ul class="rh-conditions-list">${conditionRows.map((cr) => `      <li class="rh-condition ${cr.severityClass}"><div class="rh-condition__head"><span class="rh-status ${cr.severityClass}">${escapeHtml(cr.severity)}</span><span class="rh-condition__target">${escapeHtml(cr.target)}</span><span class="rh-condition__count">×${Number(cr.count) || 1}</span><time class="rh-condition__time">${escapeHtml(formatElapsed(cr.whenMs - (s.lastSnapshotAtMs ?? cr.whenMs)))}</time></div><p class="rh-condition__body">${escapeHtml(cr.body)}</p><p class="rh-condition__inspection">Inspect: ${escapeHtml(cr.inspection)}</p></li>`).join('')}</ul>`;
    el.innerHTML = `
    <h2 class="rh-card__title">Live</h2>
    <p class="rh-card__subtitle">Read-only view of the currently active Run Health session. The browser cannot start or stop an OpMode.</p>
    <div class="rh-card--motor" id="rh-live-conn-card" role="status" aria-live="polite"><div class="rh-card--motor__head"><span class="rh-card--motor__name"><span class="rh-live-dot" data-live-dot></span>${escapeHtml(connText)}</span><span class="rh-card--motor__mode">last update: ${escapeHtml(lastSeenAgo)} · observed ${stats.observedHz.toFixed(1)} Hz</span></div></div>
    <div class="rh-live-strip" id="rh-live-strip">${chipsHtml}</div>
    <div class="rh-live-toolbar">${btns}</div>
    <p data-live-rendering-note class="rh-card__subtitle">${s.paused ? 'Rendering paused — polling continues so reconnection state stays accurate. Pending history retained.' : 'Rendering updates every accepted snapshot; bounded 60s window.'}</p>
    <h3 class="rh-card__subtitle">Motors</h3>
    <div class="rh-grid--cards" id="rh-live-cards-grid">${motorCardsHtml}</div>
    <h3 class="rh-card__subtitle">Pose path</h3>
    ${fieldCanvas}
    <h3 class="rh-card__subtitle">Custom channels</h3>
    ${channelTable}
    <h3 class="rh-card__subtitle">Observed conditions</h3>
    <div class="rh-conditions" id="rh-conditions">${conditionsHtml}</div>
    <h3 class="rh-card__subtitle">Recent events</h3>
    ${evList}
  `;
    // Wire buttons.
    el.querySelectorAll('button[data-live-action]').forEach((btn) => {
        const a = btn.getAttribute('data-live-action');
        btn.onclick = (ev) => {
            ev.preventDefault();
            if (a === 'pause') {
                s.paused = !s.paused;
                renderLiveDashboard(s);
            }
            else if (a === 'clear') {
                s.store.reset();
                renderLiveDashboard(s);
            }
        };
    });
    // Render the motor canvases (lightweight: spot-render last 60 points).
    el.querySelectorAll('canvas[data-live-metric]').forEach((canvas) => {
        const metric = canvas.getAttribute('data-live-metric');
        const name = canvas.getAttribute('data-motor');
        if (!metric || !name)
            return;
        const slice = s.store.getMotor(name);
        if (!slice)
            return;
        const series = (metric === 'power') ? slice.powerHistory :
            (metric === 'velocity') ? slice.velocityHistory :
                (metric === 'current') ? slice.currentHistory :
                    slice.batteryHistory;
        drawHudSparkline(canvas, series);
    });
    // Render pose field canvas.
    const fc = el.querySelector('canvas[data-live-field]');
    if (fc)
        drawLiveField(fc, s.store);
}
function drawHudSparkline(canvas, series) {
    const w = canvas.width, h = canvas.height;
    const ctx = canvas.getContext('2d');
    if (!ctx)
        return;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#fafafa';
    ctx.fillRect(0, 0, w, h);
    if (series.length === 0)
        return;
    let lo = Number.POSITIVE_INFINITY, hi = Number.NEGATIVE_INFINITY;
    for (const p of series) {
        if (p.v == null)
            continue;
        if (p.v < lo)
            lo = p.v;
        if (p.v > hi)
            hi = p.v;
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo === hi) {
        hi = lo + 1;
    }
    ctx.strokeStyle = '#444';
    ctx.lineWidth = 1;
    ctx.beginPath();
    let first = true;
    for (let i = 0; i < series.length; i++) {
        const p = series[i];
        if (p.v == null)
            continue;
        const x = (i / Math.max(1, series.length - 1)) * (w - 4) + 2;
        const y = h - 4 - ((p.v - lo) / (hi - lo)) * (h - 8);
        if (first) {
            ctx.moveTo(x, y);
            first = false;
        }
        else
            ctx.lineTo(x, y);
    }
    ctx.stroke();
}
function drawLiveField(canvas, store) {
    // Lightweight field renderer: 12 ft × 12 ft field, 280x280 px, axes,
    // 24-inch tile grid, bounded traveled path from the live pose channel.
    const w = canvas.width, h = canvas.height;
    const ctx = canvas.getContext('2d');
    if (!ctx)
        return;
    const inchesPerSide = 144; // 12 ft = 144 in
    const pxPerIn = (w - 20) / inchesPerSide;
    const cx = w / 2, cy = h / 2;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#f4f4f0';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = '#bbb';
    ctx.lineWidth = 2;
    ctx.strokeRect(0, 0, w, h);
    // Grid every 24 inches (2 ft).
    ctx.strokeStyle = '#ddd';
    ctx.lineWidth = 1;
    for (let i = -72; i <= 72; i += 24) {
        const px = cx + i * pxPerIn;
        ctx.beginPath();
        ctx.moveTo(px, 0);
        ctx.lineTo(px, h);
        ctx.stroke();
        const py = cy - i * pxPerIn; // positive y is up
        ctx.beginPath();
        ctx.moveTo(0, py);
        ctx.lineTo(w, py);
        ctx.stroke();
    }
    // Axis labels.
    ctx.fillStyle = '#666';
    ctx.font = '11px sans-serif';
    ctx.fillText('+X →', w - 28, cy - 6);
    ctx.fillText('+Y ↑', cx + 6, 12);
    ctx.fillText('0', cx - 4, cy + 12);
    // Traveled path bounded to MAX_PATH_POINTS.
    const path = store.getPrimaryPath();
    ctx.strokeStyle = '#1976d2';
    ctx.lineWidth = 2;
    ctx.beginPath();
    let started = false;
    for (const p of path.slice(-LIVE_LIMITS.MAX_PATH_POINTS)) {
        if (p.x == null || p.y == null)
            continue;
        const x = cx + p.x * pxPerIn;
        const y = cy - p.y * pxPerIn;
        if (!started) {
            ctx.moveTo(x, y);
            started = true;
        }
        else
            ctx.lineTo(x, y);
    }
    ctx.stroke();
    // Current robot marker heading.
    const last = store.lastPose();
    if (last) {
        const px = cx + last.x * pxPerIn;
        const py = cy - last.y * pxPerIn;
        ctx.fillStyle = '#d33';
        ctx.beginPath();
        ctx.arc(px, py, 5, 0, Math.PI * 2);
        ctx.fill();
        // Heading indicator (line 12in forward).
        const hLen = 12 * pxPerIn;
        const hx = px + Math.cos(last.heading) * hLen;
        const hy = py - Math.sin(last.heading) * hLen;
        ctx.strokeStyle = '#d33';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(hx, hy);
        ctx.stroke();
    }
}
//# sourceMappingURL=main.js.map