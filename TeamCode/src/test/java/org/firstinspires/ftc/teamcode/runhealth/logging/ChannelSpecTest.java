/*
 * Copyright (c) 2026 FTC Run Health contributors
 *
 * Licensed under the GNU General Public License v3.0 or later.
 * See the top-level LICENSE file for details.
 */
package org.firstinspires.ftc.teamcode.runhealth.logging;

import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

/**
 * Pure-JVM tests for {@link ChannelSpec}.  No Android Context is required.
 */
public class ChannelSpecTest {

    @Test
    public void constructor_acceptsValidName() {
        ChannelSpec s = new ChannelSpec("arm.position", ChannelType.NUMBER, "Arm", "ticks", "position");
        assertEquals("arm.position", s.name);
        assertEquals(ChannelType.NUMBER, s.type);
        assertEquals("Arm", s.group);
        assertEquals("ticks", s.unit);
        assertEquals("position", s.description);
    }

    @Test
    public void constructor_rejectsTooLongNames() {
        // The constructor delegates to validateName, which throws
        // IllegalArgumentException for any name longer than MAX_NAME_LENGTH.
        StringBuilder big = new StringBuilder();
        while (big.length() < ChannelSpec.MAX_NAME_LENGTH + 10) {
            big.append("abcdefghijklmnop");
        }
        try {
            ChannelSpec.number(big.toString());
            fail("validateName must reject names longer than MAX_NAME_LENGTH");
        } catch (IllegalArgumentException expected) { /* ok */ }
    }

    @Test
    public void constructor_rejectsEmptyName() {
        try {
            new ChannelSpec("", ChannelType.NUMBER, null, null, null);
            fail("expected exception");
        } catch (IllegalArgumentException expected) { /* ok */ }
    }

    @Test
    public void constructor_rejectsReservedPrefix() {
        try {
            new ChannelSpec("__internal__", ChannelType.TEXT, null, null, null);
            fail("expected exception");
        } catch (IllegalArgumentException expected) { /* ok */ }
    }

    @Test
    public void constructor_rejectsInvalidChar() {
        try {
            new ChannelSpec("name with space", ChannelType.NUMBER, null, null, null);
            fail("expected exception");
        } catch (IllegalArgumentException expected) { /* ok */ }
    }

    @Test
    public void validateName_trimsWhitespace() {
        assertEquals("abc", ChannelSpec.validateName("  abc  "));
    }

    @Test
    public void validateName_acceptsAllowedPunctuation() {
        assertEquals("a.b-c_x1", ChannelSpec.validateName("a.b-c_x1"));
    }

    @Test
    public void equality_nameAndTypeMatch() {
        // Two specs with the same (case-sensitive) name and same type must
        // compare equal even when their metadata fields differ.  The
        // hashCode uses a case-insensitive projection; equals uses the
        // raw field, so we keep both names identical here.
        ChannelSpec a = new ChannelSpec("arm", ChannelType.NUMBER, "G", "u", "d");
        ChannelSpec b = new ChannelSpec("arm", ChannelType.NUMBER, "different", "x", "y");
        assertEquals("equality ignores metadata: " + a + " vs " + b, a, b);
        assertEquals(a.hashCode(), b.hashCode());
    }

    @Test
    public void equality_isCaseInsensitiveOnName() {
        // Contract part 1: mixed-case names compare equal AND share the same
        // hashCode (Java equals/hashCode contract).
        ChannelSpec upper = new ChannelSpec("Arm", ChannelType.NUMBER, "G", "u", "d");
        ChannelSpec lower = new ChannelSpec("arm", ChannelType.NUMBER, "", "", "");
        assertEquals("Arm must equal arm", upper, lower);
        assertEquals("hashCode must agree", upper.hashCode(), lower.hashCode());
    }

    @Test
    public void key_collapsesMixedCase() {
        // Contract part 2a: key() is the canonical lookup key, lower-cased
        // under Locale.US, and identical for mixed-case inputs.
        ChannelSpec upper = new ChannelSpec("Arm", ChannelType.NUMBER, null, null, null);
        ChannelSpec lower = new ChannelSpec("arm", ChannelType.NUMBER, null, null, null);
        assertEquals("key() must collapse case", upper.key(), lower.key());
        // Static helper agrees with the instance accessor (same canonical key).
        assertEquals("keyFor must match key()", upper.key(), ChannelSpec.keyFor("Arm"));
    }

    @Test
    public void keyFor_returnsNullForNullInput() {
        // Contract part 2b: keyFor is null-safe; callers may rely on
        // null-on-null behaviour (ChannelSpec#keyFor Javadoc).
        assertNull(ChannelSpec.keyFor(null));
        // Non-null still produces the lower-cased key.
        assertEquals("arm", ChannelSpec.keyFor("Arm"));
    }

    @Test
    public void equality_differentType() {
        ChannelSpec a = new ChannelSpec("arm", ChannelType.NUMBER, null, null, null);
        ChannelSpec b = new ChannelSpec("arm", ChannelType.BOOLEAN, null, null, null);
        assertNotEquals(a, b);
    }

    @Test
    public void type_wireName_isStable() {
        assertEquals("number", ChannelType.NUMBER.wireName());
        assertEquals("boolean", ChannelType.BOOLEAN.wireName());
        assertEquals("text", ChannelType.TEXT.wireName());
        assertEquals("event", ChannelType.EVENT.wireName());
        assertEquals("pose", ChannelType.POSE.wireName());
    }

    @Test
    public void type_fromWireName_roundTrips() {
        assertEquals(ChannelType.NUMBER, ChannelType.fromWireName("number"));
        assertEquals(ChannelType.BOOLEAN, ChannelType.fromWireName("BOOLEAN"));  // case-insensitive
        assertEquals(null, ChannelType.fromWireName("unknown"));
        assertEquals(null, ChannelType.fromWireName(null));
        assertEquals(null, ChannelType.fromWireName(""));
    }

    @Test
    public void number_buildsSpec() {
        ChannelSpec s = ChannelSpec.number("vel");
        assertEquals(ChannelType.NUMBER, s.type);
        assertEquals("vel", s.name);
    }
}
