/*
 * Copyright (c) 2025 FTC Run Health contributors
 *
 * Licensed under the GNU General Public License v3.0 or later.
 * See the top-level LICENSE file for details.
 */
package org.firstinspires.ftc.teamcode.runhealth.api;

import org.firstinspires.ftc.ftccommon.external.WebHandlerRegistrar;

import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;

/**
 * Hooks Run Health into the FTC Robot Controller's web server via the
 * {@link org.firstinspires.ftc.ftccommon.external.WebHandlerRegistrar}
 * mechanism.  The companion class is scanned by the SDK at startup and
 * any method annotated with {@code @WebHandlerRegistrar} is invoked.
 *
 * <p>Strategy:
 * <ul>
 *   <li>The annotation target type is, in current FTC SDK, abstract.  The
 *       SDK calls our method reflecting on the first {@link WebHandlerRegistrar}
 *       method.  We declare the parameter type as {@code Object} so we do
 *       not need to import or compile-couple to the actual class.</li>
 *   <li>We then introspect the manager at runtime, find a
 *       {@code register(String, X)} method, infer X, and register a
 *       {@link Proxy} that intercepts every call and dispatches to
 *       {@link RunHealthApi}.</li>
 *   <li>If the SDK changes the WebHandler contract or the WebHandlerManager
 *       registration shape, the worst case is that Run Health routes are
 *       not registered; we log and continue.  The OpMode code is unaffected.</li>
 * </ul>
 *
 * <p>This file is intentionally reflection-heavy.  No setter on any device is
 * ever reached from here, so safety properties are unaffected.
 */
public final class RunHealthWeb {

    private RunHealthWeb() { /* utility */ }

    /**
     * Register the Run Health HTTP routes with the FTC WebHandlerManager.
     *
     * <p>The signature is declared with {@code Object} so we do not need
     * to depend on a specific {@link WebHandlerManager} type.  The runtime
     * SDK calls this method via reflection with the actual manager instance.
     */
    @WebHandlerRegistrar
    public static void registerRunHealthRoutes(Object webHandlerManager) {
        try {
            registerSafely(webHandlerManager);
        } catch (Throwable t) {
            // Never propagate; the OpMode must continue even if registration fails.
            System.err.println("[RunHealthWeb] Registration failed: " + t);
        }
    }

    private static void registerSafely(Object manager) throws Exception {
        if (manager == null) return;
        // Look up the WebHandlerManager.register(String, X) method, where X
        // may be a concrete WebHandler class, an interface, or an abstract
        // class depending on the SDK version.
        Method register = findRegister(manager.getClass());
        if (register == null) {
            System.err.println("[RunHealthWeb] No register(String,?) on " + manager.getClass().getName());
            return;
        }
        Class<?> handlerType = register.getParameterTypes()[1];
        Object dispatcher = Proxy.newProxyInstance(
                handlerType.getClassLoader(),
                new Class<?>[] { handlerType },
                new DispatcherInvocationHandler());

        // Top-level prefix that handles index.html and unmapped /
        final String[] paths = {
                "/runhealth/",
                "/runhealth/index.html",
                "/runhealth/api/recording",
                "/runhealth/api/baseline",
                "/runhealth/api/runs",
                "/runhealth/assets/",
        };
        for (String p : paths) {
            try {
                register.invoke(manager, p, dispatcher);
            } catch (Throwable t) {
                System.err.println("[RunHealthWeb] Could not register " + p + ": " + t);
            }
        }
        // Tell the user we're set up.
        System.out.println("[RunHealthWeb] Registered " + paths.length + " Run Health routes.");
    }

    private static Method findRegister(Class<?> cls) {
        for (Method m : cls.getMethods()) {
            if (!"register".equals(m.getName())) continue;
            if (m.getParameterCount() != 2) continue;
            Class<?>[] pt = m.getParameterTypes();
            if (pt[0] != String.class) continue;
            return m;
        }
        return null;
    }

    /**
     * Adapter proxy that translates the SDK's WebHandler call shape into
     * a {@link RunHealthApi.ApiRequest}.  All response shapes are also
     * reflected so we stay independent of the concrete SDK types.
     */
    private static final class DispatcherInvocationHandler implements InvocationHandler {

        private final RunHealthApi api = new RunHealthApi();

        @Override
        public Object invoke(Object proxy, Method method, Object[] args) throws Throwable {
            String name = method.getName();
            // JDK-injected Object methods: handle gracefully.
            if ("hashCode".equals(name)) return System.identityHashCode(proxy);
            if ("equals".equals(name))   return proxy == args[0];
            if ("toString".equals(name)) return "RunHealthDispatcher";
            // The web server invokes the actual handler method.
            if (args != null && args.length >= 1 && args[0] != null) {
                return dispatch(method, args, proxy);
            }
            // No request argument: legacy shapes like handle() with no args.
            // Fall back to a 405 response when we cannot infer a request.
            return null;
        }

        private Object dispatch(Method method, Object[] args, Object proxy) throws Exception {
            Object req = args[0];
            String methodName = method.getName();
            String httpMethod = "GET";
            String path = "/";
            String body = "";

            String m1 = (String) readField(req, "method");
            if (m1 != null) httpMethod = m1;
            String p1 = (String) readField(req, "uri");
            if (p1 == null) p1 = (String) readField(req, "path");
            if (p1 != null) path = p1;
            String b1 = (String) readField(req, "body");
            if (b1 == null) b1 = "";
            body = b1;

            // Strip query string from the path so the API matches by path only.
            int q = path.indexOf('?');
            String plainPath = q >= 0 ? path.substring(0, q) : path;

            RunHealthApi.ApiRequest apiReq = new RunHealthApi.ApiRequest(
                    httpMethod, plainPath, body, null);
            RunHealthApi.ApiResponse resp = api.handle(apiReq);

            // Convert our ApiResponse into whatever the SDK expects. The
            // modern Shape is handle(...) returning a WebHandlerResponse with
            // a body() byte[].  Older shapes return String.  We try the
            // byte[] form first, then String, then fall back to a generic
            // method-returning-null.
            Object sdkResponse = null;

            try {
                Class<?> respCls = method.getReturnType();
                if (respCls == void.class) {
                    // Some SDK shapes are void; write to a side channel.
                    return null;
                }
                String ctor = findCtor(respCls, byte[].class, String.class);
                if (ctor != null) {
                    sdkResponse = respCls.getConstructor(byte[].class, String.class)
                            .newInstance(resp.body, resp.contentType);
                } else {
                    String strCtor = findCtor(respCls, String.class);
                    if (strCtor != null) {
                        sdkResponse = respCls.getConstructor(String.class)
                                .newInstance(new String(resp.body,
                                        java.nio.charset.StandardCharsets.UTF_8));
                    }
                }
            } catch (Throwable t) {
                // Best-effort: fall back to null and rely on default page.
            }

            // Also try to inject our HTTP status code via reflection if
            // a setter exists (required for newer SDK shapes).
            if (sdkResponse != null && resp.status != 200) {
                trySetStatus(sdkResponse, resp.status);
            }
            return sdkResponse;
        }

        private static void trySetStatus(Object obj, int status) {
            try {
                Method set = obj.getClass().getMethod("setStatus", int.class);
                set.invoke(obj, status);
            } catch (Throwable ignored) { /* SDK shape doesn't expose setStatus */ }
        }

        private static String findCtor(Class<?> cls, Class<?>... desired) {
            for (java.lang.reflect.Constructor<?> c : cls.getConstructors()) {
                Class<?>[] pt = c.getParameterTypes();
                if (pt.length != desired.length) continue;
                boolean match = true;
                for (int i = 0; i < pt.length; i++) {
                    if (!pt[i].isAssignableFrom(desired[i])) { match = false; break; }
                }
                if (match) return c.getName();
            }
            return null;
        }

        /** Reflectively reads a field by name; returns null if not present. */
        private static Object readField(Object obj, String name) {
            try {
                Class<?> cls = obj.getClass();
                while (cls != null && cls != Object.class) {
                    try {
                        java.lang.reflect.Field f = cls.getDeclaredField(name);
                        f.setAccessible(true);
                        return f.get(obj);
                    } catch (NoSuchFieldException nse) {
                        cls = cls.getSuperclass();
                    }
                }
            } catch (Throwable ignored) {}
            return null;
        }

        // Map of arg-class -> handler used to dispatch on modern SDK shapes.
        // Currently unused; reserved if Future SDK shapes need explicit matching.
        @SuppressWarnings("unused")
        private static boolean isMainCall(Method m) {
            String n = m.getName();
            return "handle".equals(n) || "render".equals(n) || "service".equals(n)
                    || "process".equals(n) || "doGet".equals(n) || "doPost".equals(n);
        }
    }
}
