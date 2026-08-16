package org.firstinspires.ftc.teamcode.runhealth.logging;

import org.junit.Test;

import java.io.File;
import java.io.IOException;
import java.nio.file.Files;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class RunStorageTest {

    @Test
    public void primaryRunFilter_excludesChannelsCompanion() throws IOException {
        File dir = Files.createTempDirectory("runhealth-filter-").toFile();
        File main = new File(dir, "run.csv");
        File channels = new File(dir, "run.channels.csv");
        File manifest = new File(dir, "run.manifest.json");
        try {
            assertTrue(main.createNewFile());
            assertTrue(channels.createNewFile());
            assertTrue(manifest.createNewFile());
            assertTrue(RunStorage.isPrimaryRunFile(main));
            assertFalse(RunStorage.isPrimaryRunFile(channels));
            assertFalse(RunStorage.isPrimaryRunFile(manifest));
        } finally {
            main.delete();
            channels.delete();
            manifest.delete();
            dir.delete();
        }
    }
}
