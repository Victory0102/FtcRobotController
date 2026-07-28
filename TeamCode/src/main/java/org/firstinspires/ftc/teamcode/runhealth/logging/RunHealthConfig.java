/*
 * Copyright (c) 2025 FTC Run Health contributors
 *
 * Licensed under the GNU General Public License v3.0 or later.
 * See the top-level LICENSE file for details.
 */
package org.firstinspires.ftc.teamcode.runhealth.logging;

import android.content.Context;
import android.content.SharedPreferences;

import org.firstinspires.ftc.robotcore.internal.system.AppUtil;

/**
 * Persistent settings for Run Health:
 * <ul>
 *     <li>Recording mode: {@code OFF}, {@code NEXT}, or {@code EVERY}.</li>
 *     <li>Persistent baseline run id (mutable from the browser).</li>
 * </ul>
 *
 * <p>Backed by the FTC Robot Controller {@link SharedPreferences}.  Survives:
 * <ul>
 *     <li>Browser refresh.</li>
 *     <li>Robot Controller restart.</li>
 *     <li>Control Hub reboot (preferences are stored in the Android file
 *         system, which is persistent across reboots).</li>
 * </ul>
 *
 * <p>Settings are atomic in the sense that a "NEXT" claim is consumed
 * exactly once at the first successful {@code capture()} call.  If the
 * OpMode is initialized and canceled before the first capture, the claim
 * remains armed.
 */
public final class RunHealthConfig {

    public static final String MODE_OFF = "OFF";
    public static final String MODE_NEXT = "NEXT";
    public static final String MODE_EVERY = "EVERY";

    public static final String DEFAULT_MODE = MODE_OFF;

    private static final String PREF_NAME = "runhealth_settings";
    private static final String KEY_RECORDING_MODE = "recording_mode";
    private static final String KEY_BASELINE_RUN_ID = "baseline_run_id";

    private RunHealthConfig() { /* utility */ }

    private static SharedPreferences prefs() {
        Context ctx = AppUtil.getDefContext();
        return ctx.getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE);
    }

    /**
     * Returns the current recording mode.  Defaults to {@link #MODE_OFF}.
     * Unknown persisted values fall back to {@link #DEFAULT_MODE}.
     */
    public static synchronized String getRecordingMode() {
        String m = prefs().getString(KEY_RECORDING_MODE, DEFAULT_MODE);
        if (!MODE_OFF.equals(m) && !MODE_NEXT.equals(m) && !MODE_EVERY.equals(m)) {
            return DEFAULT_MODE;
        }
        return m;
    }

    /**
     * Sets the recording mode.  Trims to a known value; unknown values
     * become {@link #DEFAULT_MODE}.
     */
    public static synchronized void setRecordingMode(String mode) {
        if (mode == null) mode = DEFAULT_MODE;
        switch (mode) {
            case MODE_OFF:
            case MODE_NEXT:
            case MODE_EVERY:
                break;
            default:
                mode = DEFAULT_MODE;
        }
        synchronized (RunHealthConfig.class) {
            prefs().edit().putString(KEY_RECORDING_MODE, mode).apply();
        }
    }

    /**
     * Atomically transitions from {@code expectedCurrent} to
     * {@code newMode} and returns {@code true} only if the persisted mode
     * matched {@code expectedCurrent} at the moment of read.  Used to make
     * "consume NEXT" idempotent under contention.
     */
    public static synchronized boolean compareAndSetMode(String expectedCurrent, String newMode) {
        if (expectedCurrent == null || newMode == null) return false;
        synchronized (RunHealthConfig.class) {
            if (!expectedCurrent.equals(getRecordingMode())) return false;
            prefs().edit().putString(KEY_RECORDING_MODE, newMode).apply();
            return true;
        }
    }

    /**
     * Returns the persisted baseline run id, or {@code null} if no baseline
     * has been set.
     */
    public static synchronized String getBaselineRunId() {
        String v = prefs().getString(KEY_BASELINE_RUN_ID, null);
        if (v == null || v.isEmpty()) return null;
        return v;
    }

    /**
     * Persists the baseline run id.  A {@code null} or empty value clears
     * the baseline.
     */
    public static synchronized void setBaselineRunId(String runId) {
        synchronized (RunHealthConfig.class) {
            if (runId == null || runId.isEmpty()) {
                prefs().edit().remove(KEY_BASELINE_RUN_ID).apply();
            } else {
                prefs().edit().putString(KEY_BASELINE_RUN_ID, runId).apply();
            }
        }
    }

    /**
     * Returns {@code true} if any of the three stored values differ from
     * {@code defaults} - used by tests.
     */
    public static synchronized boolean hasPersistedValues() {
        SharedPreferences p = prefs();
        return p.contains(KEY_RECORDING_MODE)
                || p.contains(KEY_BASELINE_RUN_ID);
    }

    /**
     * Removes all Run Health settings.  Used by tests and by the UI "Reset"
     * action.
     */
    public static synchronized void clear() {
        synchronized (RunHealthConfig.class) {
            prefs().edit().clear().apply();
        }
    }
}
