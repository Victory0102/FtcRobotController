/*
 * Copyright (c) 2025 FTC Run Health contributors
 *
 * Licensed under the GNU General Public License v3.0 or later.
 * See the top-level LICENSE file for details.
 */
package org.firstinspires.ftc.teamcode.runhealth.logging;

import android.content.Context;

import org.firstinspires.ftc.robotcore.internal.system.AppUtil;

import java.io.BufferedWriter;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.OutputStreamWriter;
import java.io.Writer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;

/**
 * Filesystem storage for completed Run Health CSV runs.
 *
 * <p>Directory layout (logical):
 * <pre>
 *   /FIRST/RunHealth/runs/&lt;UTCISO&gt;-&lt;opmode&gt;-&lt;shortId&gt;.csv
 * </pre>
 *
 * <p>Extracted from {@code AppUtil.getDefContext().getExternalFilesDir(null)}
 * where possible.  If that returns {@code null} (which can happen on a
 * developer phone that hasn't yet mounted external storage), falls back to
 * the application's internal-only files directory so we never throw I/O
 * exceptions at runtime.  All writes are restricted to {@code runs/}; the
 * web API further restricts reads to the same directory.
 */
public final class RunStorage {

    private static final String ROOT_DIR_NAME = "RunHealth";
    private static final String RUNS_SUBDIR = "runs";

    private final File rootDir;          // /FIRST/RunHealth
    private final File runsDir;          // /FIRST/RunHealth/runs

    public RunStorage() {
        this(rootDirForContext());
    }

    /** Constructor for tests: pass any directory. */
    public RunStorage(File rootDir) {
        if (rootDir == null) {
            throw new IllegalArgumentException("rootDir cannot be null");
        }
        this.rootDir = rootDir;
        this.runsDir = new File(rootDir, RUNS_SUBDIR);
        ensureDirectory(runsDir);
    }

    /**
     * Returns the directory containing CSV runs.  Always exists by the
     * time this method returns.
     */
    public File runsDirectory() {
        return runsDir;
    }

    /**
     * Returns the root Run Health directory.  Always exists.
     */
    public File rootDirectory() {
        return rootDir;
    }

    /**
     * Returns a sorted (newest first) list of {@code .csv} files in the runs
     * directory.  Hidden files and non-CSV files are skipped.
     */
    public List<File> listRuns() {
        File[] files = runsDir.listFiles((f) -> f != null && f.isFile() && f.getName().endsWith(".csv"));
        if (files == null) {
            return Collections.emptyList();
        }
        Arrays.sort(files, (a, b) -> Long.compare(b.lastModified(), a.lastModified()));
        List<File> out = new ArrayList<>(files.length);
        for (File f : files) {
            out.add(f);
        }
        return out;
    }

    /**
     * Returns the run file matching the given safe identifier, or
     * {@code null} if not found.
     *
     * <p>The id is matched by exact filename (after sanitization) within
     * the runs directory; this method refuses any id that fails
     * {@link FilenameSanitizer#isWithinDirectory(File, File)}.
     */
    public File findRunById(String runId) {
        if (runId == null) return null;
        // The browser-known id is the basename without ".csv"; we accept
        // either form here for robustness.
        String safe = sanitize(runId);
        if (safe.endsWith(".csv")) safe = safe.substring(0, safe.length() - 4);
        File candidate = new File(runsDir, safe + ".csv");
        if (!FilenameSanitizer.isWithinDirectory(runsDir, candidate)) {
            return null;
        }
        return candidate.exists() ? candidate : null;
    }

    /**
     * Writes content to a new CSV file inside the runs directory.
     * Returns the resulting {@link File}.  The filename is derived from
     * {@code utcTimestampSafe}, sanitized {@code opmodeName}, and
     * {@code runId}.  UTC timestamp is used verbatim in the filename.
     */
    public File writeRun(String utcTimestampSafe, String opmodeName, String runId, String content) throws IOException {
        if (content == null) {
            throw new IllegalArgumentException("content cannot be null");
        }
        File file = resolveSafe(utcTimestampSafe, opmodeName, runId);
        try (Writer w = new BufferedWriter(
                new OutputStreamWriter(
                        new java.io.FileOutputStream(file, false),
                        StandardCharsets.UTF_8))) {
            w.write(content);
        }
        return file;
    }

    /**
     * Deletes the run file matching the safe id.  Returns {@code true} if a
     * file was deleted; {@code false} otherwise (including when the id is
     * invalid for security reasons).
     */
    public boolean deleteRun(String runId) {
        File f = findRunById(runId);
        if (f == null) return false;
        if (!FilenameSanitizer.isWithinDirectory(runsDir, f)) return false;
        return f.delete();
    }

    /**
     * Deletes a list of run files.  Returns the count of files actually
     * deleted.  Any run id that fails validation is silently skipped.
     */
    public int deleteRuns(java.util.Collection<String> runIds) {
        if (runIds == null) return 0;
        int deleted = 0;
        // Deduplicate so we never try the same id twice.
        java.util.Set<String> seen = new java.util.HashSet<>();
        for (String id : runIds) {
            if (id == null || !seen.add(id)) continue;
            if (deleteRun(id)) deleted++;
        }
        return deleted;
    }

    /**
     * Streams a run file to the given {@link OutputStream} (used by the
     * browser "download" endpoint).
     *
     * @return number of bytes copied.
     */
    public long streamRunTo(String runId, OutputStream out) throws IOException {
        File f = findRunById(runId);
        if (f == null) {
            throw new FileNotFound("Run not found: " + runId);
        }
        try (InputStream in = Files.newInputStream(f.toPath())) {
            byte[] buf = new byte[8192];
            long total = 0;
            int n;
            while ((n = in.read(buf)) > 0) {
                out.write(buf, 0, n);
                total += n;
            }
            return total;
        }
    }

    /** Returns aggregated size of all runs in bytes (excluding non-runs). */
    public long totalBytesUsed() {
        long sum = 0;
        for (File f : listRuns()) {
            sum += f.length();
        }
        return sum;
    }

    // -------------------------------------------------------------- helpers

    /**
     * Returns the canonical root directory, creating intermediate
     * directories.  Pure file operation; no FTC-specific side effects.
     */
    public static File resolveRootDir(File baseDir) {
        File root = new File(baseDir, ROOT_DIR_NAME);
        ensureDirectory(root);
        File runs = new File(root, RUNS_SUBDIR);
        ensureDirectory(runs);
        return root;
    }

    private static File rootDirForContext() {
        Context ctx = AppUtil.getDefContext();
        // External (FIRST) preferred, internal fallback for robustness.
        File external = ctx.getExternalFilesDir(null);
        File chosen = external != null ? external : ctx.getFilesDir();
        return resolveRootDir(chosen);
    }

    private static void ensureDirectory(File d) {
        if (d == null) return;
        if (!d.exists() && !d.mkdirs()) {
            // Last-ditch: try creating parent.
            File p = d.getParentFile();
            if (p != null && !p.exists()) {
                p.mkdirs();
            }
            d.mkdirs();
        }
    }

    private static String sanitize(String s) {
        if (s == null) return "";
        return FilenameSanitizer.sanitizeSegment(s);
    }

    private File resolveSafe(String ts, String opmode, String runId) {
        String name = FilenameSanitizer.buildCsvFilename(sanitize(ts), sanitize(opmode), runId);
        File target = new File(runsDir, name);
        if (!FilenameSanitizer.isWithinDirectory(runsDir, target)) {
            throw new SecurityException("Refusing to write outside runs/ : " + name);
        }
        return target;
    }

    /** Thrown when a caller references a run id that does not exist. */
    public static class FileNotFound extends IOException {
        public FileNotFound(String msg) { super(msg); }
    }
}
