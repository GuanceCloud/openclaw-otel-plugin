# Changelog

Current work is recorded by calendar day. Historical entries before the current day are backfilled by week.

## 2026-06-12

### Replay Trace Marking

- Marked replay-only transcript traces with `replay_source=transcript` and `trace_completeness=partial` when a completed request has to be reconstructed without an active runtime trace.
- Marked trajectory-backed reconstructed traces with `replay_source=trajectory` and `trace_completeness=partial` so downstream queries can distinguish replay/backfill traces from normal live runtime traces.

## 2026-06-09

### OSS Install Flow

- Removed the separate `scripts/update.sh` sidecar and reverted OSS delivery back to a single `install.sh` entrypoint for both fresh installs and upgrades.
- Documented `install.sh` as the only OSS install/upgrade execution layer; release publication now uploads `install.sh` together with the versioned and latest archives, without a separate `update.sh`.
- Simplified upgrade usage so `install.sh` now reuses the existing `endpoint`, `X-Token`, install type, and plugin path from `~/.openclaw/openclaw.json` when those flags are omitted.

## 2026-06-05

### Trace Replay Correctness

- Prevented transcript replay from writing a previous request's assistant snapshot into a newer active trace when the session has already queued the next user message, fixing cross-request output mixing inside the same `session_id`.
- Stopped stale transcript update / sweep replay from reopening or duplicating traces when the replay snapshot clearly belongs to an older request window.
- Added an internal per-session request sequence/history so diagnostics events without a stable upstream request key are matched by queued-request lineage and message timing instead of always falling through to the latest active trace.
- Tightened `message.processed` / terminal `session.state` handling so stale completed snapshots no longer close the wrong active trace or attach old output previews to it.
- Removed transcript replay finalization decisions that still depended on `run_id`, so a lagging trajectory `runId` can no longer suppress a newer request window inside the same session.
- Allowed completed transcript snapshots to reconstruct a missing request trace even when no active runtime trace survived, fixing follow-up requests in the same session that previously produced no exported trace after the first round.
- Added trajectory backlog replay for completed runs so multiple follow-up requests completed between periodic sweeps are reconstructed one by one instead of collapsing to only the latest transcript snapshot.
- Persisted per-session trajectory replay source sequence and expanded periodic sweeps to recently updated sessions, preventing missed follow-up traces when transcript update callbacks or diagnostics terminal events are absent.
- Suppressed duplicate exports for the same completed request when transcript/live finalization wins before trajectory terminal lines are flushed, so the later trajectory backlog only advances replay position instead of emitting a second trace.
- Corrected trajectory terminal-source tracking so only `trace.artifacts` / `session.ended` advance replay position; non-terminal `model.completed` lines no longer clear duplicate suppression early and re-emit the same request trace.
- Buffered ended spans by `trace_id` until the request root span closes, so long or stalled requests no longer get split into multiple OTLP trace exports that can appear as duplicate partial traces in downstream UIs.
- Expanded queued-request rotation detection to treat runtime processing / egress lifecycle progress and terminal outcomes as proof that the previous request has already started, so same-session follow-up messages no longer reuse the prior trace when transcript replay is late or incomplete.
- Propagated late-arriving request `runId` values into buffered runtime lifecycle spans, so `channel_ingress`, `session_processing`, and related spans carry the same `run_id` as the request, agent, and model spans even when the identity is only known after those spans ended.
- Stripped stale transcript snapshot `runId` values from processing backfill metadata and made explicit event `runId` win over older primary IDs, preventing same-session follow-up traces from exporting root / lifecycle spans with the previous request's `run_id`.
- Kept active traces closing on terminal `message.processed` / `session.state` events even when the latest transcript snapshot is stale, so stale replay protection no longer leaves buffered roots unexported.
- Stopped auto-emitting `agent_id` and `agent_name` on trace/span attributes and trace debug summaries; explicit `resourceAttributes` / `globalTags` values are still preserved as user-supplied resource tags.
- Normalized trajectory-backed terminal statuses before emitting `final_status`, so upstream `success` values now appear as canonical `completed` in reconstructed traces and request metrics.

## 2026-05-28

### Trace Field Hygiene

- Fixed `agent_runtime` propagation on trace spans and OTEL resources so request, run, model, tool, and runtime spans consistently emit `agent_runtime=openclaw` alongside `agent_version` and `runtime_environment`.
- Removed redundant `event_tool_*` event attributes from tool lifecycle events to reduce empty-field pollution in downstream trace UIs while keeping the span-level tool attrs intact.
- Prevented transcript fallback and runtime/tool replay edge cases from reopening duplicate traces or duplicating tool spans when the same `toolCallId` was already observed.

## 2026-05-27

### Runtime Trace Semantics

- Enabled `output_summary` on `runtime_orchestration` and `channel_egress` spans while keeping `input_preview` and `output_preview` suppressed on runtime lifecycle spans.
- Renamed the planning-oriented `runtime_orchestration` phase from `pre_model` to `agent_plan` so Agent planning intent is clearer without changing any span names.
- Added `tool_provider` and `tool_namespace` on tool spans and tool operation metrics so MCP-backed tools can be queried without introducing a separate `mcp:*` span type.
- Added `tool_mcp_name` and bundle-name MCP inference on `tool:*` spans so wrappers such as `owl__exec_tool` also expose the backing MCP server and concrete MCP tool name.
- Added `tool_mcp_host` on MCP-backed tool spans and metrics, derived from configured `mcp.servers.<name>.url` and limited to the URL host only.

## 2026-05-21

### Trace Semantics

- Added `request_type`, `request_category`, and `is_internal_request` trace tags so normal user requests can be distinguished from OpenClaw internal control flows such as `Continue the OpenClaw runtime event.` and heartbeat traffic.
- Fixed `final_status` resolution for `agent_run` / `openclaw_request` close paths so trajectory-backed terminal outcomes such as `success` now map to canonical statuses like `completed` instead of falling back to `idle`.

## 2026-05-19

### OSS Release Delivery

- Restored `output/install.sh` and added `output/SKILL.md` to the release output so the OSS install entrypoint and installer stay versioned with the plugin release.
- Updated the GTrace skill to pass its `OSS_ENDPOINT` through to the installer, so the installer downloads packages from the same OSS location as the skill.
- Changed installer usage, log, and error messages to English.
- Removed the hardcoded default download host from `install.sh`; callers must pass `OSS_ENDPOINT`.

## 2026-05-18

### Documentation

- Simplified README and README_ZH install guidance around GTrace skill installation and manual OTLP configuration.
- Removed repository-managed `install.sh` / `update.sh` from the documented install and release workflow; the supported paths are now GTrace skill installation plus source/manual OTLP setup.

## 2026-05-15

### OSS Release Delivery

- Changed `latest` installs to download the unversioned `openclaw-otel-plugin.tar.gz` package while keeping versioned installs on `openclaw-otel-plugin-vX.Y.Z.tar.gz`.
- Added release output copies for the latest tarball and matching `.sha256` files for OSS publication.
- Made GTrace the default installer profile, with `--type otlp` retained as the explicit standard OTLP receiver switch.

### Trace Replay And Run Scope

- Persisted transcript replay finalization watermarks across restarts so completed historical sessions are not replayed into duplicate traces after the plugin or gateway restarts.
- Fixed completed runtime sessions so they now persist replay finalization state too; later transcript updates or sweep replays no longer regenerate a second trace for the same session/run after the original trace has already closed.
- Fixed transcript-derived cache token accounting so cumulative provider cache counters are normalized back into per-call `usage_cache_read_input_tokens` / `usage_cache_write_input_tokens`, and aggregate cache totals now sum those per-call deltas instead of replaying cumulative snapshots.
- Fixed missing `run_id` / `run_ids` propagation on normal tool, skill, transcript tool, transcript model, and synthetic model spans so runtime and replay paths now carry the same run correlation tags.
- Fixed `final_status` on `agent_run` / `openclaw_request` when a run only closes via `session.state=idle`, so completed runs no longer end with an empty terminal status if `message.processed` never arrived.
- Normalized `llm` token usage to per-call `input` / `output` plus separate cache read/write fields.
- Restored per-call `usage_total_tokens` on `llm` spans as `input + output`, and restored per-call `usage_cache_total_tokens` on `llm` spans as `cache read + cache write`.
- Tightened `session.state` close handling so the current `run_id` is marked finalized even when the transcript snapshot has not yet observed `runCompleted=true`, preventing a late transcript replay from reopening the same run as a second trace.
- Excluded internal OpenClaw heartbeat poll / `HEARTBEAT_OK` traffic from runtime request tracing, so heartbeat health checks no longer appear as duplicate user traces.
- Normalized `session_create_at` / `session_updated_at` on summary spans, removed the leaked `session_updatedAt` legacy field, and kept zero-valued summary token attrs on `openclaw_request` / `agent_run` instead of dropping them.
- Guarded `message.processed` replay against stale transcript snapshots from an older request, so a new queued message no longer emits `0 ns` ghost traces by replaying the previous request's transcript or synthetic model span.

## 2026-05-14

### Trace Debugging

- Fixed transcript fallback replay so snapshot-backed spans now carry `run_id` when a run is reconstructed from session transcript state.
- Fixed transcript-replayed `llm` spans so per-turn token usage is written back onto trace attrs, transcript-only runs now accumulate token totals onto `agent_run` / `openclaw_request` summary spans, and runtime-covered model turns are not double-counted during replay.
- Added `usage_cache_total_tokens` trace tag as the sum of `usage_cache_read_input_tokens` and `usage_cache_write_input_tokens`.
- Restored request trace grouping to session/request lineage instead of forcing one trace per `run_id`, while keeping `run_id` on emitted spans for correlation.
- Preserved the first `run_id` on request / run summary spans when a request triggers multiple internal runs, and added `run_ids` as the ordered aggregate of every observed run id on that trace.
- Simplified trace payload debugging back to a single `tracePayloadDebugEnabled` switch so enabling debug always logs the full exported payload.
- Extended trace export payload debug logs to include `run_id` alongside `trace_id`, `span_id`, and `parent_id`.

## 2026-05-12

### Installation Flow

- Fixed installer cleanup so successful installs no longer end with `tmp_dir: 未绑定的变量`.
- Bundled a CommonJS runtime entrypoint at `dist/index.cjs` for release/runtime use.
- The installer now links the host `openclaw` package into the plugin directory under `node_modules/openclaw`, so release installs reuse the local OpenClaw runtime instead of bundling the full host package into the plugin artifact.
- Added installer parameters for GTrace:
  - `--type gtrace`
  - `--endpoint`
  - `--x-token`
  - `--tag key=value`
- When `--type gtrace` is used, the installer now writes the following defaults:
  - `tracePath = v1/write/otel-llm`
  - `metricsPath = v1/write/otel-metrics`
  - `logsEnabled = false`
  - `logsPath = v1/write/otel-logs`
  - `headers.to_headless = true`
- When `--type gtrace` is used, the installer also removes `app_name` and `app_id` from the default `resourceAttributes`.
- `--type gtrace` now requires both `endpoint` and `X-Token`.
- Every `--tag key=value` is merged into `resourceAttributes`.
- Updated README and README_ZH quick-install examples to use safer chained commands.

### OTEL Metric Alignment

- Kept `gen_ai.client.token.usage` and `gen_ai.client.operation.duration` as OTEL-native metric names in documentation only; the plugin no longer writes custom token or operation data into the `gen_ai.client.*` namespace.
- Added `gen_ai.agent.request.token.input`, `gen_ai.agent.request.token.output`, and `gen_ai.agent.request.token.total` for per-request token totals emitted once when a request finishes.
- Added `gen_ai.agent.token.usage` as the plugin-owned model token usage histogram for runtime `model.usage` events and transcript / synthetic fallback replay.
- Removed legacy `openclaw.*` metric dual-write emission, keeping current reporting on the `gen_ai.client.*`, `gen_ai.agent.*`, and `gen_ai.runtime.*` namespaces.
- Added `gen_ai.agent.operation.count` and `gen_ai.agent.operation.duration` for model/tool/skill operation reporting, and removed the temporary dual-write to `gen_ai.client.operation.duration`.

## 2026-05-11

### GenAI Metrics And Tags

- Promoted `gen_ai.client.*`, `gen_ai.agent.*`, and `gen_ai.runtime.*` as the current recommended metric namespaces.
- Split session token aggregation into dedicated counters:
  - `gen_ai.agent.session.token.input`
  - `gen_ai.agent.session.token.output`
  - `gen_ai.agent.session.token.total`
- Normalized trace and metric correlation fields to canonical names such as `session_id`, `session_key`, `channel`, `provider_name`, and `request_model`.
- Removed `gen_ai.*` trace tag alias dual-write and kept canonical query fields only.
- Changed `gen_ai.client.operation.duration.operation_name` semantics to `model` / `tool` / `skill`, so tool and skill durations can be queried separately.
- Added `model_name` attribution to `operation_name=tool` so tool metrics can be correlated with the upstream model choice.

### Session And Tooling Semantics

- Fixed session total token aggregation so transcript `totalTokens` snapshots are not double-counted as cumulative totals.
- Backfilled `session_id`, `session_key`, and `channel` onto tool and skill spans when runtime events do not carry them directly.
- Unified runtime lifecycle span session resolution so lifecycle spans follow the canonical session identity.

### Packaging And Documentation

- Added release packaging, install, and update scripts for the plugin delivery workflow.
- Added `BUILDING.md` and repo-level `AGENTS.md`.
- Updated README and README_ZH to focus on current `gen_ai.*` telemetry naming and plugin installation guidance.

## 2026-05-07

### Session Metrics

- Switched session token aggregation to runtime `model.usage` events so `openclaw.session.tokens.*` no longer depends on transcript `message.usage`.
- Kept `openclaw.session.traces` on session transcript counting while preserving periodic export for active sessions.

### Trace Model

- Switched request scoping from session-level reuse to one trace per inbound user message.
- Fixed repeated `message.queued` handling so a pending run is reused instead of starting a duplicate trace.
- Added replay watermarks so the same transcript is only finalized once across `message.processed` and trailing `session.state idle` events.
- Made the model span mandatory when transcript metadata already includes `provider` and `model`, even if runtime `model.usage` is missing.
- Renamed model span resources to the fixed name `llm` instead of embedding `provider/model` in the span name.
- Switched transcript replay from one synthetic span per run to one `llm` per assistant turn, so multi-tool sessions show `model -> tool -> model` loops correctly.
- Moved per-turn transcript replay to `message.processed` first and kept `session.state idle` as a fallback-only close path.

### Runtime Lifecycle

- Added explicit runtime lifecycle spans for `channel_ingress`, `dispatch_queue`, `session_processing`, `runtime_orchestration`, and `channel_egress`.
- Split queue wait from execution time so request spans can start near the real ingress timestamp while queued work is shown separately.
- Removed standalone queue and heartbeat traces, keeping those diagnostics in metrics and logs instead.

### Skill And Tool Coverage

- Added transcript-backed skill inference for dashboard-style tool activity.
- Added `skill_call` wrapping for tool invocations such as `edit` in addition to `write` and `exec`.
- Preserved `openclaw.skill.*` attributes alongside normalized skill aliases so downstream filters can query skill names directly.

### Tooling And Tests

- Added regression coverage for request reuse, replay watermark deduplication, and transcript-first `message.processed` replay.
- Updated README and README_ZH to reflect the current trace naming and lifecycle span behavior.

## 2026-05-06

### Session Metrics

- Added session-scoped metrics with `session_id` tagging:
  - `openclaw.session.tokens.input`
  - `openclaw.session.tokens.output`
  - `openclaw.session.tokens.total`
  - `openclaw.session.traces`
- Switched session metrics from run-end emission to a scanner that only tracks active sessions on the `30s` cadence.
- Report session counters as scan-time deltas derived from transcript-backed cumulative totals, so repeated scans do not double count.

### Metrics Export

- Changed the default metrics export interval from `15s` to `30s`.
- Updated README and README_ZH examples and config reference to reflect the new default export interval and session metric behavior.

## 2026-04-28

### Trace Model

- Fixed root span naming to `openclaw_request`.
- Fixed run span naming to `agent_run`.
- Removed `assistant_message` span from the runtime model.
- Renamed runtime reasoning span from `assistant_thinking` to `thinking`.
- Changed `thinking` span attributes:
  - `span.kind` is now `thinking`
  - `session_channel` replaces the old `channel` field on the `thinking` span
  - `output_summary` replaces the old reasoning preview field
  - `output_text_length` replaces the old reasoning length field

### Fallback Behavior

- Added transcript-based fallback emission for `thinking` spans when `message.processed` is missing.
- Added transcript-based fallback emission for tool spans when runtime tool events are missing.
- Kept transcript-derived model span fallback for environments that only emit coarse session lifecycle events.

### Tooling And Tests

- Added regression coverage for transcript-driven `thinking` span emission.
- Added regression coverage for replaying transcript tool calls into synthetic tool spans.
- Updated README and README_ZH to reflect the current trace naming and span behavior.
- Backfilled older changelog entries into weekly summaries.

## Week of 2026-04-20

### Docs And Naming

- Added Dataway-oriented configuration examples and follow-up README refinements.
- Renamed session key channel-related fields for clearer normalized trace attributes.
- Continued README cleanup and usage guidance improvements.

### Session And Multi-Agent Support

- Fixed multi-agent session metadata alignment so traces can carry more accurate session context.

## Week of 2026-04-13

### Exporters And Resource Attributes

- Added configurable metrics and logs exporters.
- Unified resource attribute configuration and compatibility aliases.
- Improved exporter-side observability for OTLP delivery behavior.

### Session Tags

- Extracted structured tags from session keys, including session namespace, channel, agent, scope, and target.

## Week of 2026-04-06

### Service Architecture

- Split the OTEL plugin service into clearer modules.
- Stabilized skill tracing behavior and made trace path configuration explicit.

### Trace Semantics

- Added skill call spans in addition to summary skill spans.
- Normalized OTEL field mapping and improved support for global tags.

## Week of 2026-03-23

### OpenClaw Runtime Coverage

- Enriched OpenClaw tool trace telemetry.
- Added support for newer OpenClaw diagnostics metrics.

### Documentation

- Added bilingual README support with English and Chinese copies.

## Week of 2026-03-16

### Project Bootstrap

- Initialized the OpenClaw OTEL plugin repository and baseline implementation.
- Added early installation, build, and gateway restart guidance.
- Iterated on initial README and endpoint examples.
