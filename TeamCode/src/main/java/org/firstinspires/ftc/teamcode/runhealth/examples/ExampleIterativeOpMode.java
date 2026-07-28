/*
 * Copyright (c) 2025 FTC Run Health contributors
 *
 * Licensed under the GNU General Public License v3.0 or later.
 * See the top-level LICENSE file for details.
 */
package org.firstinspires.ftc.teamcode.runhealth.examples;

import com.qualcomm.robotcore.eventloop.opmode.Disabled;
import com.qualcomm.robotcore.eventloop.opmode.OpMode;
import com.qualcomm.robotcore.eventloop.opmode.TeleOp;
import com.qualcomm.robotcore.hardware.DcMotorEx;

import org.firstinspires.ftc.teamcode.runhealth.logging.RunHealthSession;

import java.util.HashMap;
import java.util.Map;

/**
 * Minimum-integration example showing how to wire {@link RunHealthSession}
 * into an iterative {@link OpMode}.
 *
 * <p>Lifecycle:
 * <ul>
 *     <li>{@code init()}: start the session, set up motors.</li>
 *     <li>{@code loop()}: call {@code capture()} once per iteration.</li>
 *     <li>{@code stop()}: call {@code finish()} (always; it is idempotent).</li>
 * </ul>
 *
 * <p>The class is {@code @Disabled} so it does not appear in competition
 * OpMode lists.  Copy this pattern into your team's iterative OpModes.
 */
@TeleOp(name = "Run Health: Example Iterative", group = "Examples")
@Disabled
public class ExampleIterativeOpMode extends OpMode {

    // Replace these names with the real names from your Robot Configuration.
    private static final String[] MOTOR_NAMES = {
            "leftFront", "leftBack", "rightFront", "rightBack"
    };

    private DcMotorEx[] motors = new DcMotorEx[MOTOR_NAMES.length];
    private Map<DcMotorEx, String> motorNames;
    private RunHealthSession session;

    @Override
    public void init() {
        motorNames = new HashMap<>();
        for (int i = 0; i < MOTOR_NAMES.length; i++) {
            try {
                DcMotorEx m = hardwareMap.get(DcMotorEx.class, MOTOR_NAMES[i]);
                motors[i] = m;
                motorNames.put(m, MOTOR_NAMES[i]);
            } catch (Throwable t) {
                // A device may be missing; keep going so we never block the
                // OpMode from starting.
            }
        }
        session = RunHealthSession.start(hardwareMap, this, motorNames);
        telemetry.addData("Run Health", "recording=" + session.isRecording());
        telemetry.update();
    }

    @Override
    public void loop() {
        // Existing user robot code:
        if (motors[0] != null && motors[1] != null
                && motors[2] != null && motors[3] != null) {
            double drive = -gamepad1.left_stick_y;
            double strafe = gamepad1.left_stick_x;
            double turn = gamepad1.right_stick_x;
            motors[0].setPower(drive + strafe + turn);
            motors[1].setPower(drive - strafe + turn);
            motors[2].setPower(drive - strafe - turn);
            motors[3].setPower(drive + strafe - turn);
        }
        // Always capture once per loop.  capture() is a no-op when
        // recording is off and never throws.
        if (session != null) session.capture();
    }

    @Override
    public void stop() {
        // finish() is the contract: writes the CSV file if any samples
        // were captured. Safe and idempotent.
        if (session != null) session.finish();
    }
}
