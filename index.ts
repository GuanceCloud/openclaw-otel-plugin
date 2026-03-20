import type { OpenClawPluginApi } from "openclaw/plugin-sdk/diagnostics-otel";
import { resolveOtelPluginConfig } from "./src/config.js";
import { createOtelPluginService } from "./src/service.js";

const otelPlugin = {
  id: "openclaw-otel-plugin",
  name: "OpenClaw OTel Plugin",
  description: "Export OpenClaw diagnostic events as session-oriented traces over OTLP",
  register(api: OpenClawPluginApi) {
    api.registerService(
      createOtelPluginService(resolveOtelPluginConfig(api.pluginConfig), api.runtime),
    );
  },
};

export default otelPlugin;
