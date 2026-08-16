/**
 * Concise, measured-language explanations for technical metrics shown
 * across the dashboard.  Each entry is exactly one short sentence that
 * a student, mentor, or technical reviewer can read in <=5 seconds.
 *
 * Phrasing intentionally avoids confirmed diagnoses; the wording matches
 * the UI's "describe what was observed, not what failed" convention.
 */

export const METRIC_HELP: Record<string, string> = {
  'OpMode': 'The FTC program that was running when this data was recorded.',
  'Run ID': 'A unique suffix used to distinguish this recording from every other run.',
  'Started': 'The date and time when recording began.',
  'Source': 'Where the dashboard obtained the run: the connected Hub or a file imported from this computer.',
  'Size': 'Approximate recording file size on disk.',
  'Motors': 'Number of distinct configured motor names found in this recording.',
  'Channels': 'Number of optional custom telemetry channels saved with this recording.',
  'Samples': 'Number of timestamped measurements available; more comparable samples usually improves confidence.',
  'Build': 'Optional robot-code build identifier saved in the run manifest.',
  'Truncated': 'Yes means the safety sample limit was reached before the run ended.',
  'Baseline': 'The recording chosen as the long-term reference for later trend differences.',
  'Actions': 'Read-only file and analysis operations available for this recording.',
  'Recognized files': 'Files whose CSV or manifest suffix matches a supported Run Health recording format.',
  'Imported runs': 'Valid recordings loaded locally into this browser for analysis.',
  'Warnings': 'Files that could not be recognized or parsed; open the listed reason for correction.',
  'Metric': 'The measured property being compared.',
  'Reference': 'The earlier or known-good run used as the starting point.',
  'Comparison': 'The later run being checked for change.',
  'Raw diff': 'Comparison value minus reference value in the metric’s original unit.',
  'Percent diff': 'Relative change from the reference; the meaning of higher or lower depends on the metric.',
  'Status': 'Advisory classification based on data availability and measured change, not a confirmed component failure.',
  'Presence': 'Whether the same configured motor name exists in both recordings.',
  'Date': 'Recorded start date used to order runs chronologically.',
  'Value': 'Calculated value for the selected trend metric.',
  'Δ baseline': 'Selected value minus the baseline run value.',
  'Δ previous': 'Selected value minus the immediately previous run value.',
  'Kind': 'Custom-channel data type: number, boolean, text, or event.',
  'Channel': 'Named custom telemetry signal published by the OpMode.',
  'Current value': 'Most recent value reported for this custom channel.',
  'Value at replay time': 'Latest custom-channel value at or before the current replay cursor.',
  'Unit': 'Engineering unit supplied by the OpMode for this custom channel.',
  'Group': 'Optional category supplied by the OpMode to organize related custom channels.',
  'Description': 'Plain-language purpose supplied when the custom channel was registered.',
  'Min': 'Lowest valid value observed in the selected run.',
  'Max': 'Highest valid value observed in the selected run.',
  'Final': 'Most recent valid value at the end of the selected run.',
  'Transitions': 'Number of times a boolean or text channel changed value.',
  'Time true': 'Approximate accumulated time that a boolean channel reported true.',
  'First': 'First valid value observed in the run.',
  'Motor evidence score': 'A 0–100 summary of matched-command evidence; it is a screening aid, not a motor grade.',
  'Confidence': 'How strongly the available matched samples support the displayed comparison.',
  'Matched bands': 'Number of commanded-power ranges represented in both runs.',
  'Matched samples': 'Samples compared only where both runs issued similar motor commands.',
  'Response change': 'Change in battery-adjusted motion delivered for comparable commanded power.',
  'Current change': 'Change in electrical current draw under comparable commanded power.',
  'Battery difference': 'Comparison battery median minus reference battery median in volts.',
  'Stable': 'No material change crossed the current advisory thresholds.',
  'Changed': 'A measurable change was found; inspect context before treating it as wear.',
  'Large change': 'A larger measured difference needs inspection, but does not prove a failed component.',
  'Missing': 'The required signal or motor was absent; missing never means zero.',
  'Insufficient': 'Not enough comparable data was available for a reliable conclusion.',
  'Commanded power': 'Motor command sent by the OpMode from -1.0 full reverse to +1.0 full forward.',
  'Encoder velocity': 'Measured motor encoder speed in ticks per second; this is response, not commanded speed.',
  'Motor current': 'Measured electrical current in amps; higher current can reflect load, friction, acceleration, or a problem.',
  'Normalized run time': 'Each run is scaled from 0% start to 100% end so runs of different lengths can overlay.',
  'Absolute commanded power': 'Command magnitude from 0 to 1 with forward and reverse combined.',
  'Recording mode': 'Controls which future Run Health recordings are saved; it does not start or control an OpMode.',
  'Direction': 'Limits comparison samples to forward, reverse, or both command directions.',
  'Power band': 'Limits analysis to low, medium, high, or all active commanded-power ranges.',
  'Motor to diagnose': 'Configured motor whose overlays and diagnostic evidence are displayed.',
  'Update': 'Accepted live snapshots per second reaching this browser.',
  'Connection': 'Whether this browser is currently receiving live snapshots from the Control Hub.',
  'Elapsed': 'Time since the active Run Health session began.',
  'Conditions': 'Advisory patterns observed in the recent live window.',
  'Events': 'Timestamped markers published by the OpMode.',
  'Commanded power over run': 'Overlays the motor command from the earlier and later run across normalized run time.',
  'Motor velocity over run': 'Overlays measured encoder speed so reduced delivered motion is visible.',
  'Motor current over run': 'Overlays measured electrical effort; interpret it alongside velocity and commanded power.',
  'Commanded power to delivered velocity': 'Shows median measured speed at each command magnitude to reveal changing motor responsiveness.',
  'Motor signals at replay time': 'Shows the latest two seconds of recorded motor signals around the replay cursor.',
  'Trend chart': 'Shows one selected metric across chronologically ordered repeated runs.',
  'Median velocity':
    'Median encoder velocity (ticks/s) over the recorded session — robust to short spikes.',
  'Velocity efficiency':
    'Median velocity divided by commanded power — higher means more motion per unit of effort.',
  'Current cost':
    'Milliamps (mAh-style proxy) of current per unit velocity — lower is generally better.',
  '95th-percentile current':
    'Realistic peak current draw, ignoring single-tick spikes.',
  'Possible Stall Percentage':
    'Share of samples where power was commanded but reported velocity remained low.  This is an observation, not a confirmed stall.',
  'Battery minimum':
    'Lowest battery voltage observed during the run.',
  'Battery median':
    'Median battery voltage observed during the run.',
  'Loop-time median':
    'Median OpMode loop duration (a measure of code heaviness).',
  'Loop-time 95th percentile':
    '95th-percentile loop duration — the worst 5% of cycles.',
  'Baseline difference':
    'Metric value minus the chosen baseline run.  Negative means lower than baseline.',
  'Previous-run difference':
    'Metric value minus the chronologically previous run.',
  'Power':
    'Commanded motor output [-1.0, +1.0]; -1.0 is full reverse, +1.0 is full forward.',
  'Velocity':
    'Encoder velocity in ticks per second.',
  'Current':
    'Current draw of the device in amps (A).  Not all hardware reports this.',
  'Loop time':
    'Approximate OpMode loop interval in milliseconds.',
  'Frequency':
    'Snapshot updates per second on the live dashboard.',
  'Battery voltage':
    'Battery voltage at the Control Hub, in volts (V).',
};

export function getMetricHelp(key: string): string {
  return METRIC_HELP[key] ?? 'No additional description available.';
}
