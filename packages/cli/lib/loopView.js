/**
 * The live view of one loop round: owns the log buffer, watches
 * `.makefaster/results.json` and `.makefaster/thinking.log`, and repaints the
 * dashboard.
 *
 * Two inputs feed the AGENT THINKING panel, and they answer different questions:
 *   - `.makefaster/thinking.log` is what the agent says it is doing, one tagged
 *     sentence per step (see stepLog.js);
 *   - results.json says what actually happened, and is the only thing trusted
 *     for numbers — every RESULT line, every metric, and every bar comes from
 *     the file, so the panels stay correct even for an agent that reports
 *     nothing at all.
 *
 * The hidden agent's protocol stream deliberately feeds neither. It is still
 * consumed — it is the heartbeat that proves the child is alive, and it is what
 * `eventCount` counts — but a tool-call transcript is not a report, and putting
 * it in the panel drowned the two lines a reader actually wanted.
 */

import { measuredIterations } from "./dashboard.js";
import { watchResults } from "./resultsWatch.js";
import { watchStepLog } from "./stepLog.js";

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
  // Keyed by position in `iterations`, not by how many have been seen: an agent
  // that writes the row first and fills in the numbers on the next write must
  // still get its one RESULT line when the numbers land.
  const announced = new Set();
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

  /**
   * Turn a fresh results.json into the log lines the agent's own report cannot
   * be trusted for: the numbers. One line per measurement, in the same tagged
   * one-sentence shape as everything else in the panel.
   */
  function ingest(next, meta) {
    results = next;
    updatedAt = clockOf(meta?.changedAt ?? now());

    if (!announcedBaseline && next?.baseline) {
      announcedBaseline = true;
      const mode = next.baseline.cold ? "cold" : "warm";
      const lcp = next.baseline[mode]?.lcpMs;
      append("TEST", `Baseline measured (${mode})${Number.isFinite(lcp) ? `: LCP ${Math.round(lcp)}ms` : ""}`);
    }

    // One line per measured iteration, and it names the experiment: the agent
    // has usually already reported `[TRY] <name>`, so repeating that would be a
    // second row saying nothing new — but this line still stands alone for an
    // agent that reports nothing at all.
    //
    // Only measured iterations. A row with no numbers on it has not produced a
    // result yet, and announcing one as `no delta recorded — reverted` reports a
    // miss the agent never measured.
    const star = next?.northStar || "lcp";
    for (const entry of measuredIterations(next)) {
      if (announced.has(entry.position)) continue;
      announced.add(entry.position);
      const parts = [
        Number.isFinite(entry.deltaMs) ? signedMs(entry.deltaMs) : null,
        Number.isFinite(entry.deltaPct) ? signedPct(entry.deltaPct) : null,
      ].filter(Boolean);
      const measured = parts.length > 0 ? `${parts.join(" / ")} on ${star}` : `${star} ${Math.round(entry.value)}ms`;
      const verdict = entry.kept ? "kept" : "reverted, did not beat the noise floor";
      append("RESULT", `${entry.name}: ${measured} — ${verdict}`);
    }
    render();
  }

  const watcher = watchResults({ path: paths.results, onChange: ingest });
  const steps = watchStepLog({
    path: paths.steps,
    onStep: (step) => {
      append(step.tag, step.text);
      render();
    },
  });

  return {
    /**
     * The shape runAgent expects. It counts the protocol stream and remembers
     * the last thing the child said, which is what the non-TUI path prints and
     * what proves the agent is still alive — but nothing from the stream reaches
     * the panel. Progress belongs to the agent's own report; a transcript of
     * `Read File` / `working` / `approved bash` is noise wearing a tag.
     */
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
        const text = typeof entry === "string" ? entry : entry?.text;
        if (text) lastLabel = text;
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
    /**
     * One last poll of both files, so an iteration or a summary written as the
     * agent exited is not missed.
     */
    flush() {
      steps.poll();
      watcher.poll();
      render();
    },
    stop() {
      steps.stop();
      watcher.stop();
    },
  };
}
