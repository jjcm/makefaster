/**
 * The live view of one loop round: owns the log buffer, watches
 * `.makefaster/results.json`, and repaints the dashboard.
 *
 * Two inputs feed it, and they answer different questions:
 *   - the hidden agent's event stream says what the agent is doing right now
 *     (OBSERVE / PLAN / EXECUTE / TEST lines);
 *   - results.json says what actually happened, and is the only thing trusted
 *     for numbers — every RESULT and COMPARE line, every metric, and every bar
 *     comes from the file, so the panels stay correct even for an agent that
 *     streams nothing at all.
 */

import { watchResults } from "./resultsWatch.js";

const MAX_LOG_ENTRIES = 500;

function clockOf(date) {
  return date.toTimeString().slice(0, 8);
}

function signedMs(value) {
  return `${value > 0 ? "+" : ""}${Math.round(value)}ms`;
}

function signedPct(value) {
  const rounded = Math.round(value * 10) / 10;
  return `${rounded > 0 ? "+" : ""}${rounded}%`;
}

/**
 * @param {object} args
 * @param {{render: (model: object) => void}} args.tui
 * @param {{results: string}} args.paths
 * @param {object} args.state
 * @param {object} args.provider
 * @param {object|null} args.model
 * @param {() => Date} [args.now] test seam
 */
export function createLoopView({ tui, paths, state, provider, model, now = () => new Date() }) {
  const log = [];
  let results = null;
  let updatedAt = null;
  let status = "RUNNING";
  let seenIterations = 0;
  let announcedBaseline = false;
  let eventCount = 0;
  let lastLabel = null;

  function append(tag, text) {
    if (!text) return;
    const previous = log[log.length - 1];
    if (previous && previous.tag === tag && previous.text === text) return; // no repeated rows
    log.push({ time: clockOf(now()), tag, text });
    if (log.length > MAX_LOG_ENTRIES) log.splice(0, log.length - MAX_LOG_ENTRIES);
  }

  function render() {
    tui.render({ results, log, state, provider, model, status, updatedAt });
  }

  /** Turn a fresh results.json into the log lines the stream cannot provide. */
  function ingest(next, meta) {
    results = next;
    updatedAt = clockOf(meta?.changedAt ?? now());

    if (!announcedBaseline && next?.baseline) {
      announcedBaseline = true;
      const mode = next.baseline.cold ? "cold" : "warm";
      const lcp = next.baseline[mode]?.lcpMs;
      append("OBSERVE", `baseline measured (${mode})${Number.isFinite(lcp) ? `: LCP ${Math.round(lcp)}ms` : ""}`);
    }

    const iterations = Array.isArray(next?.iterations) ? next.iterations : [];
    for (const iteration of iterations.slice(seenIterations)) {
      append("HYPOTHESIS", iteration?.name || "unnamed experiment");
      if (iteration?.description) append("PLAN", iteration.description);
      const parts = [
        Number.isFinite(iteration?.deltaMs) ? signedMs(iteration.deltaMs) : null,
        Number.isFinite(iteration?.deltaPct) ? signedPct(iteration.deltaPct) : null,
      ].filter(Boolean);
      append("RESULT", parts.length > 0 ? `measured ${parts.join(" / ")} on ${next?.northStar || "lcp"}` : "measured, no delta recorded");
      append("COMPARE", iteration?.kept === true ? "beat the noise floor — kept, new best candidate" : "did not beat the noise floor — reverted");
    }
    seenIterations = iterations.length;
    render();
  }

  const watcher = watchResults({ path: paths.results, onChange: ingest });

  return {
    /** The shape runAgent expects, so the stream lands in the log panel. */
    reporter: {
      get eventCount() {
        return eventCount;
      },
      get lastLabel() {
        return lastLabel;
      },
      update(entry) {
        eventCount += 1;
        if (!entry) return;
        const { tag, text } = typeof entry === "string" ? { tag: "EXECUTE", text: entry } : entry;
        lastLabel = text;
        append(tag, text);
        render();
      },
      done() {
        render();
      },
    },
    append,
    render,
    get log() {
      return log;
    },
    get results() {
      return results;
    },
    setStatus(next) {
      status = next;
      render();
    },
    /** One last poll, so an iteration written as the agent exited is not missed. */
    flush() {
      watcher.poll();
      render();
    },
    stop() {
      watcher.stop();
    },
  };
}
