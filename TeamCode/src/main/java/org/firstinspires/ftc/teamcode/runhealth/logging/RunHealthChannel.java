/*
 * Copyright (c) 2026 FTC Run Health contributors
 *
 * Licensed under the GNU General Public License v3.0 or later.
 * See the top-level LICENSE file for details.
 */
package org.firstinspires.ftc.teamcode.runhealth.logging;

/**
 * Ergonomic builder for {@link ChannelSpec} instances used with
 * {@code session.defineChannel("...", RunHealthChannel.number().group("Slide")...)}.
 *
 * <p>Pattern is intentionally one-shot: a builder is mutable once
 * but never reused across channels.  This keeps the call site readable.
 */
public final class RunHealthChannel {

    private final ChannelType type;
    private String group;
    private String unit;
    private String description;

    private RunHealthChannel(ChannelType type) {
        this.type = type;
    }

    public static RunHealthChannel number()   { return new RunHealthChannel(ChannelType.NUMBER); }
    public static RunHealthChannel booleanChannel() { return new RunHealthChannel(ChannelType.BOOLEAN); }
    public static RunHealthChannel text()     { return new RunHealthChannel(ChannelType.TEXT); }
    public static RunHealthChannel event()    { return new RunHealthChannel(ChannelType.EVENT); }
    public static RunHealthChannel pose()     { return new RunHealthChannel(ChannelType.POSE); }

    public RunHealthChannel group(String g)      { this.group = g; return this; }
    public RunHealthChannel unit(String u)       { this.unit = u; return this; }
    public RunHealthChannel description(String d){ this.description = d; return this; }

    public ChannelSpec build(String name) {
        return new ChannelSpec(name, type, group, unit, description);
    }
}
