/**
 * Regression: SGLang builds whose token counters only flush when a request
 * finishes (VM100 5217, sglang 0.0.0.dev1+gdcbe3e58) must not report a finished
 * request's whole token count as a live rate.
 *
 * Observed symptom: the dashboard read `dec 0.0` for a whole generation, then
 * one line with `dec 2893 pre 152477` the moment the request ended (the engine
 * had really been decoding at ~130-200 tok/s). The engine's own per-step number
 * lives in internal_states[].last_gen_throughput and in the sglang:gen_throughput
 * gauge; both are live, and both must win over the counter deltas.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { LlmProbe } from "../LlmProbe.js";

const L = '{engine_type="unified",model_name="qwen38-flash-next"}';

function prom({ gen, prompt, requests, gauge = null, cached = null }) {
  const lines = [
    `sglang:generation_tokens_total${L} ${gen}`,
    `sglang:prompt_tokens_total${L} ${prompt}`,
    `sglang:num_requests_total${L} ${requests}`,
  ];
  if (gauge != null) lines.push(`sglang:gen_throughput${L} ${gauge}`);
  if (cached != null) {
    lines.push(`sglang:cached_tokens_total{engine_type="unified",cache_source="device"} ${cached}`);
  }
  return `${lines.join("\n")}\n`;
}

function busyProbe() {
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 5217);
  probe.requestsRunning = 1;
  probe.slotsActive = 1;
  probe.requestsWaiting = 0;
  return probe;
}

/** One poll exactly as LlmProbe._probeOpenAiCompatible does it: JSON first, then /metrics. */
function poll(probe, serverInfo, promText, dt = 1) {
  probe._applySglangServerInfo(serverInfo, dt);
  probe._applySglangMetrics(promText, dt);
}

test("the engine's per-step throughput is preferred over a bursty counter delta", () => {
  const probe = busyProbe();
  // First Prometheus poll: counters are seeded, nothing is published from them.
  poll(
    probe,
    { internal_states: [{ last_gen_throughput: 131.4 }] },
    prom({ gen: 98952, prompt: 5096590, requests: 55, gauge: 131.4 })
  );
  assert.equal(probe.generationTps, 131.4, "live rate on the first poll");
  assert.equal(probe.prefillTps, 0, "the first poll publishes no counter-derived prefill");

  // A second poll with nothing finished: still live, still sane.
  poll(
    probe,
    { internal_states: [{ last_gen_throughput: 168.1 }] },
    prom({ gen: 98952, prompt: 5096590, requests: 55, gauge: 168.1 })
  );
  assert.equal(probe.generationTps, 168.1);

  // A request finishes: the counters dump its whole prompt + output. That is a
  // request total, not a rate — it must not become tok/s.
  poll(
    probe,
    { internal_states: [{ last_gen_throughput: 171.9 }] },
    prom({ gen: 98952 + 8189, prompt: 5096590 + 306137, requests: 57, gauge: 171.9, cached: 151744 })
  );
  assert.equal(probe.generationTps, 171.9, "decode stays the engine's live rate");
  assert.equal(probe.prefillTps, 0, "a finished request is not a prefill rate");
  assert.equal(probe.cachedPrefillTps ?? 0, 0, "the cached split is suppressed in that window");
  assert.equal(probe.uncachedPrefillTps ?? 0, 0);
  assert.equal(probe.totalOutputTokens, 98952 + 8189, "the lifetime total still advances");
});

test("builds with live counters keep the delta path when no live rate exists", () => {
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8888);
  probe.requestsRunning = 1;
  probe.slotsActive = 1;
  // No JSON field and no gauge: fall back to the counter delta as before.
  probe._applySglangMetrics(prom({ gen: 1000, prompt: 500, requests: 3 }), 1);
  probe._applySglangMetrics(prom({ gen: 1200, prompt: 520, requests: 3 }), 1);
  assert.equal(probe.generationTps, 200, "200 tokens in 1 s is the reported rate");
  assert.ok(probe.prefillTps > 0, "prefill still comes from the prompt counter on such builds");
});

test("only the JSON field present: the counters cannot override it", () => {
  const probe = busyProbe();
  probe._applySglangServerInfo({ internal_states: [{ last_gen_throughput: 150 }] }, 1);
  probe._applySglangMetrics(prom({ gen: 1000, prompt: 500, requests: 3 }), 1);
  probe._applySglangMetrics(prom({ gen: 9000, prompt: 400000, requests: 5 }), 1);
  assert.equal(probe.generationTps, 150, "no gauge in the text — the JSON rate still wins");
  assert.equal(probe.prefillTps, 0);
});
