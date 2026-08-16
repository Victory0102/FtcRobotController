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
import { parseUnifiedRun, parseChannelsCsv, parseManifestJson, detectDuplicates, } from './parser.js';
import { wholeRobotComparison, perMotorTrend, } from './comparison.js';
import { motorMetricSeries, seriesDomain, drawSeries, } from './graphs.js';
import { globalReplayClock, lookupNumeric, lookupBoolean, lookupText, runDurationMs, PLAYBACK_SPEEDS, } from './replay.js';
import { applyDeltas, customChannelTrend, } from './trends.js';
import { LivePoller, LiveStore, liveSnapshotStats, safeText, LIVE_LIMITS, } from './live.js';
import { getStatusClass, getStatusLabel } from './status.js';
import { formatPower, formatTps, formatAmps, formatFractionPct, formatFractionPctSigned, formatSignedDiff, } from './format.js';
import { buildCompareSummary, buildImportSummary, buildLiveSummaryChips, buildMotorCardDescriptors, buildConditionRows, humanizeDeviceName, } from './cards.js';
import { analyzeLiveConditions, } from './observations.js';
import { METRIC_HELP, getMetricHelp } from './metricHelp.js';
import { buildTimeOverlay, buildWearHistory, compareMotorWear, } from './wear.js';
const statePerKey = new WeakMap();
const API_BASE = '/runhealth/api';
// The Control Hub web server is resource constrained. One recording transfer
// at a time is faster and more reliable than competing reads.
const MAX_HYDRATION_WORKERS = 1;
const RUN_FETCH_TIMEOUT_MS = 20000;
const RUN_FETCH_ATTEMPTS = 2;
function runApiUrl(runId, action) {
    const query = new URLSearchParams({ id: runId });
    if (action)
        query.set('action', action);
    return `${API_BASE}/runs?${query.toString()}`;
}
const autoSaveState = {
    pendingNextRun: false,
    everyMode: false,
    lastRecordingMode: 'OFF',
    inFlight: false,
    lastSyncAtMs: 0,
};
const AUTO_SAVE_INTENT_KEY = 'runhealth.autoSaveIntent.v1';
function rememberAutoSaveIntent(mode) {
    autoSaveState.pendingNextRun = mode === 'NEXT';
    autoSaveState.everyMode = mode === 'EVERY';
    try {
        if (mode === 'OFF')
            localStorage.removeItem(AUTO_SAVE_INTENT_KEY);
        else
            localStorage.setItem(AUTO_SAVE_INTENT_KEY, mode);
    }
    catch { /* storage is optional */ }
}
function restoreAutoSaveIntent() {
    try {
        const mode = localStorage.getItem(AUTO_SAVE_INTENT_KEY);
        if (mode === 'NEXT' || mode === 'EVERY')
            rememberAutoSaveIntent(mode);
    }
    catch { /* storage is optional */ }
}
function setAutoSaveStatus(root, message) {
    const el = root.querySelector('#rh-sync-status');
    if (el)
        el.textContent = message;
}
function setDownloadReadyStatus(root, message, hubRunId, filename) {
    const el = root.querySelector('#rh-sync-status');
    if (!el)
        return;
    el.textContent = `${message} `;
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = `Download ${filename} again`;
    button.className = 'rh-download-fallback';
    button.addEventListener('click', () => {
        void downloadConnectedRun(`hub:${hubRunId}`, null).catch((error) => {
            setAutoSaveStatus(root, `Download failed: ${error.message}`);
        });
    });
    el.appendChild(button);
}
function recordingModeStatus(mode, connected) {
    if (!connected) {
        return 'Control Hub not connected yet. Save Next Run and Save Every Run will activate once the browser can reach the hub.';
    }
    if (autoSaveState.everyMode) {
        return 'Save Every Run is armed. Completed runs will be saved to this computer automatically.';
    }
    if (autoSaveState.pendingNextRun) {
        return mode === 'NEXT'
            ? 'Save Next Run is armed. The next completed run will be saved to this computer automatically.'
            : 'Save Next Run was armed and is waiting for that run to finish.';
    }
    switch (mode) {
        case 'OFF':
            return 'Recording is off.';
        default:
            return 'Recording mode is unknown.';
    }
}
/* =========================================================== entry */
document.addEventListener('DOMContentLoaded', () => {
    const root = document.getElementById('app');
    if (!root)
        return;
    const ctx = {
        runs: new Map(),
        importedFiles: new Map(),
        replayByRun: new Map(),
        connectedHub: false,
        connectedRunIds: new Set(),
        hubRunIdByRunId: new Map(),
        hubRuns: new Map(),
        connectedHubFileIds: new Set(),
        hydratingHubRuns: new Set(),
        hydrationErrors: new Map(),
        hydrationInFlight: new Map(),
        hydrationQueue: [],
        hydrationWorkers: 0,
        selectedReplayRunId: '',
        replayConsumerDispose: null,
    };
    statePerKey.set(root, ctx);
    restoreAutoSaveIntent();
    renderShell(root);
    attachHandlers(root);
    updateStateAndRender(root);
    discoverControlHubApi().then((available) => {
        if (available) {
            void refreshConnectedRuns(root);
            void refreshRecordingControl(root);
        }
    });
    window.setInterval(() => {
        if (autoSaveState.pendingNextRun || autoSaveState.everyMode) {
            void syncCompletedRunsFromHub(root);
        }
    }, 1500);
});
/* =========================================================== tabs / shell */
const TABS = [
    { id: 'live', label: 'Live' },
    { id: 'saved', label: 'Saved Runs' },
    { id: 'compare', label: 'Compare' },
    { id: 'replay', label: 'Replay' },
    { id: 'channels', label: 'Channels' },
    { id: 'trend', label: 'Trends' },
    { id: 'import', label: 'Import' },
];
function renderShell(root) {
    const tabs = TABS.map((t, i) => `<button data-tab="${t.id}" class="rh-tab${i === 0 ? ' active' : ''}">${escapeHtml(t.label)}</button>`).join('');
    root.innerHTML = `
    <div class="rh-shell">
      <aside class="rh-sidebar">
        <div class="rh-brand">
          <div class="rh-brand__eyebrow">FTC Run Health</div>
          <h1>Mission Control</h1>
          <p class="rh-tagline">Read-only robot observability, recording, replay, and diagnostics.</p>
          <p class="rh-descriptor">Watch live motor health, save runs to this computer, and compare what changed.</p>
        </div>
        <div class="rh-sidebar__panel">
          <div class="rh-sidebar__label">Workflow</div>
          <p class="rh-sidebar__body">Connect to the Control Hub Wi-Fi, open the dashboard, arm recording, then run the OpMode.</p>
        </div>
        <nav class="rh-tabs rh-tabs--vertical" aria-label="Dashboard sections">${tabs}</nav>
      </aside>
      <main class="rh-main">
        <section class="rh-hero">
          <div class="rh-hero__copy">
            <div class="rh-hero__eyebrow">Robot diagnostics</div>
            <h2>See what the drivetrain is actually doing.</h2>
            <p>Live graphs, saved runs, replay, compare, trends, and offline imports all stay in one place. Save Next Run or Save Every Run downloads each completed run to this computer automatically.</p>
          </div>
          <div class="rh-hero__highlights" aria-label="Highlights">
            <div class="rh-hero__highlight">
              <span class="rh-hero__highlight-label">Live</span>
              <strong>Motor command, velocity, current, and response</strong>
            </div>
            <div class="rh-hero__highlight">
              <span class="rh-hero__highlight-label">Save</span>
              <strong>Downloads land on the laptop, not the robot</strong>
            </div>
            <div class="rh-hero__highlight">
              <span class="rh-hero__highlight-label">Diagnose</span>
              <strong>Replay, compare, trends, and custom channels</strong>
            </div>
          </div>
        </section>
        <details class="rh-learning-guide">
          <summary>New to Run Health? Start here</summary>
          <div class="rh-learning-guide__grid">
            <div><strong>1. Command</strong><p>Commanded power is what your OpMode asks the motor to do, from -1 reverse to +1 forward.</p></div>
            <div><strong>2. Response</strong><p>Encoder velocity is what the motor actually delivered. Current is the electrical effort used to produce that motion.</p></div>
            <div><strong>3. Compare</strong><p>Use the same route, battery condition, payload, and motor mode. Choose the earlier run as Reference and the later run as Comparison.</p></div>
            <div><strong>4. Interpret carefully</strong><p>Warnings identify measured differences, not confirmed failures. Inspect wiring, wheels, gears, bearings, battery, and test conditions before replacing parts.</p></div>
          </div>
          <p class="rh-learning-guide__note"><strong>Important:</strong> Unavailable data is not zero. Ticks/second depends on encoder and gearing, so compare a motor against its own earlier tests.</p>
        </details>
      <section data-section="live"></section>
      <section data-section="saved" hidden>
        <div class="rh-card">
          <h2>Recording mode</h2>
          <p class="rh-card__subtitle">Turn on Save Next Run or Save Every Run before an integrated OpMode to stream live data and save completed runs to this computer.</p>
          <div id="rh-record-control" class="rh-record-control" role="group" aria-label="Recording mode">
            <button type="button" data-rec="OFF" class="rh-rec-btn">Off</button>
            <button type="button" data-rec="NEXT" class="rh-rec-btn">Save Next Run</button>
            <button type="button" data-rec="EVERY" class="rh-rec-btn">Save Every Run</button>
          </div>
          <p id="rh-record-status" class="rh-record-status" role="status"></p>
          <p id="rh-sync-status" class="rh-sync-status" role="status" aria-live="polite">Auto-save is idle.</p>
        </div>
        <div class="rh-card">
          <h2>Saved Runs</h2>
          <p class="rh-card__subtitle">A run becomes usable in every analysis tool after its motor samples are loaded. Hover or focus any <strong>?</strong> beside a column label for its meaning.</p>
          <div id="rh-saved-status"></div>
          <table id="rh-saved-table"></table>
        </div>
      </section>

      <section data-section="compare" hidden>
        <div class="rh-card">
          <h2>Motor Wear Comparison</h2>
          <p class="rh-card__subtitle">Compare the same test from two dates. The analysis matches commanded-power bands before reporting response changes, so different driving profiles are not mistaken for motor wear.</p>
          <select id="rh-mode" hidden><option value="DIRECT" selected>Direct</option></select>
          <label id="rh-baseline-row" hidden>Baseline:
            <select id="rh-baseline"></select>
          </label>
          <div class="rh-compare-picker">
          <label id="rh-reference-row">Reference run (earlier):
            <select id="rh-reference"></select>
          </label>
          <label id="rh-comparison-row">Comparison run (later):
            <select id="rh-comparison"></select>
          </label>
          </div>
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
            <label>Motor to diagnose:
              <select id="rh-graph-motor"></select>
            </label>
          </div>
          <p class="rh-evidence-note">Diagnostic results are advisory and read-only. Confidence falls when command coverage, motor modes, battery state, or sample counts are not comparable.</p>
          <details class="rh-section-help"><summary>How to read a comparison</summary><p><strong>Reference</strong> is the earlier known-good run. <strong>Comparison</strong> is the later run. Velocity shows delivered motion, current shows electrical effort, and command-to-motion response shows how much speed was delivered for similar power. Compare repeated tests, not unrelated driving sessions.</p></details>
          <div id="rh-wear-report" class="rh-wear-report" aria-live="polite"></div>
          <div id="rh-compare-summary" class="rh-grid--summary" aria-live="polite"></div>
          <div id="rh-compare-cards" class="rh-compare-cards" aria-live="polite"></div>
          <details id="rh-compare-details-wrap">
            <summary class="rh-compare-summary-title">Detailed metric table</summary>
            <p class="rh-card__subtitle">All 25 metrics per motor in one dense view. The collapsible cards above are usually easier to read.</p>
            <table id="rh-whole" class="rh-table"></table>
          </details>
          <h3>Overlay diagnostics</h3>
          <div class="rh-diagnostic-graphs">
            <figure class="rh-diagnostic-panel">
              <figcaption><strong>Commanded power over run</strong><span>Y: commanded power (-1 to +1) · X: normalized run time (%)</span></figcaption>
              <canvas id="rh-compare-power" width="1200" height="360" role="img" aria-label="Reference and comparison commanded power overlay"></canvas>
              <div id="rh-diagnosis-power" class="rh-graph-diagnosis"></div>
            </figure>
            <figure class="rh-diagnostic-panel">
              <figcaption><strong>Motor velocity over run</strong><span>Y: encoder velocity (ticks/second) · X: normalized run time (%)</span></figcaption>
              <canvas id="rh-compare-velocity" width="1200" height="360" role="img" aria-label="Reference and comparison motor velocity overlay"></canvas>
              <div id="rh-diagnosis-velocity" class="rh-graph-diagnosis"></div>
            </figure>
            <figure class="rh-diagnostic-panel">
              <figcaption><strong>Motor current over run</strong><span>Y: current (amps) · X: normalized run time (%)</span></figcaption>
              <canvas id="rh-compare-current" width="1200" height="360" role="img" aria-label="Reference and comparison motor current overlay"></canvas>
              <div id="rh-diagnosis-current" class="rh-graph-diagnosis"></div>
            </figure>
            <figure class="rh-diagnostic-panel rh-diagnostic-panel--response">
              <figcaption><strong>Commanded power to delivered velocity</strong><span>Y: median absolute velocity (ticks/second) · X: absolute commanded power</span></figcaption>
              <canvas id="rh-compare-response" width="1200" height="360" role="img" aria-label="Reference and comparison power to velocity response overlay"></canvas>
              <div id="rh-diagnosis-response" class="rh-graph-diagnosis"></div>
            </figure>
          </div>
        </div>
      </section>

      <section data-section="replay" hidden>
        <div class="rh-card">
          <h2>Replay</h2>
          <p class="rh-replay-banner-note" role="note">Replay displays recorded data only. It does not send commands to the robot.</p>
          <p class="rh-card__subtitle">Move through one saved run in recorded time. The graph shows the most recent two-second window; the table reports custom-channel values at the current replay timestamp.</p>
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
          <figure class="rh-explained-chart">
            <figcaption><strong>Motor signals at replay time</strong><span>Horizontal axis: recorded time (ms) · Lines: power, velocity, current, and battery where available</span></figcaption>
            <canvas id="rh-replay-canvas" class="rh-canvas" role="img" aria-label="Recorded motor signals over the latest two seconds of replay"></canvas>
            <p>Use this view to align a visible event with changes in motor command and measured response. Because signals use different units, use the detailed values and Compare graphs for numerical conclusions.</p>
          </figure>
          <h3>Live values</h3>
          <table id="rh-replay-values" class="rh-table"></table>
        </div>
      </section>

      <section data-section="channels" hidden>
        <div class="rh-card">
          <h2>Custom Channels (selected run)</h2>
          <p class="rh-card__subtitle">Custom channels are extra read-only values intentionally published by the OpMode. Their unit, group, and description come from the team’s channel registration.</p>
          <label>Run:
            <select id="rh-channels-run"></select>
          </label>
          <div id="rh-channel-cards"></div>
        </div>
      </section>

      <section data-section="trend" hidden>
        <div class="rh-card">
          <h2>Motor Health History</h2>
          <p class="rh-card__subtitle">Track one motor across repeated runs of the same OpMode. The first loaded run in the selected test becomes the historical reference.</p>
          <details class="rh-section-help"><summary>How to build a useful trend</summary><p>Repeat the same test with the same motor mode, payload, surface, and similar battery state. A single change is a reason to inspect; a repeated direction across several runs is stronger evidence of drift.</p></details>
          <label>Repeatable test / OpMode:
            <select id="rh-trend-opmode"></select>
          </label>
          <label>Motor:
            <select id="rh-trend-motor"></select>
          </label>
          <label>Series:
            <select id="rh-trend-series">
              <option value="wearHealth">Motor evidence score</option>
              <option value="responseVsFirst">Response change vs first run (%)</option>
              <option value="currentVsFirst">Current change vs first run (%)</option>
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
          <figure class="rh-explained-chart">
            <figcaption><strong id="rh-trend-chart-title">Trend chart</strong><span id="rh-trend-axis-label">Horizontal axis: run date · Vertical axis: selected metric</span></figcaption>
            <canvas id="rh-trend-canvas" class="rh-canvas" role="img" aria-label="Selected motor health metric across recorded runs"></canvas>
            <p id="rh-trend-metric-help">Choose a series to see what it measures.</p>
          </figure>
          <div id="rh-trend-diagnosis" class="rh-graph-diagnosis"></div>
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
    </div>
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
        const importedIds = Array.from(ctx.importedFiles.keys());
        for (const runId of importedIds) {
            ctx.runs.delete(runId);
            ctx.replayByRun.delete(runId);
            if (ctx.selectedReplayRunId === runId)
                ctx.selectedReplayRunId = '';
            if (getBaselineId() === runId)
                setBaselineId('');
        }
        ctx.importedFiles.clear();
        const list = root.querySelector('#rh-import-list');
        if (list)
            list.innerHTML = '';
        updateStateAndRender(root);
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
        '#rh-comparison', '#rh-trend-opmode', '#rh-trend-motor', '#rh-trend-series', '#rh-graph-motor',
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
    root.querySelector('#rh-channels-run')
        ?.addEventListener('change', () => renderChannelsSection(root));
    // Recording-mode control (Saved Runs tab).
    root.querySelectorAll('button[data-rec]').forEach((btn) => {
        btn.addEventListener('click', async () => {
            const mode = btn.dataset.rec;
            const previousIntent = autoSaveState.pendingNextRun ? 'NEXT'
                : autoSaveState.everyMode ? 'EVERY' : 'OFF';
            try {
                if (mode !== 'OFF')
                    await refreshConnectedRuns(root, false);
                // Use POST because the hub's PUT body handling is unreliable here.
                const r = await fetch(`${API_BASE}/recording`, {
                    method: 'POST',
                    credentials: 'include',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ mode }),
                });
                if (!r.ok)
                    throw new Error('HTTP ' + r.status);
                rememberAutoSaveIntent(mode);
                await refreshRecordingControl(root);
                if (mode !== 'OFF')
                    void syncCompletedRunsFromHub(root);
            }
            catch (e) {
                rememberAutoSaveIntent(previousIntent);
                alert(`Could not change recording mode: ${e.message}`);
            }
        });
    });
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
        ctx = {
            runs: new Map(),
            importedFiles: new Map(),
            replayByRun: new Map(),
            connectedHub: false,
            connectedRunIds: new Set(),
            hubRunIdByRunId: new Map(),
            hubRuns: new Map(),
            connectedHubFileIds: new Set(),
            hydratingHubRuns: new Set(),
            hydrationErrors: new Map(),
            hydrationInFlight: new Map(),
            hydrationQueue: [],
            hydrationWorkers: 0,
            selectedReplayRunId: '',
            replayConsumerDispose: null,
        };
        statePerKey.set(root, ctx);
    }
    return ctx;
}
function updateStateAndRender(root) {
    void refreshRecordingControl(root);
    renderSavedSection(root);
    renderCompareSection(root);
    renderReplaySection(root);
    renderChannelsSection(root);
    renderTrendSection(root);
    renderImportSummary(root);
    decorateMetricHelp(root);
    // The Live tab runs on its own bounded poller; calling here is safe
    // and idempotent — the poller checks isRunning() before scheduling.
    renderLiveSection(root);
}
/* =========================================================== Recording mode */
const RECORD_LABELS = {
    OFF: 'Off — nothing is recorded while an OpMode runs.',
    NEXT: 'Save Next Run — armed; the claim is consumed on the first sample.',
    EVERY: 'Save Every Run — every eligible integrated OpMode is recorded.',
};
let recordControlInFlight = false;
/** Reads the persisted recording mode from the Control Hub. */
async function refreshRecordingControl(root) {
    if (recordControlInFlight)
        return;
    recordControlInFlight = true;
    try {
        const ctx = getCtx(root);
        const status = root.querySelector('#rh-record-status');
        const btns = root.querySelectorAll('button[data-rec]');
        if (!status)
            return;
        const r = await fetch(`${API_BASE}/recording`, { credentials: 'include' });
        if (!r.ok)
            throw new Error('HTTP ' + r.status);
        const data = await r.json();
        const mode = typeof data.mode === 'string' ? data.mode : 'OFF';
        ctx.connectedHub = true;
        autoSaveState.lastRecordingMode = mode;
        if (mode === 'NEXT') {
            rememberAutoSaveIntent('NEXT');
        }
        else if (mode === 'EVERY') {
            rememberAutoSaveIntent('EVERY');
        }
        else if (mode === 'OFF') {
            // NEXT is consumed by the first sample, so the hub correctly reports
            // OFF while the browser must keep waiting for that run to finish.
            if (!autoSaveState.pendingNextRun)
                autoSaveState.everyMode = false;
        }
        else {
            autoSaveState.pendingNextRun = false;
            autoSaveState.everyMode = false;
        }
        btns.forEach((b) => b.classList.toggle('active', b.dataset.rec === mode));
        status.textContent = RECORD_LABELS[mode] ?? RECORD_LABELS.OFF;
        status.dataset.mode = mode;
        setAutoSaveStatus(root, recordingModeStatus(mode, true));
    }
    catch (e) {
        const ctx = getCtx(root);
        const status = root.querySelector('#rh-record-status');
        root.querySelectorAll('button[data-rec]')
            .forEach((b) => b.classList.remove('active'));
        ctx.connectedHub = false;
        if (status) {
            delete status.dataset.mode;
            status.textContent = 'Not connected to a Control Hub — recording is controlled from the hub web server.';
        }
        autoSaveState.lastRecordingMode = 'OFF';
        setAutoSaveStatus(root, recordingModeStatus('OFF', false));
    }
    finally {
        recordControlInFlight = false;
    }
}
/* =========================================================== Saved Runs */
function renderSavedSection(root) {
    const ctx = getCtx(root);
    const table = root.querySelector('#rh-saved-table');
    const status = root.querySelector('#rh-saved-status');
    if (ctx.runs.size === 0 && ctx.importedFiles.size === 0 && ctx.hubRuns.size === 0) {
        status.textContent = 'No runs loaded. Drag CSVs onto this page or connect to a Control Hub.';
        table.innerHTML = '';
        return;
    }
    const baselineId = getBaselineId();
    const rows = [];
    for (const r of ctx.runs.values()) {
        const imported = ctx.importedFiles.get(r.runId);
        rows.push({
            run: r,
            name: imported?.name ?? r.sourceFileName,
            imported: imported != null,
            isBaseline: r.runId === baselineId,
        });
    }
    rows.sort((a, b) => b.run.runStartedAt.localeCompare(a.run.runStartedAt));
    const parsedHubIds = new Set(Array.from(ctx.hubRunIdByRunId.entries())
        .filter(([runId]) => !runId.startsWith('hub:'))
        .map(([, hubRunId]) => hubRunId));
    const metadataOnly = Array.from(ctx.hubRuns.values())
        .filter((meta) => !parsedHubIds.has(meta.hubRunId))
        .sort((a, b) => b.lastModifiedMs - a.lastModifiedMs);
    const analyzing = ctx.hydratingHubRuns.size;
    const queuedCount = ctx.hydrationQueue.length;
    status.textContent = `${ctx.hubRuns.size} hub recording(s); ${rows.length} ready in all analysis tools` +
        `${analyzing > 0 ? `; ${analyzing} analyzing` : ''}${queuedCount > 0 ? `; ${queuedCount} queued` : ''}.`;
    table.innerHTML = `
    <thead>
      <tr>
        <th>OpMode</th><th>Run ID</th><th>Started</th><th>Source</th><th>Size</th>
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
      <td><code>${escapeHtml(shortRunId(row.run.runId))}</code></td>
      <td>${escapeHtml(row.run.runStartedAt)}</td>
      <td>${row.imported ? 'Imported' : 'Hub'}</td>
      <td>${row.run.samples.length > 0 ? '~' + Math.round(samples * 0.1) + ' KB' : '—'}</td>
      <td>${motors}</td>
      <td>${channelCount}</td>
      <td>${samples}</td>
      <td>${escapeHtml(row.run.buildIdentifier || '—')}</td>
      <td>${row.run.truncated ? 'Yes' : 'No'}</td>
      <td>${row.isBaseline ? '✓' : ''}</td>
      <td>
        <button data-act="open" data-id="${escapeHtml(row.run.runId)}" data-imported="${row.imported ? '1' : '0'}">Open</button>
        <button data-act="baseline" data-id="${escapeHtml(row.run.runId)}" data-imported="${row.imported ? '1' : '0'}">Set Baseline</button>
        <button data-act="delete" data-id="${escapeHtml(row.run.runId)}" data-imported="${row.imported ? '1' : '0'}">Delete</button>
        <button data-act="dl" data-id="${escapeHtml(row.run.runId)}" data-imported="${row.imported ? '1' : '0'}">Download</button>
      </td>`;
        tbody.appendChild(tr);
    }
    for (const meta of metadataOnly) {
        const tr = document.createElement('tr');
        const key = `hub:${meta.hubRunId}`;
        const hydrating = ctx.hydratingHubRuns.has(meta.hubRunId);
        const queued = ctx.hydrationQueue.includes(meta.hubRunId);
        const hydrationError = ctx.hydrationErrors.get(meta.hubRunId);
        tr.innerHTML = `
      <td>${hydrating ? 'Analyzing…' : queued ? 'Queued for analysis' : hydrationError ? 'Analysis unavailable' : 'Ready to download'}</td>
      <td><code>${escapeHtml(meta.hubRunId.slice(-12))}</code></td>
      <td>${meta.lastModifiedMs > 0 ? escapeHtml(new Date(meta.lastModifiedMs).toLocaleString()) : '—'}</td>
      <td>Hub</td>
      <td>${escapeHtml(formatBytes(meta.sizeBytes))}</td>
      <td>—</td><td>—</td><td>—</td><td>—</td>
      <td>${meta.truncated ? 'Yes' : 'No'}</td><td></td>
      <td>
        <button data-act="analyze" data-id="${escapeHtml(key)}" data-imported="0"${hydrating ? ' disabled' : ''}>${hydrating ? 'Analyzing…' : queued ? 'Prioritize' : hydrationError ? 'Retry analysis' : 'Analyze now'}</button>
        <button data-act="delete" data-id="${escapeHtml(key)}" data-imported="0">Delete</button>
        <button data-act="dl" data-id="${escapeHtml(key)}" data-imported="0">Download</button>
        ${hydrationError ? `<span class="rh-inline-error" role="alert">${escapeHtml(hydrationError)}</span>` : ''}
      </td>`;
        tbody.appendChild(tr);
    }
    table.querySelectorAll('button[data-act]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const id = btn.dataset.id;
            const act = btn.dataset.act;
            const imported = btn.dataset.imported === '1';
            if (act === 'open') {
                sectionSwitch(root, 'replay');
                attachReplayRun(root, id);
            }
            else if (act === 'baseline') {
                void apiSetBaseline(root, id, imported);
            }
            else if (act === 'delete') {
                if (confirm('Delete this run and its companion files?')) {
                    void apiDeleteRun(root, id, imported);
                }
            }
            else if (act === 'dl') {
                void apiDownloadRun(root, id, imported);
            }
            else if (act === 'analyze') {
                queueHubRunForHydration(root, id, true);
            }
        });
    });
    const duplicates = detectDuplicates(Array.from(ctx.runs.values()));
    if (duplicates.size > 0) {
        const list = Array.from(duplicates.entries()).map(([k, n]) => `${k.slice(0, 8)}×${n}`).join(', ');
        status.textContent += ` Duplicate run_ids detected: ${list}.`;
    }
    decorateMetricHelp(root);
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
        <td>${metricHelpMarkup(r.metric)}</td>
        <td>${escapeHtml(r.reference)}</td>
        <td>${escapeHtml(r.comparison)}</td>
        <td>${escapeHtml(r.rawDifference)}</td>
        <td>${escapeHtml(r.percentDifference)}</td>
      </tr>`).join('');
        return `<details class="${statusKlass}" data-compare-card="${escapeHtml(card.deviceName)}"><summary class="rh-compare-card__summary"><div class="rh-card--motor__identity"><span class="rh-card--motor__name">${escapeHtml(card.displayName)}</span><span class="rh-card--motor__tag">${escapeHtml(card.deviceName)}</span></div><span class="rh-status ${card.statusClass}">${escapeHtml(card.statusLabel)}</span><span class="rh-compare-card__presence">${escapeHtml(card.presence)}</span><span class="rh-compare-card__samples">${escapeHtml(card.sampleConfidence)} samples</span></summary><div class="rh-compare-card__body"><table class="rh-table"><thead><tr><th>Metric</th><th>Reference</th><th>Comparison</th><th>Raw diff</th><th>Percent diff</th></tr></thead><tbody>${rowsHtml}</tbody></table></div></details>`;
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
    const refSelect = root.querySelector('#rh-reference');
    const cmpSelect = root.querySelector('#rh-comparison');
    if (refSelect && cmpSelect && refSelect.value === cmpSelect.value && cmpSelect.options.length > 1) {
        const baseline = getBaselineId();
        refSelect.value = baseline && ctx.runs.has(baseline) ? baseline : refSelect.options[0].value;
        cmpSelect.value = cmpSelect.options[cmpSelect.options.length - 1].value;
        if (refSelect.value === cmpSelect.value)
            refSelect.value = refSelect.options[0].value;
    }
    renderCompareSummaryStrip(root);
    renderCompareCards(root);
    renderWholeTable(root);
    renderWearAnalysis(root);
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
        appendHelpDot(th, helpKeyForLabel(h));
        trh.appendChild(th);
    }
    const tbody = table.createTBody();
    for (const row of out.rows) {
        const tr = tbody.insertRow();
        appendCell(tr, humanizeDeviceName(row.deviceName));
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
/* =========================================================== Wear comparison */
function renderWearAnalysis(root) {
    const ctx = getCtx(root);
    const reportEl = root.querySelector('#rh-wear-report');
    if (!reportEl)
        return;
    const refId = root.querySelector('#rh-reference')?.value ?? '';
    const cmpId = root.querySelector('#rh-comparison')?.value ?? '';
    const motor = root.querySelector('#rh-graph-motor')?.value ?? '';
    const reference = ctx.runs.get(refId) ?? null;
    const comparison = ctx.runs.get(cmpId) ?? null;
    if (!reference || !comparison || !motor || reference.runId === comparison.runId) {
        reportEl.innerHTML = '<p class="rh-empty">Load and select two different runs to begin a wear comparison.</p>';
        clearComparisonCanvases(root, 'Select two different runs');
        return;
    }
    const filter = {
        direction: root.querySelector('#rh-direction')?.value ?? 'BOTH',
        powerBand: root.querySelector('#rh-band')?.value ?? 'ALL_ACTIVE',
    };
    const report = compareMotorWear(reference, comparison, motor, filter);
    const sharedMotors = reference.deviceNames.filter((name) => comparison.deviceNames.includes(name));
    const fleetReports = sharedMotors
        .map((name) => compareMotorWear(reference, comparison, name, filter))
        .sort((a, b) => (a.healthScore ?? 1000) - (b.healthScore ?? 1000));
    const fleetResponse = fleetReports
        .map((item) => item.responseChangePct)
        .filter((value) => value !== null);
    const fleetMedianResponse = fleetResponse.length > 0 ? median(fleetResponse) : null;
    let fleetContext = 'Not enough comparable motors to separate local and robot-wide changes.';
    if (fleetMedianResponse !== null && report.responseChangePct !== null && fleetReports.length >= 2) {
        if (report.responseChangePct < fleetMedianResponse - 10) {
            fleetContext = 'This motor declined more than its peers, which points toward a local motor, gearbox, wheel, bearing, wiring, or encoder path.';
        }
        else if (fleetMedianResponse <= -8) {
            fleetContext = 'Several motors changed in the same direction. Check battery state, payload, floor surface, and robot-wide drag before replacing one motor.';
        }
        else {
            fleetContext = 'This motor is moving broadly with the robot-wide response pattern; no strong local outlier is visible.';
        }
    }
    const overallSeverity = report.healthScore === null ? 'insufficient'
        : report.healthScore < 60 ? 'warning'
            : report.healthScore < 82 ? 'watch'
                : 'healthy';
    const priority = report.diagnoses
        .filter((d) => d.severity === 'warning' || d.severity === 'watch')
        .slice(0, 3);
    reportEl.innerHTML = `
    <div class="rh-wear-score rh-wear--${overallSeverity}">
      <span class="rh-wear-score__label">Motor evidence score</span>
      <strong>${report.healthScore === null ? 'Not enough data' : `${report.healthScore} / 100`}</strong>
      <span>${escapeHtml(humanizeDeviceName(motor))}</span>
    </div>
    <div class="rh-wear-evidence">
      <div><span>Confidence</span><strong class="rh-confidence rh-confidence--${report.confidence}">${escapeHtml(report.confidence)}</strong></div>
      <div><span>Matched bands</span><strong>${report.matchedBins}</strong></div>
      <div><span>Matched samples</span><strong>${report.matchedSamples}</strong></div>
      <div><span>Response change</span><strong>${formatWearPct(report.responseChangePct)}</strong></div>
      <div><span>Current change</span><strong>${formatWearPct(report.currentChangePct)}</strong></div>
      <div><span>Battery difference</span><strong>${report.batteryDeltaV === null ? 'Unavailable' : `${report.batteryDeltaV >= 0 ? '+' : ''}${report.batteryDeltaV.toFixed(2)} V`}</strong></div>
    </div>
    <p class="rh-confidence-reason">${escapeHtml(report.confidenceReason)}</p>
    ${report.modeMismatch ? '<p class="rh-evidence-alert">Motor modes differ. Treat performance conclusions as provisional until both tests use the same mode.</p>' : ''}
    <div class="rh-priority-findings">
      <h3>${priority.length > 0 ? 'Priority findings' : 'No material degradation detected'}</h3>
      ${priority.length > 0
        ? priority.map((d) => diagnosisHtml(d)).join('')
        : '<p>Matched-command response is currently stable. Continue periodic tests under the same conditions to make future drift easier to detect.</p>'}
    </div>
    <div class="rh-fleet-context">
      <h3>Robot-wide context</h3>
      <p>${escapeHtml(fleetContext)}</p>
      <div class="rh-fleet-ranking">${fleetReports.map((item) => `<button type="button" data-wear-motor="${escapeHtml(item.motor)}" class="${item.motor === motor ? 'active' : ''}"><span>${escapeHtml(humanizeDeviceName(item.motor))}</span><strong>${item.healthScore === null ? 'No score' : item.healthScore}</strong><small>${escapeHtml(item.confidence)} confidence</small></button>`).join('')}</div>
    </div>`;
    reportEl.querySelectorAll('button[data-wear-motor]').forEach((button) => {
        button.addEventListener('click', () => {
            const selector = root.querySelector('#rh-graph-motor');
            if (!selector || !button.dataset.wearMotor)
                return;
            selector.value = button.dataset.wearMotor;
            renderWearAnalysis(root);
        });
    });
    drawComparisonOverlay(root.querySelector('#rh-compare-power'), buildTimeOverlay(reference, motor, 'power'), buildTimeOverlay(comparison, motor, 'power'), { xLabel: 'normalized run time (%)', yLabel: 'commanded power', xMin: 0, xMax: 100, yMin: -1, yMax: 1 });
    drawComparisonOverlay(root.querySelector('#rh-compare-velocity'), buildTimeOverlay(reference, motor, 'velocity'), buildTimeOverlay(comparison, motor, 'velocity'), { xLabel: 'normalized run time (%)', yLabel: 'velocity (ticks/s)', xMin: 0, xMax: 100 });
    drawComparisonOverlay(root.querySelector('#rh-compare-current'), buildTimeOverlay(reference, motor, 'current'), buildTimeOverlay(comparison, motor, 'current'), { xLabel: 'normalized run time (%)', yLabel: 'current (amps)', xMin: 0, xMax: 100, yMin: 0 });
    drawComparisonOverlay(root.querySelector('#rh-compare-response'), report.referenceBins.map((b) => ({ x: b.power, y: b.medianVelocity })), report.comparisonBins.map((b) => ({ x: b.power, y: b.medianVelocity })), { xLabel: 'absolute commanded power', yLabel: 'median velocity (ticks/s)', xMin: 0.1, xMax: 1, yMin: 0, showMarkers: true });
    for (const graph of ['power', 'velocity', 'current', 'response']) {
        const el = root.querySelector(`#rh-diagnosis-${graph}`);
        const item = report.diagnoses.find((d) => d.graph === graph);
        if (el)
            el.innerHTML = item ? diagnosisHtml(item) : '';
    }
}
function diagnosisHtml(item) {
    return `<article class="rh-diagnosis rh-wear--${item.severity}">
    <div class="rh-diagnosis__head"><span>${escapeHtml(item.severity)}</span><strong>${escapeHtml(item.title)}</strong></div>
    <p>${escapeHtml(item.finding)}</p>
    <p><strong>What it might mean:</strong> ${escapeHtml(item.meaning)}</p>
    <p><strong>Inspect next:</strong> ${escapeHtml(item.inspection)}</p>
  </article>`;
}
function formatWearPct(value) {
    return value === null ? 'Unavailable' : `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`;
}
function clearComparisonCanvases(root, message) {
    for (const id of ['power', 'velocity', 'current', 'response']) {
        drawComparisonOverlay(root.querySelector(`#rh-compare-${id}`), [], [], {
            xLabel: '', yLabel: '', emptyMessage: message,
        });
        const diagnosis = root.querySelector(`#rh-diagnosis-${id}`);
        if (diagnosis)
            diagnosis.innerHTML = '';
    }
}
function drawComparisonOverlay(canvas, reference, comparison, options) {
    if (!canvas)
        return;
    const ctx = canvas.getContext('2d');
    if (!ctx)
        return;
    const width = canvas.width;
    const height = canvas.height;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#0a1118';
    ctx.fillRect(0, 0, width, height);
    const plot = { left: 92, top: 48, right: width - 28, bottom: height - 64 };
    const all = reference.concat(comparison).filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
    if (all.length === 0) {
        ctx.fillStyle = '#93a4b8';
        ctx.font = '18px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(options.emptyMessage ?? 'No samples available for this graph', width / 2, height / 2);
        return;
    }
    let xMin = options.xMin ?? Math.min(...all.map((p) => p.x));
    let xMax = options.xMax ?? Math.max(...all.map((p) => p.x));
    let yMin = options.yMin ?? Math.min(...all.map((p) => p.y));
    let yMax = options.yMax ?? Math.max(...all.map((p) => p.y));
    if (xMin === xMax) {
        xMin -= 1;
        xMax += 1;
    }
    if (yMin === yMax) {
        yMin -= 1;
        yMax += 1;
    }
    if (options.yMin === undefined || options.yMax === undefined) {
        const pad = Math.max((yMax - yMin) * 0.1, Math.abs(yMax) * 0.03, 0.1);
        if (options.yMin === undefined)
            yMin -= pad;
        if (options.yMax === undefined)
            yMax += pad;
    }
    const xOf = (x) => plot.left + ((x - xMin) / (xMax - xMin)) * (plot.right - plot.left);
    const yOf = (y) => plot.bottom - ((y - yMin) / (yMax - yMin)) * (plot.bottom - plot.top);
    ctx.font = '14px sans-serif';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 5; i += 1) {
        const f = i / 5;
        const x = plot.left + f * (plot.right - plot.left);
        const y = plot.top + f * (plot.bottom - plot.top);
        ctx.strokeStyle = 'rgba(147,164,184,.16)';
        ctx.beginPath();
        ctx.moveTo(x, plot.top);
        ctx.lineTo(x, plot.bottom);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(plot.left, y);
        ctx.lineTo(plot.right, y);
        ctx.stroke();
        ctx.fillStyle = '#93a4b8';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillText(formatGraphTick(xMin + f * (xMax - xMin)), x, plot.bottom + 10);
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        ctx.fillText(formatGraphTick(yMax - f * (yMax - yMin)), plot.left - 12, y);
    }
    ctx.fillStyle = '#b8c6d6';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(options.xLabel, (plot.left + plot.right) / 2, height - 8);
    ctx.save();
    ctx.translate(18, (plot.top + plot.bottom) / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText(options.yLabel, 0, 0);
    ctx.restore();
    const renderLine = (points, color, dashed) => {
        if (points.length === 0)
            return;
        const step = Math.max(1, Math.ceil(points.length / 1200));
        const visible = points.filter((_, index) => index % step === 0 || index === points.length - 1);
        ctx.strokeStyle = color;
        ctx.lineWidth = 3;
        ctx.setLineDash(dashed ? [10, 7] : []);
        ctx.beginPath();
        visible.forEach((point, index) => {
            const x = xOf(point.x), y = yOf(point.y);
            if (index === 0)
                ctx.moveTo(x, y);
            else
                ctx.lineTo(x, y);
        });
        ctx.stroke();
        ctx.setLineDash([]);
        if (options.showMarkers) {
            ctx.fillStyle = color;
            for (const point of visible) {
                ctx.beginPath();
                ctx.arc(xOf(point.x), yOf(point.y), 5, 0, Math.PI * 2);
                ctx.fill();
            }
        }
    };
    renderLine(reference, '#5eead4', false);
    renderLine(comparison, '#fb923c', true);
    ctx.font = 'bold 14px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#5eead4';
    ctx.fillRect(plot.left, 18, 28, 4);
    ctx.fillText('Reference', plot.left + 38, 20);
    ctx.fillStyle = '#fb923c';
    ctx.fillRect(plot.left + 150, 18, 28, 4);
    ctx.fillText('Comparison', plot.left + 188, 20);
}
/* =========================================================== Replay */
function attachReplayRun(root, runId) {
    if (!runId)
        return;
    const ctx = getCtx(root);
    const run = ctx.runs.get(runId);
    if (!run)
        return;
    ctx.selectedReplayRunId = runId;
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
    const requestedRunId = ctx.selectedReplayRunId || sel.value;
    sel.innerHTML = '';
    for (const r of ctx.runs.values()) {
        const opt = document.createElement('option');
        opt.value = r.runId;
        opt.textContent = `${r.runStartedAt} – ${r.opmodeName} – ${shortRunId(r.runId)}`;
        sel.appendChild(opt);
    }
    if (requestedRunId && ctx.runs.has(requestedRunId))
        sel.value = requestedRunId;
    const selectedRunId = sel.value;
    if (selectedRunId && selectedRunId !== ctx.selectedReplayRunId) {
        const run = ctx.runs.get(selectedRunId);
        if (run) {
            const byChannelSamples = new Map();
            if (run.channels) {
                for (const [name, list] of Object.entries(run.channels.byChannel)) {
                    byChannelSamples.set(name, list.slice());
                }
            }
            const endMs = runDurationMs(run.samples, run.durationMs ?? null);
            ctx.replayByRun.set(selectedRunId, { run, byChannelSamples, endMs });
            ctx.selectedReplayRunId = selectedRunId;
            globalReplayClock.loadRun(0, endMs);
        }
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
    ctx.replayConsumerDispose?.();
    ctx.replayConsumerDispose = globalReplayClock.registerConsumer(update);
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
        if (k === 'pose')
            continue;
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
        else if (k === 'event') {
            valueStr = list.length === 0 ? '—' : `${list.length} events`;
        }
        rows.push({ name, kind: k, value: valueStr });
    }
    table.innerHTML = `<thead><tr><th>Channel</th><th>Kind</th>
    <th>${metricHelpMarkup('Value at replay time')}<br><small>t = ${t | 0} ms</small></th></tr></thead><tbody></tbody>`;
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
    const previousRunId = sel.value;
    sel.innerHTML = '';
    for (const r of ctx.runs.values()) {
        const opt = document.createElement('option');
        opt.value = r.runId;
        opt.textContent = `${r.runStartedAt} – ${r.opmodeName} – ${shortRunId(r.runId)}`;
        sel.appendChild(opt);
    }
    if (previousRunId && ctx.runs.has(previousRunId))
        sel.value = previousRunId;
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
        if (chs[0]?.kind === 'pose')
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
        appendHelpDot(td1, helpKeyForLabel(k));
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
function median(v) {
    if (v.length === 0)
        return NaN;
    const s = [...v].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
/* =========================================================== Trend */
function renderTrendSection(root) {
    const ctx = getCtx(root);
    const opmodeSel = root.querySelector('#rh-trend-opmode');
    const motorSel = root.querySelector('#rh-trend-motor');
    const seriesSel = root.querySelector('#rh-trend-series');
    const table = root.querySelector('#rh-trend');
    if (!opmodeSel || !motorSel || !seriesSel || !table)
        return;
    const previousOpmode = opmodeSel.value;
    const previousMotor = motorSel.value;
    const previousSeries = seriesSel.value;
    opmodeSel.innerHTML = '';
    const opmodes = Array.from(new Set(Array.from(ctx.runs.values()).map((run) => run.opmodeName))).sort();
    for (const opmode of opmodes) {
        const option = document.createElement('option');
        option.value = opmode;
        option.textContent = opmode;
        opmodeSel.appendChild(option);
    }
    if (previousOpmode && opmodes.includes(previousOpmode))
        opmodeSel.value = previousOpmode;
    const selectedOpmode = opmodeSel.value;
    const scopedRuns = Array.from(ctx.runs.values())
        .filter((run) => run.opmodeName === selectedOpmode)
        .sort((a, b) => a.runStartedAt.localeCompare(b.runStartedAt));
    motorSel.innerHTML = '';
    const allDevices = new Set();
    for (const r of scopedRuns)
        for (const d of r.deviceNames)
            allDevices.add(d);
    for (const d of Array.from(allDevices).sort((a, b) => humanizeDeviceName(a).localeCompare(humanizeDeviceName(b), undefined, { sensitivity: 'base' }))) {
        const opt = document.createElement('option');
        opt.value = d;
        opt.textContent = humanizeDeviceName(d);
        opt.title = d;
        motorSel.appendChild(opt);
    }
    if (previousMotor && allDevices.has(previousMotor))
        motorSel.value = previousMotor;
    // Build a Custom channels optgroup if any run defines numeric channels.
    // The optgroup is appended AFTER the canonical core-metric options.
    seriesSel.innerHTML = '';
    const CORE_OPTIONS = [
        ['wearHealth', 'Motor evidence score'],
        ['responseVsFirst', 'Response change vs first run (%)'],
        ['currentVsFirst', 'Current change vs first run (%)'],
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
    for (const r of scopedRuns) {
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
    if (previousSeries && Array.from(seriesSel.options).some((option) => option.value === previousSeries)) {
        seriesSel.value = previousSeries;
    }
    motorSel.disabled = seriesSel.value.startsWith('custom:');
    const baselineId = getBaselineId();
    const motor = motorSel.value;
    const seriesKey = seriesSel.value;
    const selectedSeriesLabel = seriesSel.selectedOptions[0]?.textContent ?? 'Selected metric';
    const trendHelpKey = helpKeyForTrend(seriesKey, selectedSeriesLabel);
    const trendTitle = root.querySelector('#rh-trend-chart-title');
    const trendAxis = root.querySelector('#rh-trend-axis-label');
    const trendHelp = root.querySelector('#rh-trend-metric-help');
    if (trendTitle)
        trendTitle.textContent = `${selectedSeriesLabel} over time`;
    if (trendAxis)
        trendAxis.textContent = `Horizontal axis: run date · Vertical axis: ${selectedSeriesLabel}`;
    if (trendHelp)
        trendHelp.textContent = seriesKey.startsWith('custom:')
            ? 'This is a team-defined numeric channel. Interpret it using the unit and description registered by the OpMode.'
            : getMetricHelp(trendHelpKey);
    const trendCanvas = root.querySelector('#rh-trend-canvas');
    if (trendCanvas)
        trendCanvas.setAttribute('aria-label', `${selectedSeriesLabel} across repeated ${selectedOpmode || 'OpMode'} runs`);
    const runs = scopedRuns;
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
    const canvas = trendCanvas;
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
    const diagnosisEl = root.querySelector('#rh-trend-diagnosis');
    if (diagnosisEl) {
        const eligible = runs.filter((run) => run.deviceNames.includes(motor));
        if (eligible.length < 2) {
            diagnosisEl.innerHTML = '<p class="rh-empty">Load at least two recordings from this OpMode to calculate long-term drift.</p>';
        }
        else {
            const report = compareMotorWear(eligible[0], eligible[eligible.length - 1], motor, filter);
            const important = report.diagnoses.find((d) => d.severity === 'warning')
                ?? report.diagnoses.find((d) => d.severity === 'watch')
                ?? report.diagnoses.find((d) => d.graph === 'response');
            diagnosisEl.innerHTML = `<div class="rh-history-summary"><strong>${eligible.length} runs tracked</strong><span>First: ${escapeHtml(eligible[0].runStartedAt)}</span><span>Latest: ${escapeHtml(eligible[eligible.length - 1].runStartedAt)}</span><span>Confidence: ${escapeHtml(report.confidence)}</span></div>${important ? diagnosisHtml(important) : ''}`;
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
        case 'wearHealth': {
            const history = buildWearHistory(runs, motor, filter);
            return history.map((point) => {
                const run = runById.get(point.runId);
                return { runId: point.runId, runStartedAt: point.runStartedAt,
                    opmodeName: run?.opmodeName ?? '', buildIdentifier: run?.buildIdentifier ?? '',
                    value: point.healthScore, baselineDelta: null, previousDelta: null,
                    insufficient: point.healthScore === null || point.confidence === 'low' };
            });
        }
        case 'responseVsFirst':
        case 'currentVsFirst': {
            const history = buildWearHistory(runs, motor, filter);
            return history.map((point) => {
                const run = runById.get(point.runId);
                const value = key === 'responseVsFirst' ? point.responseChangePct : point.currentChangePct;
                return { runId: point.runId, runStartedAt: point.runStartedAt,
                    opmodeName: run?.opmodeName ?? '', buildIdentifier: run?.buildIdentifier ?? '',
                    value, baselineDelta: null, previousDelta: null,
                    insufficient: value === null || point.confidence === 'low' };
            });
        }
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
async function apiDownloadRun(root, runId, imported = false) {
    try {
        const ctx = getCtx(root);
        const run = ctx.runs.get(runId) ?? null;
        if (imported || !ctx.connectedHub) {
            if (run) {
                downloadLocalRun(run);
                return;
            }
            throw new Error('No local run data available for this browser download.');
        }
        await downloadConnectedRun(runId, run);
    }
    catch (e) {
        alert(`Failed to download ${runId}: ${e.message}`);
    }
}
function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0)
        return '—';
    if (bytes < 1024)
        return `${bytes} B`;
    if (bytes < 1024 * 1024)
        return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
async function apiSetBaseline(root, runId, imported) {
    try {
        const ctx = getCtx(root);
        if (!imported && ctx.connectedHub) {
            const hubRunId = ctx.hubRunIdByRunId.get(runId) ?? runId;
            const resp = await fetch(`${API_BASE}/baseline`, {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ run_id: hubRunId }),
            });
            if (!resp.ok)
                throw new Error(`HTTP ${resp.status}`);
        }
        setBaselineId(runId);
        updateStateAndRender(root);
    }
    catch (e) {
        alert(`Could not set baseline: ${e.message}`);
    }
}
async function apiDeleteRun(root, runId, imported = false) {
    try {
        const ctx = getCtx(root);
        if (imported || !ctx.connectedHub) {
            deleteLocalRun(root, runId);
            return;
        }
        const hubRunId = ctx.hubRunIdByRunId.get(runId) ?? runId;
        const resp = await fetch(runApiUrl(hubRunId, 'delete'), { method: 'POST', credentials: 'include' });
        if (!resp.ok)
            throw new Error(`HTTP ${resp.status}`);
        deleteLocalRun(root, runId);
    }
    catch (e) {
        alert(`Delete failed: ${e.message}`);
    }
}
async function downloadConnectedRun(runId, run) {
    const root = document.getElementById('app');
    const ctx = root ? getCtx(root) : null;
    const hubRunId = ctx?.hubRunIdByRunId.get(runId)
        ?? (runId.startsWith('hub:') ? runId.slice(4) : runId);
    const url = ctx?.hubRuns.get(hubRunId)?.downloadUrl ?? runApiUrl(hubRunId, 'download');
    try {
        const blob = await fetchAsBlob(url);
        const filename = run?.sourceFileName
            ?? (hubRunId ? ctx?.hubRuns.get(hubRunId)?.filename : null)
            ?? `${hubRunId}.csv`;
        triggerDownload(blob, filename);
    }
    catch (e) {
        if (!run)
            throw e;
        downloadLocalRun(run);
        return;
    }
}
async function fetchAsBlob(url) {
    const r = await fetch(url, { credentials: 'include' });
    if (!r.ok)
        throw new Error(`HTTP ${r.status} for ${url}`);
    return await r.blob();
}
function downloadLocalRun(run) {
    const csv = serializeRunCsv(run);
    triggerDownload(new Blob([csv], { type: 'text/csv;charset=utf-8' }), run.sourceFileName || `${run.runId}.csv`);
}
function deleteLocalRun(root, runId) {
    const ctx = getCtx(root);
    const hubRunId = ctx.hubRunIdByRunId.get(runId);
    if (hubRunId) {
        ctx.hubRuns.delete(hubRunId);
        ctx.connectedHubFileIds.delete(hubRunId);
        ctx.hydratingHubRuns.delete(hubRunId);
        ctx.hydrationErrors.delete(hubRunId);
        ctx.hydrationInFlight.delete(hubRunId);
        ctx.hydrationQueue = ctx.hydrationQueue.filter((id) => id !== hubRunId);
    }
    ctx.runs.delete(runId);
    ctx.importedFiles.delete(runId);
    ctx.replayByRun.delete(runId);
    ctx.connectedRunIds.delete(runId);
    ctx.hubRunIdByRunId.delete(runId);
    if (getBaselineId() === runId)
        setBaselineId('');
    updateStateAndRender(root);
}
function escapeCsvCell(value) {
    const text = value == null ? '' : String(value);
    if (!/[",\r\n]/.test(text))
        return text;
    return `"${text.replace(/"/g, '""')}"`;
}
function serializeRunCsv(run) {
    const lines = [];
    lines.push([
        'schema_version', 'run_id', 'opmode_name', 'run_started_at',
        'timestamp_ms', 'device_name', 'commanded_power',
        'encoder_position_ticks', 'encoder_velocity_ticks_per_second',
        'current_amps', 'motor_mode', 'battery_voltage',
    ].join(','));
    for (const s of run.samples) {
        lines.push([
            1,
            s.runId,
            s.opmodeName,
            s.runStartedAt,
            s.timestampMs,
            s.deviceName,
            s.commandedPower,
            s.encoderPositionTicks,
            s.encoderVelocity,
            s.currentAmps,
            s.motorMode,
            s.batteryVoltage,
        ].map(escapeCsvCell).join(','));
    }
    if (run.truncated) {
        const t = run.samples.length > 0 ? run.samples[run.samples.length - 1].timestampMs + 1 : 0;
        lines.push([
            1,
            run.runId,
            run.opmodeName,
            run.runStartedAt,
            t,
            '__RUN_HEALTH_TRUNCATED__',
            `TRUNCATED=${run.samples.length}`,
            '',
            '',
            '',
            '',
            '',
        ].map(escapeCsvCell).join(','));
    }
    return lines.join('\n') + '\n';
}
/* Stage 10 sequential-per-file download is wired via Saved Runs UI:
 * the per-run Download button now saves the CSV to the browser's download location. */
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
    const bundles = new Map();
    for (let i = 0; i < files.length; i++) {
        const f = files.item(i);
        if (!f)
            continue;
        const text = await f.text();
        const kind = classifyImportFile(f.name);
        if (!kind) {
            appendImportList(root, { name: f.name, size: f.size }, false, 'unsupported file type');
            continue;
        }
        const stem = importStem(f.name, kind);
        const bundle = bundles.get(stem) ?? {
            displayName: f.name,
            sizeBytes: 0,
            motorCsv: null,
            channelsCsv: null,
            manifestJson: null,
            sourceFileNames: {},
        };
        bundle.displayName = bundle.displayName || f.name;
        bundle.sizeBytes += f.size;
        if (kind === 'motor') {
            bundle.motorCsv = text;
            bundle.sourceFileNames.motor = f.name;
        }
        else if (kind === 'channels') {
            bundle.channelsCsv = text;
            bundle.sourceFileNames.channels = f.name;
        }
        else if (kind === 'manifest') {
            bundle.manifestJson = text;
            bundle.sourceFileNames.manifest = f.name;
        }
        bundles.set(stem, bundle);
    }
    for (const bundle of bundles.values()) {
        const parsed = parseUnifiedRun({
            motorCsv: bundle.motorCsv,
            channelsCsv: bundle.channelsCsv,
            manifestJson: bundle.manifestJson,
            sourceFileNames: bundle.sourceFileNames,
        });
        if (parsed.kind === 'ok') {
            const existing = ctx.runs.get(parsed.run.runId);
            if (!existing) {
                ctx.runs.set(parsed.run.runId, parsed.run);
                ctx.importedFiles.set(parsed.run.runId, {
                    name: bundle.displayName,
                    size: bundle.sizeBytes,
                    at: Date.now(),
                });
                appendImportList(root, { name: bundle.displayName, size: bundle.sizeBytes }, true, '');
            }
            else {
                appendImportList(root, { name: bundle.displayName, size: bundle.sizeBytes }, true, `run ${shortRunId(parsed.run.runId)} was already available`);
            }
        }
        else {
            // Surface a parse failure on the import list.
            appendImportList(root, { name: bundle.displayName, size: bundle.sizeBytes }, false, `${parsed.reason}${parsed.detail ? `: ${parsed.detail}` : ''}`);
        }
    }
    updateStateAndRender(root);
    renderImportSummary(root);
}
function classifyImportFile(name) {
    const lower = name.toLowerCase();
    if (lower.endsWith('.channels.csv'))
        return 'channels';
    if (lower.endsWith('.manifest.json'))
        return 'manifest';
    if (lower.endsWith('.csv'))
        return 'motor';
    return null;
}
function importStem(name, kind) {
    if (kind === 'channels')
        return name.slice(0, -'.channels.csv'.length);
    if (kind === 'manifest')
        return name.slice(0, -'.manifest.json'.length);
    return name.endsWith('.csv') ? name.slice(0, -4) : name;
}
function appendImportList(root, f, ok, err) {
    const list = root.querySelector('#rh-import-list');
    if (!list)
        return;
    const li = document.createElement('li');
    li.textContent = `${f.name} (${(f.size / 1024).toFixed(1)} KB) — ${ok ? (err || 'imported and ready in all tools') : `rejected (${err})`}`;
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
            ? `Open latest imported run (${shortRunId(summary.openRunId)})`
            : 'Open latest imported run';
    }
}
async function discoverControlHubApi() {
    if (typeof fetch === 'undefined')
        return false;
    try {
        const r = await fetch(`${API_BASE}/recording`, { credentials: 'include' });
        return r.ok;
    }
    catch (e) {
        return false;
    }
}
async function refreshConnectedRuns(root, _hydrateRuns = false) {
    const status = root.querySelector('#rh-saved-status');
    try {
        const resp = await fetch(`${API_BASE}/runs`, { credentials: 'include' });
        if (!resp.ok)
            throw new Error('HTTP ' + resp.status);
        const data = await resp.json();
        const ctx = getCtx(root);
        const hubRuns = new Map();
        for (const r of data.runs ?? []) {
            const hubRunId = typeof r?.run_id === 'string' ? r.run_id : '';
            if (!hubRunId)
                continue;
            hubRuns.set(hubRunId, {
                hubRunId,
                filename: typeof r?.filename === 'string' ? r.filename : `${hubRunId}.csv`,
                sizeBytes: Number(r?.size_bytes) || 0,
                lastModifiedMs: Number(r?.last_modified_ms) || 0,
                truncated: r?.truncated === true,
                schemaVersion: typeof r?.schema_version === 'string' ? r.schema_version : '1',
                downloadUrl: typeof r?.url_download === 'string'
                    ? r.url_download
                    : runApiUrl(hubRunId, 'download'),
                channelsUrl: typeof r?.url_channels === 'string' ? r.url_channels : null,
                manifestUrl: typeof r?.url_manifest === 'string' ? r.url_manifest : null,
            });
        }
        ctx.connectedHub = true;
        ctx.hubRuns = hubRuns;
        ctx.connectedHubFileIds = new Set(hubRuns.keys());
        for (const hubRunId of hubRuns.keys()) {
            ctx.hubRunIdByRunId.set(`hub:${hubRunId}`, hubRunId);
        }
        renderSavedSection(root);
        queueAllHubRunsForHydration(root);
        setAutoSaveStatus(root, recordingModeStatus(autoSaveState.lastRecordingMode, true));
    }
    catch (e) {
        const ctx = getCtx(root);
        ctx.connectedHub = false;
        status.textContent = `Control Hub API unavailable. Showing standalone (drag-and-drop) mode. Reason: ${e.message}`;
        setAutoSaveStatus(root, recordingModeStatus('OFF', false));
    }
}
function hubRunIsLoaded(ctx, hubRunId) {
    for (const [runId, mappedHubId] of ctx.hubRunIdByRunId) {
        if (runId !== `hub:${hubRunId}` && mappedHubId === hubRunId && ctx.runs.has(runId))
            return true;
    }
    return false;
}
function queueAllHubRunsForHydration(root) {
    const ctx = getCtx(root);
    const newestFirst = Array.from(ctx.hubRuns.values())
        .sort((a, b) => b.lastModifiedMs - a.lastModifiedMs);
    for (const meta of newestFirst)
        queueHubRunForHydration(root, `hub:${meta.hubRunId}`, false, false);
    renderSavedSection(root);
    pumpHydrationQueue(root);
}
function queueHubRunForHydration(root, runId, priority = false, startWorker = true) {
    const ctx = getCtx(root);
    const hubRunId = ctx.hubRunIdByRunId.get(runId)
        ?? (runId.startsWith('hub:') ? runId.slice(4) : runId);
    if (!ctx.hubRuns.has(hubRunId) || hubRunIsLoaded(ctx, hubRunId) || ctx.hydrationInFlight.has(hubRunId))
        return;
    const existingIndex = ctx.hydrationQueue.indexOf(hubRunId);
    if (existingIndex >= 0)
        ctx.hydrationQueue.splice(existingIndex, 1);
    if (priority) {
        ctx.hydrationErrors.delete(hubRunId);
        ctx.hydrationQueue.unshift(hubRunId);
    }
    else if (!ctx.hydrationErrors.has(hubRunId)) {
        ctx.hydrationQueue.push(hubRunId);
    }
    renderSavedSection(root);
    if (startWorker)
        pumpHydrationQueue(root);
}
function pumpHydrationQueue(root) {
    const ctx = getCtx(root);
    while (ctx.hydrationWorkers < MAX_HYDRATION_WORKERS && ctx.hydrationQueue.length > 0) {
        const hubRunId = ctx.hydrationQueue.shift();
        if (hubRunIsLoaded(ctx, hubRunId) || !ctx.hubRuns.has(hubRunId))
            continue;
        ctx.hydrationWorkers += 1;
        void hydrateConnectedRun(root, `hub:${hubRunId}`, false).finally(() => {
            const current = getCtx(root);
            current.hydrationWorkers = Math.max(0, current.hydrationWorkers - 1);
            renderSavedSection(root);
            pumpHydrationQueue(root);
        });
    }
}
async function hydrateConnectedRun(root, runId, openWhenReady = false) {
    const ctx = getCtx(root);
    const hubRunId = ctx.hubRunIdByRunId.get(runId)
        ?? (runId.startsWith('hub:') ? runId.slice(4) : runId);
    const existingId = Array.from(ctx.hubRunIdByRunId.entries())
        .find(([parsedId, hubId]) => parsedId !== `hub:${hubRunId}` && hubId === hubRunId)?.[0];
    const existing = existingId ? ctx.runs.get(existingId) ?? null : null;
    if (existing) {
        if (openWhenReady) {
            sectionSwitch(root, 'replay');
            attachReplayRun(root, existing.runId);
        }
        return existing;
    }
    const inFlight = ctx.hydrationInFlight.get(hubRunId);
    if (inFlight)
        return inFlight;
    const meta = ctx.hubRuns.get(hubRunId);
    if (!meta)
        return null;
    const task = (async () => {
        ctx.hydratingHubRuns.add(hubRunId);
        ctx.hydrationErrors.delete(hubRunId);
        renderSavedSection(root);
        try {
            const csvText = await fetchRunCsv(meta);
            const companionText = Promise.all([
                meta.channelsUrl ? fetchTextIfAvailable(meta.channelsUrl).catch(() => null) : Promise.resolve(null),
                meta.manifestUrl ? fetchTextIfAvailable(meta.manifestUrl).catch(() => null) : Promise.resolve(null),
            ]);
            const parsed = parseUnifiedRun({
                motorCsv: csvText,
                sourceFileNames: {
                    motor: meta.filename,
                },
            });
            if (parsed.kind !== 'ok') {
                throw new Error(`${parsed.reason}${parsed.detail ? `: ${parsed.detail}` : ''}`);
            }
            ctx.runs.set(parsed.run.runId, parsed.run);
            ctx.connectedRunIds.add(parsed.run.runId);
            ctx.hubRunIdByRunId.set(parsed.run.runId, hubRunId);
            void companionText.then(([channelsText, manifestText]) => {
                if (!channelsText && !manifestText)
                    return;
                const enrichedRun = { ...parsed.run };
                if (channelsText) {
                    const channels = parseChannelsCsv(channelsText);
                    if (channels.kind === 'ok')
                        enrichedRun.channels = channels.channels;
                }
                if (manifestText) {
                    const manifest = parseManifestJson(manifestText);
                    if (manifest.kind === 'ok' && manifest.manifest.runId === parsed.run.runId) {
                        enrichedRun.manifest = manifest.manifest;
                        enrichedRun.schemaVersion = manifest.manifest.schemaVersion || enrichedRun.schemaVersion;
                        enrichedRun.buildIdentifier = manifest.manifest.buildIdentifier;
                        enrichedRun.durationMs = manifest.manifest.durationMs;
                        enrichedRun.configFingerprint = manifest.manifest.configFingerprint;
                        enrichedRun.truncated = enrichedRun.truncated || manifest.manifest.truncated;
                        enrichedRun.deviceNames = Array.from(new Set([
                            ...enrichedRun.deviceNames,
                            ...manifest.manifest.deviceNames,
                        ])).sort();
                    }
                }
                const current = getCtx(root);
                current.runs.set(enrichedRun.runId, enrichedRun);
                current.connectedRunIds.add(enrichedRun.runId);
                current.hubRunIdByRunId.set(enrichedRun.runId, hubRunId);
                updateStateAndRender(root);
            });
            if (openWhenReady) {
                sectionSwitch(root, 'replay');
                attachReplayRun(root, parsed.run.runId);
            }
            else {
                updateStateAndRender(root);
            }
            return parsed.run;
        }
        catch (e) {
            ctx.hydrationErrors.set(hubRunId, e.message);
            return null;
        }
        finally {
            ctx.hydratingHubRuns.delete(hubRunId);
            ctx.hydrationInFlight.delete(hubRunId);
            renderSavedSection(root);
        }
    })();
    ctx.hydrationInFlight.set(hubRunId, task);
    return task;
}
async function fetchRunCsv(meta) {
    const urls = Array.from(new Set([runApiUrl(meta.hubRunId), meta.downloadUrl]));
    let lastError = 'Recording could not be read.';
    for (let attempt = 1; attempt <= RUN_FETCH_ATTEMPTS; attempt++) {
        for (const url of urls) {
            try {
                const response = await fetchWithTimeout(url, RUN_FETCH_TIMEOUT_MS);
                if (!response.ok) {
                    const detail = (await response.text()).replace(/\s+/g, ' ').slice(0, 180);
                    throw new Error(`HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
                }
                const text = await response.text();
                if (!text.trim())
                    throw new Error('Control Hub returned an empty recording.');
                return text;
            }
            catch (error) {
                lastError = error.name === 'AbortError'
                    ? `Control Hub read timed out after ${RUN_FETCH_TIMEOUT_MS / 1000}s`
                    : error.message;
            }
        }
        if (attempt < RUN_FETCH_ATTEMPTS) {
            await new Promise((resolve) => setTimeout(resolve, 350 * attempt));
        }
    }
    throw new Error(`${lastError}. Download still works; press Retry analysis after confirming the Hub Wi-Fi connection.`);
}
async function fetchWithTimeout(url, timeoutMs) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { credentials: 'include', signal: controller.signal });
    }
    finally {
        clearTimeout(timeout);
    }
}
async function fetchTextIfAvailable(url) {
    const r = await fetchWithTimeout(url, RUN_FETCH_TIMEOUT_MS);
    if (r.status === 404)
        return null;
    if (!r.ok)
        throw new Error(`HTTP ${r.status} for ${url}`);
    return await r.text();
}
async function syncCompletedRunsFromHub(root) {
    const ctx = getCtx(root);
    if (!ctx.connectedHub)
        return;
    if (!autoSaveState.pendingNextRun && !autoSaveState.everyMode) {
        setAutoSaveStatus(root, recordingModeStatus(autoSaveState.lastRecordingMode, true));
        return;
    }
    if (autoSaveState.inFlight)
        return;
    if (Date.now() - autoSaveState.lastSyncAtMs < 1000)
        return;
    autoSaveState.inFlight = true;
    autoSaveState.lastSyncAtMs = Date.now();
    try {
        const previousIds = new Set(ctx.connectedHubFileIds);
        const saveNextArmed = autoSaveState.pendingNextRun;
        await refreshConnectedRuns(root, false);
        const freshCtx = getCtx(root);
        const newRuns = Array.from(freshCtx.hubRuns.values())
            .filter((run) => !previousIds.has(run.hubRunId))
            .sort((a, b) => a.lastModifiedMs - b.lastModifiedMs);
        if (newRuns.length === 0) {
            setAutoSaveStatus(root, autoSaveState.pendingNextRun
                ? 'Save Next Run is armed. Waiting for the next completed run.'
                : 'Save Every Run is armed. Waiting for the next completed run.');
            return;
        }
        let savedCount = 0;
        for (const run of newRuns) {
            await downloadConnectedRun(`hub:${run.hubRunId}`, null);
            queueHubRunForHydration(root, `hub:${run.hubRunId}`, true);
            savedCount += 1;
            if (saveNextArmed) {
                rememberAutoSaveIntent('OFF');
                autoSaveState.lastRecordingMode = 'OFF';
                break;
            }
        }
        if (savedCount === 1) {
            setDownloadReadyStatus(root, `Download started: ${newRuns[0].filename}. Check this browser's Downloads list.`, newRuns[0].hubRunId, newRuns[0].filename);
        }
        else {
            setAutoSaveStatus(root, `Saved ${savedCount} new runs to this computer.`);
        }
    }
    catch (e) {
        setAutoSaveStatus(root, `Auto-save could not sync: ${e.message}`);
    }
    finally {
        autoSaveState.inFlight = false;
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
        for (const d of Array.from(devices).sort((a, b) => humanizeDeviceName(a).localeCompare(humanizeDeviceName(b), undefined, { sensitivity: 'base' }))) {
            const opt = document.createElement('option');
            opt.value = d;
            opt.textContent = humanizeDeviceName(d);
            opt.title = d;
            sel.appendChild(opt);
        }
    }
    else {
        for (const r of runs.values()) {
            const opt = document.createElement('option');
            opt.value = r.runId;
            opt.textContent = `${r.runStartedAt} – ${r.opmodeName} – ${shortRunId(r.runId)}`;
            sel.appendChild(opt);
        }
    }
    if (previous && (runs.has(previous) || (devicesOnly && Array.from(sel.options).some((o) => o.value === previous)))) {
        sel.value = previous;
    }
}
const HELP_KEY_ALIASES = {
    'Vel Ref': 'Median velocity',
    'Vel Cmp': 'Median velocity',
    'Δ vel (raw)': 'Raw diff',
    'Δ vel %': 'Percent diff',
    'Eff Ref': 'Velocity efficiency',
    'Eff Cmp': 'Velocity efficiency',
    'Δ eff (raw)': 'Raw diff',
    'Δ eff %': 'Percent diff',
    'Cost Ref': 'Current cost',
    'Cost Cmp': 'Current cost',
    'Δ cost': 'Raw diff',
    'Δ cost %': 'Percent diff',
    'p95 Ref': '95th-percentile current',
    'p95 Cmp': '95th-percentile current',
    'Δ p95': 'Raw diff',
    'Δ p95 %': 'Percent diff',
    'Stall % Ref': 'Possible Stall Percentage',
    'Stall % Cmp': 'Possible Stall Percentage',
    'Δ stall %': 'Percent diff',
    'Samples R/C': 'Samples',
    'Current / Voltage': 'Current',
    'Mode Warn': 'Status',
    'Battery': 'Battery voltage',
    'Update': 'Frequency',
    'Raw difference': 'Raw diff',
    'Percent difference': 'Percent diff',
};
function helpKeyForLabel(label) {
    return HELP_KEY_ALIASES[label] ?? label;
}
function helpKeyForTrend(seriesKey, label) {
    const byKey = {
        wearHealth: 'Motor evidence score',
        responseVsFirst: 'Response change',
        currentVsFirst: 'Current change',
        medianVelocity: 'Median velocity',
        velocityEfficiency: 'Velocity efficiency',
        currentCost: 'Current cost',
        p95Current: '95th-percentile current',
        possibleStallPct: 'Possible Stall Percentage',
        batteryMin: 'Battery minimum',
        batteryMedian: 'Battery median',
        loopTimeMsMedian: 'Loop-time median',
        loopTimeMsP95: 'Loop-time 95th percentile',
    };
    return byKey[seriesKey] ?? helpKeyForLabel(label);
}
function appendHelpDot(parent, key) {
    const help = METRIC_HELP[key];
    if (!help || parent.querySelector('.rh-help-dot'))
        return;
    const dot = document.createElement('span');
    dot.className = 'rh-tooltip rh-help-dot';
    dot.tabIndex = 0;
    dot.textContent = '?';
    dot.dataset.tip = help;
    dot.title = help;
    dot.setAttribute('role', 'note');
    dot.setAttribute('aria-label', `${key}: ${help}`);
    parent.appendChild(dot);
}
function metricHelpMarkup(label) {
    const key = helpKeyForLabel(label);
    const help = METRIC_HELP[key];
    if (!help)
        return escapeHtml(label);
    return `${escapeHtml(label)} <span class="rh-tooltip rh-help-dot" tabindex="0" role="note" aria-label="${escapeHtml(`${key}: ${help}`)}" title="${escapeHtml(help)}" data-tip="${escapeHtml(help)}">?</span>`;
}
function decorateMetricHelp(root) {
    const candidates = root.querySelectorAll('th, figcaption strong, .rh-metric__label, .rh-wear-score__label, .rh-wear-evidence span, .rh-meta-label');
    for (const element of candidates) {
        if (element.querySelector('.rh-help-dot'))
            continue;
        const label = (element.textContent ?? '').trim();
        appendHelpDot(element, helpKeyForLabel(label));
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
function shortRunId(runId) {
    const text = String(runId);
    return text.length <= 10 ? text : text.slice(-8);
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
        root.querySelector('.rh-main')?.appendChild(el);
    }
    liveState.containerEl = el;
    renderLiveDashboard(liveState);
    // Start polling (idempotent).
    if (!liveState.poller.isRunning()) {
        liveState.poller.start((snap) => {
            const wasActive = liveState.lastSnap?.active === true;
            const isActive = snap?.active === true;
            liveState.lastSnapshotAtMs = Date.now();
            liveState.lastSnap = snap;
            liveState.connectionState = isActive ? 'connected' : 'no_session';
            liveState.connectionStateAtMs = Date.now();
            // Pausing freezes painting, not collection, so resuming shows the
            // complete diagnostic window instead of a hole in the graph.
            liveState.store.apply(snap);
            if (!liveState.paused && liveState.containerEl)
                renderLiveDashboard(liveState);
            if ((wasActive && !isActive) || (!isActive
                && (autoSaveState.pendingNextRun || autoSaveState.everyMode))) {
                void syncCompletedRunsFromHub(root);
            }
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
    <div class="rh-live-toolbar">
      <button data-live-action="pause">${s.paused ? 'Resume rendering' : 'Pause rendering'}</button>
      <button data-live-action="clear">Clear visible history</button>
    </div>
  `;
    // Channel cards table (legacy <table> for compatibility with existing CSS).
    const channelNames = s.store.getChannelNames();
    let channelTable = '<table class="rh-live-channels"><thead><tr><th>Channel</th><th>Current value</th><th>Unit</th><th>Group</th></tr></thead><tbody>';
    for (const name of channelNames.slice(0, LIVE_LIMITS.MAX_CHANNEL_SERIES_PER_KIND)) {
        const slice = s.store.getChannel(name);
        if (!slice)
            continue;
        if (slice.kind === 'pose')
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
        channelTable += `<tr><td>${escapeHtml(name)}</td><td>${escapeHtml(current)}</td><td>${escapeHtml(slice.unit ?? '')}</td><td>${escapeHtml(slice.group ?? '')}</td></tr>`;
    }
    channelTable += '</tbody></table>';
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
            const graphDefs = [
                { key: 'power', title: 'Commanded power', unit: 'normalized (-1 to +1)' },
                { key: 'velocity', title: 'Encoder velocity', unit: 'ticks / second' },
                { key: 'current', title: 'Motor current', unit: 'amps' },
            ];
            const graphsHtml = graphDefs.map((g) => `<figure class="rh-card--motor__graph"><figcaption class="rh-card--motor__graph-label"><strong>${escapeHtml(g.title)}</strong><span>${escapeHtml(g.unit)} · rolling 60 seconds</span></figcaption><canvas id="${baseId}-${g.key}" width="960" height="260" data-live-metric="${g.key}" data-motor="${escapeHtml(mc.deviceName)}" role="img" aria-label="${escapeHtml(mc.displayName)} ${escapeHtml(g.title)} live graph"></canvas></figure>`).join('');
            return `<article class="rh-card--motor" data-live-motor="${escapeHtml(mc.deviceName)}" data-live-motor-label="${escapeHtml(mc.displayName)}"><header class="rh-card--motor__head"><div class="rh-card--motor__identity"><span class="rh-card--motor__name">${escapeHtml(mc.displayName)}</span><span class="rh-card--motor__tag">${escapeHtml(mc.deviceName)}</span></div><span class="rh-card--motor__mode">${escapeHtml(mc.mode)}</span></header><div class="rh-card--motor__metrics">${rowsHtml}</div><div class="rh-card--motor__graphs">${graphsHtml}</div></article>`;
        }).join('');
    const conditionsHtml = conditionRows.length === 0
        ? '<p class="rh-empty rh-empty--info">No advisories this window.</p>'
        : `<ul class="rh-conditions-list">${conditionRows.map((cr) => `      <li class="rh-condition ${cr.severityClass}"><div class="rh-condition__head"><span class="rh-status ${cr.severityClass}">${escapeHtml(cr.severity)}</span><span class="rh-condition__target">${escapeHtml(cr.target)}</span><span class="rh-condition__count">×${Number(cr.count) || 1}</span><time class="rh-condition__time">${escapeHtml(formatElapsed(cr.whenMs - (s.lastSnapshotAtMs ?? cr.whenMs)))}</time></div><p class="rh-condition__body">${escapeHtml(cr.body)}</p><p class="rh-condition__inspection">Inspect: ${escapeHtml(cr.inspection)}</p></li>`).join('')}</ul>`;
    el.innerHTML = `
    <h2 class="rh-card__title">Live</h2>
    <p class="rh-card__subtitle">Read-only view of the currently active Run Health session. The browser cannot start or stop an OpMode.</p>
    <details class="rh-section-help"><summary>How to read live motor data</summary><p><strong>Power</strong> is the command from robot code. <strong>Velocity</strong> is measured encoder response in ticks/second. <strong>Current</strong> is electrical effort in amps. A brief spike can be normal during acceleration; repeated high current with reduced velocity is more useful evidence of drag or load.</p></details>
    <div class="rh-card--motor" id="rh-live-conn-card" role="status" aria-live="polite"><div class="rh-card--motor__head"><div class="rh-card--motor__identity"><span class="rh-card--motor__name"><span class="rh-live-dot" data-live-dot></span>${escapeHtml(connText)}</span><span class="rh-card--motor__tag">connection</span></div><span class="rh-card--motor__mode">last update: ${escapeHtml(lastSeenAgo)} · observed ${stats.observedHz.toFixed(1)} Hz</span></div></div>
    <div class="rh-live-strip" id="rh-live-strip">${chipsHtml}</div>
    ${btns}
    <p data-live-rendering-note class="rh-card__subtitle">${s.paused ? 'Rendering paused — polling continues so reconnection state stays accurate. Pending history retained.' : 'Rendering updates every accepted snapshot; bounded 60s window.'}</p>
    <h3 class="rh-card__subtitle">Motors</h3>
    <div class="rh-grid--cards" id="rh-live-cards-grid">${motorCardsHtml}</div>
    <h3 class="rh-card__subtitle">Custom channels</h3>
    ${channelTable}
    <h3 class="rh-card__subtitle">Observed conditions</h3>
    <div class="rh-conditions" id="rh-conditions">${conditionsHtml}</div>
    <h3 class="rh-card__subtitle">Recent events</h3>
    ${evList}
  `;
    decorateMetricHelp(el);
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
                slice.currentHistory;
        drawDiagnosticGraph(canvas, series, metric);
    });
}
function drawDiagnosticGraph(canvas, series, metric) {
    const w = canvas.width, h = canvas.height;
    const ctx = canvas.getContext('2d');
    if (!ctx)
        return;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#0d1117';
    ctx.fillRect(0, 0, w, h);
    const plot = { left: 72, top: 24, right: w - 20, bottom: h - 46 };
    const values = series.filter((p) => p.v != null && Number.isFinite(p.v));
    if (values.length === 0) {
        ctx.fillStyle = '#8b949e';
        ctx.font = '16px sans-serif';
        ctx.fillText('Waiting for live samples', plot.left, h / 2);
        return;
    }
    let lo = Number.POSITIVE_INFINITY, hi = Number.NEGATIVE_INFINITY;
    for (const p of values) {
        if (p.v < lo)
            lo = p.v;
        if (p.v > hi)
            hi = p.v;
    }
    if (metric === 'power') {
        lo = -1;
        hi = 1;
    }
    else {
        const pad = Math.max((hi - lo) * 0.12, Math.abs(hi) * 0.04, 0.1);
        lo -= pad;
        hi += pad;
    }
    if (lo === hi) {
        lo -= 1;
        hi += 1;
    }
    const latestT = values[values.length - 1].t;
    const earliestT = Math.max(values[0].t, latestT - LIVE_LIMITS.MAX_HISTORY_MS);
    const span = Math.max(1000, latestT - earliestT);
    const xOf = (t) => plot.left + ((t - earliestT) / span) * (plot.right - plot.left);
    const yOf = (v) => plot.bottom - ((v - lo) / (hi - lo)) * (plot.bottom - plot.top);
    ctx.font = '13px sans-serif';
    ctx.lineWidth = 1;
    ctx.textBaseline = 'middle';
    for (let i = 0; i <= 4; i += 1) {
        const frac = i / 4;
        const y = plot.top + frac * (plot.bottom - plot.top);
        const value = hi - frac * (hi - lo);
        ctx.strokeStyle = 'rgba(139, 148, 158, 0.18)';
        ctx.beginPath();
        ctx.moveTo(plot.left, y);
        ctx.lineTo(plot.right, y);
        ctx.stroke();
        ctx.fillStyle = '#9da7b3';
        ctx.textAlign = 'right';
        ctx.fillText(formatGraphTick(value), plot.left - 10, y);
    }
    for (let i = 0; i <= 4; i += 1) {
        const frac = i / 4;
        const x = plot.left + frac * (plot.right - plot.left);
        ctx.strokeStyle = 'rgba(139, 148, 158, 0.12)';
        ctx.beginPath();
        ctx.moveTo(x, plot.top);
        ctx.lineTo(x, plot.bottom);
        ctx.stroke();
        const secondsAgo = ((1 - frac) * span) / 1000;
        ctx.fillStyle = '#9da7b3';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillText(secondsAgo < 0.5 ? 'now' : `-${secondsAgo.toFixed(0)}s`, x, plot.bottom + 10);
    }
    ctx.fillStyle = '#9da7b3';
    ctx.textAlign = 'center';
    ctx.fillText('time', (plot.left + plot.right) / 2, h - 10);
    ctx.strokeStyle = metric === 'current' ? '#f2cc60'
        : metric === 'velocity' ? '#58a6ff'
            : '#3fb950';
    ctx.lineWidth = 3;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    let first = true;
    let previousT = null;
    for (const p of values) {
        const x = xOf(p.t);
        const y = yOf(p.v);
        if (previousT != null && p.t - previousT > 500)
            first = true;
        if (first) {
            ctx.moveTo(x, y);
            first = false;
        }
        else
            ctx.lineTo(x, y);
        previousT = p.t;
    }
    ctx.stroke();
    const last = values[values.length - 1];
    ctx.fillStyle = ctx.strokeStyle;
    ctx.beginPath();
    ctx.arc(xOf(last.t), yOf(last.v), 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#e6edf3';
    ctx.font = 'bold 15px sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.fillText(`LIVE ${formatGraphTick(last.v)}`, plot.right, 5);
}
function formatGraphTick(value) {
    const abs = Math.abs(value);
    if (abs >= 10000)
        return value.toExponential(1);
    if (abs >= 100)
        return value.toFixed(0);
    if (abs >= 10)
        return value.toFixed(1);
    return value.toFixed(2);
}
//# sourceMappingURL=main.js.map