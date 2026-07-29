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
 * <p>Production path is backed by the FTC Robot Controller
 * {@link SharedPreferences}.  JVM unit tests have no Android {@link Context},
 * so every getter/setter falls back to an in-memory map when {@code AppUtil}
 * throws or returns {@code null}.  This keeps the surface JVM-runnable
 * without standing up Robolectric.
 */
public final class RunHealthConfig {

    public static final String MODE_OFF = "OFF";
    public static final String MODE_NEXT = "NEXT";
    public static final String MODE_EVERY = "EVERY";

    public static final String DEFAULT_MODE = MODE_OFF;

    private static final String PREF_NAME = "runhealth_settings";
    private static final String KEY_RECORDING_MODE = "recording_mode";
    private static final String KEY_BASELINE_RUN_ID = "baseline_run_id";

    private static volatile InMemory inMemoryBacking = new InMemory();

    private RunHealthConfig() { /* utility */ }

    private static SharedPreferences prefs() {
        Context ctx = null;
        try {
            ctx = AppUtil.getDefContext();
            if (ctx == null) return null;
            return ctx.getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE);
        } catch (Throwable t) {
            // No Android context available (pure-JVM tests).  Fall back to
            // the in-memory backing so unit tests can exercise the path
            // without Robolectric.
            return null;
        }
    }

    /**
     * Returns the current recording mode.  Defaults to {@link #MODE_OFF}.
     * Unknown persisted values fall back to {@link #DEFAULT_MODE}.
     */
    public static synchronized String getRecordingMode() {
        SharedPreferences p = prefs();
        String m = (p != null)
                ? p.getString(KEY_RECORDING_MODE, DEFAULT_MODE)
                : inMemoryBacking.get(KEY_RECORDING_MODE, DEFAULT_MODE);
        if (!MODE_OFF.equals(m) && !MODE_NEXT.equals(m) && !MODE_EVERY.equals(m)) {
            return DEFAULT_MODE;
        }
        return m;
    }

    /**
     * Sets the recording mode.  Unknown values become {@link #DEFAULT_MODE}.
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
        SharedPreferences p = prefs();
        if (p != null) {
            p.edit().putString(KEY_RECORDING_MODE, mode).apply();
        } else {
            inMemoryBacking.put(KEY_RECORDING_MODE, mode);
        }
    }

    /**
     * Atomically transitions from {@code expectedCurrent} to {@code newMode}
     * and returns {@code true} only if the persisted mode matched
     * {@code expectedCurrent} at the moment of read.  Used to make
     * "consume NEXT" idempotent under contention.
     */
    public static synchronized boolean compareAndSetMode(String expectedCurrent, String newMode) {
        if (expectedCurrent == null || newMode == null) return false;
        synchronized (RunHealthConfig.class) {
            if (!expectedCurrent.equals(getRecordingMode())) return false;
            SharedPreferences p = prefs();
            if (p != null) {
                p.edit().putString(KEY_RECORDING_MODE, newMode).apply();
            } else {
                inMemoryBacking.put(KEY_RECORDING_MODE, newMode);
            }
            return true;
        }
    }

    /**
     * Returns the persisted baseline run id, or {@code null} if no baseline
     * has been set.
     */
    public static synchronized String getBaselineRunId() {
        SharedPreferences p = prefs();
        String v = (p != null)
                ? p.getString(KEY_BASELINE_RUN_ID, null)
                : inMemoryBacking.get(KEY_BASELINE_RUN_ID, null);
        if (v == null || v.isEmpty()) return null;
        return v;
    }

    /**
     * Persists the baseline run id.  A {@code null} or empty value clears
     * the baseline.
     */
    public static synchronized void setBaselineRunId(String runId) {
        SharedPreferences p = prefs();
        if (p != null) {
            if (runId == null || runId.isEmpty()) {
                p.edit().remove(KEY_BASELINE_RUN_ID).apply();
            } else {
                p.edit().putString(KEY_BASELINE_RUN_ID, runId).apply();
            }
        } else {
            if (runId == null || runId.isEmpty()) {
                inMemoryBacking.remove(KEY_BASELINE_RUN_ID);
            } else {
                inMemoryBacking.put(KEY_BASELINE_RUN_ID, runId);
            }
        }
    }

    /**
     * Returns {@code true} if any of the two stored values differ from
     * their defaults.  Used by tests.
     */
    public static synchronized boolean hasPersistedValues() {
        SharedPreferences p = prefs();
        return (p != null)
                ? (p.contains(KEY_RECORDING_MODE) || p.contains(KEY_BASELINE_RUN_ID))
                : inMemoryBacking.containsAny(KEY_RECORDING_MODE, KEY_BASELINE_RUN_ID);
    }

    /**
     * Removes all Run Health settings.  Used by tests and by the UI "Reset"
     * action.
     */
    public static synchronized void clear() {
        SharedPreferences p = prefs();
        if (p != null) {
            p.edit().clear().apply();
        } else {
            inMemoryBacking.clear();
        }
    }

    /**
     * JVM-only in-memory backing that satisfies the partial
     * {@link SharedPreferences} contract used here.  Only present to make
     * the recording-mode + baseline APIs testable on plain JVM without
     * Robolectric.
     */
    private static final class InMemory {
        private final java.util.Map<String, String> map = new java.util.HashMap<>();

        synchronized String get(String key, String def) {
            return map.containsKey(key) ? map.get(key) : def;
        }

        synchronized void put(String key, String value) {
            map.put(key, value);
        }

        synchronized void remove(String key) {
            map.remove(key);
        }

        synchronized boolean containsAny(String... keys) {
            for (String k : keys) if (map.containsKey(k)) return true;
            return false;
        }

        synchronized void clear() { map.clear(); }
    }
}
