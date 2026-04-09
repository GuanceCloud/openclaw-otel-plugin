export function resolveOtelUrl(endpoint, path) {
  const normalizedPath = String(path ?? "").trim().replace(/^\/+/, "").replace(/\/+$/, "");
  if (!normalizedPath) {
    return endpoint;
  }
  const endpointWithoutQueryOrFragment = endpoint.split(/[?#]/, 1)[0] ?? endpoint;
  const escapedPath = normalizedPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (new RegExp(`/${escapedPath}$`, "i").test(endpointWithoutQueryOrFragment)) {
    return endpoint;
  }
  return `${endpoint}/${normalizedPath}`;
}

export function stripAnsiEscapeCodes(text) {
  return text.replace(
    // Covers CSI, OSC, and a few other common terminal escape forms.
    /\u001B(?:\][^\u0007]*(?:\u0007|\u001B\\)|\[[0-?]*[ -/]*[@-~]|[@-_])/g,
    "",
  );
}

export function normalizeTerminalSpanAttrs(attrs) {
  const next = { ...attrs };
  delete next.trace_id;
  if ("openclaw.state" in next) {
    next["openclaw.final_state"] = next["openclaw.state"];
    delete next["openclaw.state"];
  }
  if ("openclaw.reason" in next) {
    next["openclaw.final_reason"] = next["openclaw.reason"];
    delete next["openclaw.reason"];
  }
  return next;
}

export function shouldCreateRootForSessionState(state) {
  return state !== "idle";
}

export function shouldSyncRootForSessionState(state) {
  return state === "waiting";
}

export function shouldCloseForSessionState(state) {
  return state === "idle";
}
