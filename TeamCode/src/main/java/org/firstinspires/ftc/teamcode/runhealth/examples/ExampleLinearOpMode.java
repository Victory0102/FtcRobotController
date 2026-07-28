/*
 * Copyright (c) 2025 FTC Run Health contributors
 *
 * Licensed under the GNU General Public License v3.0 or later.
 * See the top-level LICENSE file for details.
 */
package org.firstinspires.ftc.teamcode.runhealth.examples;

import com.qualcomm.robotcore.eventloop.opmode.Disabled;
import com.qualcomm.robotcore.eventloop.opmode.LinearOpMode;
import com.qualcomm.robotcore.eventloop.opmode.TeleOp;
import com.qualcomm.robotcore.hardware.DcMotorEx;

import org.firstinspires.ftc.teamcode.runhealth.logging.RunHealthSession;

import java.util.HashMap;
import java.util.Map;

/**
 * Minimum-integration example showing how to wire {@link RunHealthSession}
 * into a {@link LinearOpMode}.
 *
 * <p>This OpMode is {@code @Disabled} so it will not appear in competition
 * OpMode lists by default.  Copy the structure into your team's OpModes if
 * you want to enable per-run logging.
 *
 * <p>Key properties demonstrated:
 * <ul>
 *     <li>One call to {@code start()} before {@code waitForStart()}.</li>
 *     <li>One call to {@code capture()} per loop iteration.</li>
 *     <li>A {@code try/finally} block to guarantee {@code finish()} runs
 *         even if the OpMode throws.</li>
 *     <li>Capture only reads motor state; the user's existing power-setting
 *         code is unaffected.</li>
 *     <li>Motor names are passed in so they round-trip across runs.</li>
 * </ul>
 */
@TeleOp(name = "Run Health: Example Linear", group = "Examples")
@Disabled
public class ExampleLinearOpMode extends LinearOpMode {

    @Override
    public void runOpMode() {
        // 1. Look up the motors using the names from your Robot Configuration.
        //    Replace these names with the actual names in your config file.
        DcMotorEx[] motors = new DcMotorEx[]{
                hardwareMap.get(DcMotorEx.class, "leftFront"),
                hardwareMap.get(DcMotorEx.class, "leftBack"),
                hardwareMap.get(DcMotorEx.class, "rightFront"),
                hardwareMap.get(DcMotorEx.class, "rightBack"),
        };
        Map<DcMotorEx, String> names = new HashMap<>();
        for (DcMotorEx m : motors) {
            names.put(m, m == null ? "" : inferName(hardwareMap, m));
        }

        // 2. Start the Run Health session BEFORE waitForStart().  This arms
        //    the NEXT/EVERY claim; the claim is consumed atomically inside
        //    capture() so an early cancel still leaves NEXT armed.
        RunHealthSession session = RunHealthSession.start(hardwareMap, this, names);

        // 3. Wait for the start of the run, telemetry-style.
        telemetry.addData("Status", "Run Health session ready (recording=" + session.isRecording() + ")");
        telemetry.update();
        waitForStart();

        // 4. Main control loop.  The user's existing robot code goes here.
        //    We add exactly one capture() call - it is rate-limited and safe.
        try {
            while (opModeIsActive()) {
                // Example: read a gamepad and apply power to motors.
                double dx = -gamepad1.left_stick_y;
                double dy = gamepad1.left_stick_x;
                double turn = gamepad1.right_stick_x;
                motors[0].setPower(dx + dy + turn);
                motors[1].setPower(dx - dy + turn);
                motors[2].setPower(dx - dy - turn);
                motors[3].setPower(dx + dy - turn);

                // Capture one motor sample for the entire robot.  Never
                // throws; never blocks.  No file I/O performed here.
                session.capture();

                // Optional telemetry - intentionally outside capture().
                telemetry.addData("Run id", session.runId());
                telemetry.update();
            }
        } finally {
            // finish() is idempotent and safe to call from stop() paths.
            session.finish();
        }
    }

    /**
     * Looks up the configuration name for a motor instance using
     * HardwareMap.  The FTC SDK does not provide reverse-lookup so we
     * try to match by enumerating known names.
     */
    @SuppressWarnings("unused")
    private static String inferName(com.qualcomm.robotcore.hardware.HardwareMap hardwareMap, DcMotorEx motor) {
        try {
            java.util.Set<String> all = hardwareMap.getAllNames(DcMotorEx.class);
            if (all == null) return "";
            // We can't safely reverse-lookup from an instance, so we
            // return the first available name as a placeholder.  In
            // production code, the OpMode passes a names map at start().
            for (String n : all) {
                try {
                    if (hardwareMap.get(DcMotorEx.class, n) == motor) return n;
                } catch (Throwable ignored) {}
            }
        } catch (Throwable ignored) {}
        return "unknown";
    }
}
