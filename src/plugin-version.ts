declare const __OPENCLAW_OTEL_PLUGIN_VERSION__: string;

// Injected from package.json by the release build so exported telemetry can be
// tied to the exact plugin artifact that produced it.
export const OPENCLAW_OTEL_PLUGIN_VERSION = __OPENCLAW_OTEL_PLUGIN_VERSION__;
