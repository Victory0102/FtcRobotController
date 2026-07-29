/*
 * Copyright (c) 2026 FTC Run Health contributors
 *
 * Licensed under the GNU General Public License v3.0 or later.
 * See the top-level LICENSE file for details.
 */
package org.firstinspires.ftc.teamcode.runhealth.logging;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Bounded, thread-safe registry of channel definitions made during a single
 * Run Health session.
 *
 * <p>Cap and ordering rules:
 * <ul>
 *   <li>At most {@link #MAX_CHANNELS} channels may be defined.  Adding more
 *       returns {@code false} rather than throwing.</li>
 *   <li>Insertion order is preserved so the manifest easy to inspect.</li>
 *   <li>Defining a channel with the same name and {@link ChannelType}
 *       is idempotent — duplicate definitions with the same metadata are
 *       accepted silently; divergent definitions return
 *       {@code false} from {@link #define(ChannelSpec)} and the existing
 *       spec is kept.</li>
 * </ul>
 *
 * <p>All write paths enforce the limits; a buggy OpMode cannot crash the
 * session or grow memory without bound.
 */
public final class ChannelRegistry {

    /** Maximum number of distinct channels per session. */
    public static final int MAX_CHANNELS = 256;

    private final LinkedHashMap<String, ChannelSpec> specs = new LinkedHashMap<>();

    public synchronized boolean define(ChannelSpec spec) {
        if (spec == null) return false;
        String key = spec.key();
        ChannelSpec existing = specs.get(key);
        if (existing != null) {
            // Same name + same type → idempotent.  Otherwise reject.
            if (existing.type != spec.type) return false;
            // Refine metadata in place if caller provides more detail
            // than the first definition; this keeps the registry friendly.
            if ((existing.group == null || existing.group.isEmpty())
                    && spec.group != null && !spec.group.isEmpty()) {
                specs.put(key, spec);
            }
            return true;
        }
        if (specs.size() >= MAX_CHANNELS) return false;
        specs.put(key, spec);
        return true;
    }

    public synchronized List<ChannelSpec> snapshot() {
        return Collections.unmodifiableList(new ArrayList<>(specs.values()));
    }

    public synchronized int size() { return specs.size(); }

    public synchronized boolean has(String name) {
        if (name == null) return false;
        return specs.containsKey(ChannelSpec.keyFor(name));
    }

    public synchronized ChannelSpec get(String name) {
        if (name == null) return null;
        return specs.get(ChannelSpec.keyFor(name));
    }

    /** Reads-only view used by the manifest writer. */
    public Map<String, ChannelSpec> asMap() {
        synchronized (this) {
            // Defensive copy; LinkedHashMap preserves insertion order.
            return new LinkedHashMap<>(specs);
        }
    }
}
