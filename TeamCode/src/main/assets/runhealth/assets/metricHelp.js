/**
 * Concise, measured-language explanations for technical metrics shown
 * across the dashboard.  Each entry is exactly one short sentence that
 * a student, mentor, or technical reviewer can read in <=5 seconds.
 *
 * Phrasing intentionally avoids confirmed diagnoses; the wording matches
 * the UI's "describe what was observed, not what failed" convention.
 */
export const METRIC_HELP = {
    'Median velocity': 'Median encoder velocity (ticks/s) over the recorded session — robust to short spikes.',
    'Velocity efficiency': 'Median velocity divided by commanded power — higher means more motion per unit of effort.',
    'Current cost': 'Milliamps (mAh-style proxy) of current per unit velocity — lower is generally better.',
    '95th-percentile current': 'Realistic peak current draw, ignoring single-tick spikes.',
    'Possible Stall Percentage': 'Share of samples where power was commanded but reported velocity remained low.  This is an observation, not a confirmed stall.',
    'Battery minimum': 'Lowest battery voltage observed during the run.',
    'Battery median': 'Median battery voltage observed during the run.',
    'Loop-time median': 'Median OpMode loop duration (a measure of code heaviness).',
    'Loop-time 95th percentile': '95th-percentile loop duration — the worst 5% of cycles.',
    'Baseline difference': 'Metric value minus the chosen baseline run.  Negative means lower than baseline.',
    'Previous-run difference': 'Metric value minus the chronologically previous run.',
    'Power': 'Commanded motor output [-1.0, +1.0]; -1.0 is full reverse, +1.0 is full forward.',
    'Position': 'Cumulative encoder ticks since the last reset.',
    'Velocity': 'Encoder velocity in ticks per second.',
    'Current': 'Current draw of the device in amps (A).  Not all hardware reports this.',
    'Loop time': 'Approximate OpMode loop interval in milliseconds.',
    'Frequency': 'Snapshot updates per second on the live dashboard.',
    'Battery voltage': 'Battery voltage at the Control Hub, in volts (V).',
    'Heading': 'Robot heading in degrees (0° = +X axis, increasing counter-clockwise).',
};
export function getMetricHelp(key) {
    return METRIC_HELP[key] ?? 'No additional description available.';
}
//# sourceMappingURL=metricHelp.js.map