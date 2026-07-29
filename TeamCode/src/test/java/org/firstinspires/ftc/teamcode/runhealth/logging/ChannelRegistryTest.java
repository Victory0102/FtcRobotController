/*
 * Copyright (c) 2026 FTC Run Health contributors
 *
 * Licensed under the GNU General Public License v3.0 or later.
 * See the top-level LICENSE file for details.
 */
package org.firstinspires.ftc.teamcode.runhealth.logging;

import org.junit.Test;

import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

/**
 * Pure-JVM tests for {@link ChannelRegistry}.  Verifies idempotent
 * re-definition, divergence rejection, capacity enforcement, and
 * insertion-order preservation.
 */
public class ChannelRegistryTest {

    @Test
    public void define_addsNewSpec() {
        ChannelRegistry r = new ChannelRegistry();
        assertTrue(r.define(ChannelSpec.number("vel")));
        assertEquals(1, r.size());
    }

    @Test
    public void define_isIdempotentForSameNameAndType() {
        ChannelRegistry r = new ChannelRegistry();
        assertTrue(r.define(ChannelSpec.number("vel")));
        assertTrue(r.define(ChannelSpec.number("vel")));  // same name + type
        assertEquals(1, r.size());
    }

    @Test
    public void define_refinesMetadataOnSecondCall() {
        ChannelRegistry r = new ChannelRegistry();
        assertTrue(r.define(ChannelSpec.number("vel")));
        // Second call with a different group must refine, not reject.
        assertTrue(r.define(new ChannelSpec("vel", ChannelType.NUMBER,
                "Drivetrain", "tps", null)));
        assertEquals(1, r.size());
        ChannelSpec refined = r.get("vel");
        assertNotNull(refined);
        assertEquals("Drivetrain", refined.group);
        assertEquals("tps", refined.unit);
    }

    @Test
    public void define_rejectsDivergentType() {
        ChannelRegistry r = new ChannelRegistry();
        assertTrue(r.define(ChannelSpec.number("vel")));
        // Same name, different type - rejected.
        assertFalse(r.define(new ChannelSpec("vel", ChannelType.TEXT, null, null, null)));
        assertEquals(1, r.size());
    }

    @Test
    public void define_enforcesMaxChannels() {
        ChannelRegistry r = new ChannelRegistry();
        for (int i = 0; i < ChannelRegistry.MAX_CHANNELS; i++) {
            assertTrue("insert #" + i, r.define(new ChannelSpec(
                    "c" + i, ChannelType.NUMBER, null, null, null)));
        }
        assertEquals(ChannelRegistry.MAX_CHANNELS, r.size());
        assertFalse("insert beyond cap must be rejected",
                r.define(ChannelSpec.number("overflow")));
    }

    @Test
    public void snapshot_preservesInsertionOrder() {
        ChannelRegistry r = new ChannelRegistry();
        r.define(ChannelSpec.number("alpha"));
        r.define(new ChannelSpec("beta", ChannelType.TEXT, null, null, null));
        r.define(new ChannelSpec("gamma", ChannelType.POSE, null, null, null));
        List<ChannelSpec> out = r.snapshot();
        assertEquals("alpha", out.get(0).name);
        assertEquals("beta", out.get(1).name);
        assertEquals("gamma", out.get(2).name);
    }

    @Test
    public void asMap_returnsDefensiveCopy() {
        ChannelRegistry r = new ChannelRegistry();
        r.define(ChannelSpec.number("alpha"));
        java.util.Map<String, ChannelSpec> m1 = r.asMap();
        m1.clear();
        java.util.Map<String, ChannelSpec> m2 = r.asMap();
        assertEquals(1, m2.size());
    }

    @Test
    public void lookup_isCaseInsensitive() {
        ChannelRegistry r = new ChannelRegistry();
        r.define(ChannelSpec.number("Vel"));
        assertTrue(r.has("vel"));
        assertTrue(r.has("VEL"));
        assertFalse(r.has("nop"));
        assertNotNull(r.get("vel"));
        assertNull(r.get("nop"));
    }

    @Test
    public void define_rejectsNull() {
        ChannelRegistry r = new ChannelRegistry();
        assertFalse(r.define(null));
    }
}
