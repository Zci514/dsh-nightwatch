/**
 * `nightwatch` — keep one session working until a wall-clock deadline.
 *
 * The harness stops after a single turn: a session only ever continues when a
 * new user message arrives. This plugin supplies that message on a clock, so a
 * session can be told "keep going until 22:30" and then be left alone.
 *
 * Two independent triggers open the next turn, because either one alone leaves
 * a hole:
 * - `session/event` `turn/end` — the normal case: a turn finished, the next one
 *   is opened once the session is idle again.
 * - an idle sweep — the safety net: a session that reached idle without a
 *   usable `turn/end` (armed while already idle, a rejected follow-up, a
 *   reload, a truncation another plugin already answered) is picked up on the
 *   next tick.
 *
 * Nothing is sent after the deadline. A turn already in flight runs to its own
 * end by default; `graceMs > 0` turns the deadline into a hard cut.
 *
 * Deliberately dependency-free apart from `node:` builtins. A profile plugin is
 * loaded from a directory where the harness packages do not resolve, so the
 * continuation message is built locally, the command definition id is a plain
 * brand string, and `Config` implements the Standard-Schema contract by hand
 * instead of pulling in `@deepseek-ai/schemastery`.
 *
 * @module dsh-nightwatch
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  DEFAULTS,
  RUN_SOURCE_KIND,
  armingSnapshot,
  clockLabel,
  describeArming,
  decide,
  decideHeartbeat,
  parseDeadline,
  parseHint,
  readSettings,
  remainingLabel,
  renderContinueText,
  shouldForget,
  stopReasonLabel,
  SHOW_WORDS,
  STOP_WORDS,
} from './policy.js';

export const name = 'nightwatch';

/**
 * `commands` is deliberately absent: it is registered through `ctx.inject`, so
 * a composition without the command service still gets the watchdog.
 */
export const inject = ['agents'];

/**
 * Config schema in the Standard-Schema shape the loader speaks.
 *
 * `validate` returns the *normalised* settings, so `apply()` receives clamped
 * numbers and bounded strings and never has to re-check a field.
 */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-nightwatch',
    validate(input) {
      if (input === null || typeof input !== 'object') {
        return { issues: [{ message: 'nightwatch config must be an object' }] };
      }
      return { value: readSettings(input) };
    },
  },
};

/** Directory that also holds `.credentials.yaml` and `.env`. */
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh');
const STATE_FILE = join(DSH_HOME, 'nightwatch.json');
/** State file written by 1.1.0, still read once when the new one is empty. */
const LEGACY_STATE_FILE = join(DSH_HOME, 'run-until.json');
/**
 * How long a finished arming record is kept in memory.
 *
 * A record is tiny, but one is created per session ever armed and this process
 * can stay up for weeks; anything that stopped more than this long ago is of no
 * use to anyone (the transcript is the record of what happened).
 */
const STATE_TTL_MS = 10 * 60_000;

/** Freeze a message graph the way `createUserMessage` does. */
function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

/**
 * Build the host-originated user message that opens one more turn.
 *
 * The source kind is a harness-owned kind, never `'user'`: that kind carries
 * human authority, and a loop able to answer its own approval prompts is not a
 * loop worth leaving running overnight.
 */
function buildMessage(text, state) {
  return deepFreeze({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: {
      kind: RUN_SOURCE_KIND,
      runUntil: { deadline: state.deadline, round: state.rounds + 1 },
    },
  });
}

/** True when the agent exists, is idle, and has nothing queued. */
function isIdle(agent) {
  return (
    agent !== undefined &&
    agent.status === 'idle' &&
    agent.inbox.nextTurn.length === 0 &&
    agent.inbox.nextStep.length === 0
  );
}

/**
 * Read one persisted arming table.
 *
 * A missing or corrupt file means "nothing was armed"; a failed read must never
 * stop the plugin from loading.
 *
 * @param file - the state file to read.
 * @returns the normalised `sessionId -> arming` table (possibly empty).
 */
function readStateFile(file) {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    if (raw === null || typeof raw !== 'object' || raw.version !== 1) return {};
    const armings = raw.armings;
    if (armings === null || typeof armings !== 'object') return {};
    const out = {};
    for (const [sessionId, value] of Object.entries(armings)) {
      if (value === null || typeof value !== 'object') continue;
      const deadline = Number(value.deadline);
      if (!Number.isFinite(deadline) || deadline <= 0) continue;
      out[sessionId] = {
        deadline,
        armedAt: Number.isFinite(Number(value.armedAt)) ? Number(value.armedAt) : Date.now(),
        rounds: Number.isFinite(Number(value.rounds)) ? Number(value.rounds) : 0,
      };
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Load the arming table, falling back to the pre-1.2.0 file exactly once.
 *
 * The old file is only consulted when the new one holds nothing, so a real
 * table is never shadowed by a stale copy. Nothing is deleted: a rollback to
 * 1.1.0 still finds its own state file untouched.
 *
 * @returns `{ armings, migrated }` — `migrated` asks the caller to persist.
 */
function loadState() {
  const current = readStateFile(STATE_FILE);
  if (Object.keys(current).length > 0) return { armings: current, migrated: false };
  const legacy = readStateFile(LEGACY_STATE_FILE);
  if (Object.keys(legacy).length > 0) return { armings: legacy, migrated: true };
  return { armings: {}, migrated: false };
}

/** Rewrite the persisted arming table from the live states plus unclaimed armings. */
function saveState(states, pending) {
  const armings = {};
  for (const [sessionId, state] of states) {
    if (!(state.deadline > 0)) continue;
    armings[sessionId] = { deadline: state.deadline, armedAt: state.armedAt, rounds: state.rounds };
  }
  // Armings whose session has not been loaded yet are still ours to keep: a
  // persist triggered by some other session must not silently drop them.
  for (const [sessionId, entry] of Object.entries(pending)) {
    if (armings[sessionId] !== undefined) continue;
    if (!(entry.deadline > 0) || entry.deadline <= Date.now()) continue;
    armings[sessionId] = { deadline: entry.deadline, armedAt: entry.armedAt, rounds: entry.rounds };
  }
  // Written to a sibling then renamed: `rename` is atomic within a volume, so a
  // crash mid-write can never leave a half-written table behind. Without this a
  // torn file reads back as "nothing was armed" and every watch is lost.
  const scratch = `${STATE_FILE}.tmp`;
  try {
    mkdirSync(dirname(STATE_FILE), { recursive: true });
    writeFileSync(scratch, `${JSON.stringify({ version: 1, armings }, null, 2)}\n`, 'utf8');
    renameSync(scratch, STATE_FILE);
  } catch {
    // Persistence is a convenience, never a reason to break a live run.
  }
}

/**
 * Register the deadline watchdog, the `/nightwatch` command, and the button
 * routes.
 *
 * @param ctx - the cordis context this plugin is mounted on.
 * @param config - the normalised settings produced by {@link Config}.
 */
export function apply(ctx, config) {
  const settings = () => readSettings(config);
  const logger = () => {
    try {
      return ctx.logger('nightwatch');
    } catch {
      return console;
    }
  };
  const info = (message) => {
    try {
      logger().info?.(message);
    } catch {
      // Logging never breaks a run.
    }
  };

  /** sessionId -> live arming record. */
  const states = new Map();
  const boot = loadState();
  /** sessionId -> persisted arming awaiting its session to reappear. */
  const restored = boot.armings;

  let disposed = false;
  let heartbeat;
  let persistenceQueued = false;

  if (boot.migrated) {
    // 1.1.0 stored armings in `run-until.json`. Fold them into the new file on
    // the first start so the old one stops being consulted, and leave the old
    // file on disk so a rollback to 1.1.0 still finds its own state.
    info(`migrated ${Object.keys(restored).length} arming(s) from run-until.json`);
    persist();
  }

  /** Look up one state, rehydrating a persisted arming on first sight. */
  function ensure(sessionId) {
    const existing = states.get(sessionId);
    if (existing !== undefined) return existing;
    const state = {
      sessionId,
      deadline: 0,
      armedAt: 0,
      rounds: 0,
      lastSendAt: 0,
      consecutiveErrors: 0,
      idleRounds: 0,
      sawTool: false,
      pending: false,
      expired: false,
    };
    const saved = restored[sessionId];
    delete restored[sessionId];
    if (saved !== undefined && saved.deadline > Date.now()) {
      state.deadline = saved.deadline;
      state.armedAt = saved.armedAt;
      state.rounds = saved.rounds;
      info(`re-armed session ${sessionId.slice(0, 8)} until ${clockLabel(saved.deadline)}`);
    }
    states.set(sessionId, state);
    return state;
  }

  /** Persist on the next microtask so a burst of edits writes once. */
  function persist() {
    if (persistenceQueued) return;
    persistenceQueued = true;
    queueMicrotask(() => {
      persistenceQueued = false;
      if (!disposed) saveState(states, restored);
    });
  }

  /** Drop the arming and record why. */
  function disarm(state, why) {
    if (!(state.deadline > 0)) return;
    state.deadline = 0;
    state.expired = true;
    state.pending = false;
    // When it stopped, so the sweep can tell a finished watch from an active
    // one without keeping finished records forever.
    state.goneAt = Date.now();
    persist();
    info(`stopped session ${state.sessionId.slice(0, 8)}: ${stopReasonLabel(why)}`);
  }

  /**
   * Open one more turn for an armed session.
   *
   * The follow-up is appended only after `whenIdle()`: this is usually called
   * from a `turn/end` handler, where that append is still in progress, and
   * `Session.append` rejects a reentrant append.
   */
  async function send(state, why) {
    if (state.pending || !(state.deadline > 0) || disposed) return;
    state.pending = true;
    try {
      const s = settings();
      const agent = ctx.agents.get(state.sessionId);
      if (agent === undefined) {
        disarm(state, 'orphaned');
        return;
      }
      await agent.whenIdle();
      if (disposed || !(state.deadline > 0)) return;
      const now = Date.now();
      if (now >= state.deadline) {
        disarm(state, 'deadline');
        return;
      }
      const wrapping = state.deadline - now <= s.wrapUpMinutes * 60_000;
      const template = wrapping ? s.wrapUpText : s.continueText;
      agent.followup(
        buildMessage(renderContinueText(template, { now, deadline: state.deadline }), state),
      );
      state.rounds += 1;
      state.lastSendAt = now;
      persist();
      info(`continued session ${state.sessionId.slice(0, 8)} (${why})`);
    } catch (error) {
      logger().error?.(error);
    } finally {
      state.pending = false;
    }
  }

  /**
   * Move persisted armings whose session is already loaded into the live table.
   *
   * Without this a restart would leave the arming stranded in `restored`: only
   * `turn/end` and the command rehydrate a state, and a session that is being
   * restored after a crash has neither. The sweep is the one place that runs on
   * its own, so it does the promotion.
   */
  function adoptRestored() {
    const now = Date.now();
    let dropped = false;
    for (const sessionId of Object.keys(restored)) {
      if (restored[sessionId].deadline <= now) {
        delete restored[sessionId];
        dropped = true;
        continue;
      }
      if (ctx.agents.get(sessionId) !== undefined) ensure(sessionId);
    }
    if (dropped) persist();
  }

  /** One watchdog pass over every armed session. */
  function sweep() {
    if (disposed) return;
    adoptRestored();
    const s = settings();
    const now = Date.now();
    for (const state of states.values()) {
      if (!(state.deadline > 0)) continue;
      const agent = ctx.agents.get(state.sessionId);
      const verdict = decideHeartbeat({ settings: s, state, now, idle: isIdle(agent) });
      if (verdict.action === 'send') {
        void send(state, verdict.why);
        continue;
      }
      if (verdict.action !== 'stop') continue;
      const deadline = state.deadline;
      disarm(state, verdict.why);
      if (
        verdict.why === 'deadline' &&
        s.graceMs > 0 &&
        agent !== undefined &&
        agent.status === 'running' &&
        now >= deadline + s.graceMs
      ) {
        try {
          agent.cancel({ kind: 'user' });
        } catch (error) {
          logger().error?.(error);
        }
      }
    }
    // Forget records that have nothing left to do; the rule lives in policy.js
    // so it is testable without a host.
    for (const [sessionId, state] of states) {
      if (shouldForget({ state, now, ttlMs: STATE_TTL_MS })) states.delete(sessionId);
    }
  }

  /** Re-arm the sweep timer, re-reading `heartbeatMs` so a live edit applies. */
  function scheduleSweep() {
    if (disposed) return;
    heartbeat = setTimeout(() => {
      heartbeat = undefined;
      try {
        sweep();
      } catch (error) {
        logger().error?.(error);
      } finally {
        scheduleSweep();
      }
    }, settings().heartbeatMs);
    heartbeat.unref?.();
  }

  /**
   * Arm (or re-arm) one session from a raw time expression.
   *
   * Shared by the slash command and the composer button, so both paths can
   * never drift apart on validation, reset, or persistence.
   *
   * @param state - the session's live arming record.
   * @param raw - the user's time expression.
   * @param now - current epoch-ms.
   * @returns `{ ok: true, text }` or `{ ok: false, text }`.
   */
  function armSession(state, raw, now) {
    const s = settings();
    const parsed = parseDeadline(raw, now);
    if (!parsed.ok) {
      const why =
        {
          empty: '没给时间',
          'offset-invalid': '偏移量写法不对',
          'date-invalid': '日期不合法',
          'clock-out-of-range': '钟点超范围',
          'clock-invalid': '钟点不合法',
          unrecognised: '认不出这个写法',
        }[parsed.reason] ?? parsed.reason;
      return {
        ok: false,
        text: [`看不懂这个时间：「${raw}」（${why}）`, '', parseHint(now)].join('\n'),
      };
    }

    const replacing = state.deadline > 0;
    state.deadline = parsed.at;
    state.armedAt = now;
    state.rounds = 0;
    state.lastSendAt = 0;
    state.consecutiveErrors = 0;
    state.idleRounds = 0;
    state.sawTool = false;
    state.pending = false;
    state.expired = false;
    persist();
    info(`armed session ${state.sessionId.slice(0, 8)} until ${clockLabel(parsed.at)}`);

    return {
      ok: true,
      text: [
        `${replacing ? '守夜已改到' : '守夜已开启'}：${clockLabel(parsed.at)}`
          + `${parsed.rolled === true ? '（明天）' : ''}`,
        `还有 ${remainingLabel(now, parsed.at)}`,
        `停止条件：到点${s.maxRounds > 0 ? `、${s.maxRounds} 轮` : ''}`
          + `${s.maxIdleRounds > 0 ? `、连续 ${s.maxIdleRounds} 轮没动手` : ''}`
          + `、连续出错 ${s.maxConsecutiveErrors} 次`,
        '',
        '现在直接说要做什么就行；每轮结束会自动接上，到点就不再开口。',
      ].join('\n'),
    };
  }

  /** Stop one session's watch; returns a one-line human result. */
  function stopSession(state, now) {
    if (!(state.deadline > 0)) return { ok: false, text: '守夜本来就没开着。' };
    const rounds = state.rounds;
    disarm(state, 'disarmed');
    return { ok: true, text: `守夜已停（${clockLabel(now)}）。已续跑 ${rounds} 轮。` };
  }

  ctx.on('session/event', (session, event) => {
    // A turn that called no tool changed nothing on disk. Counting those makes
    // the "model politely agrees and does nothing" loop stop by itself instead
    // of billing a full context window per round until the deadline.
    if (event.type === 'tool/call') {
      const state = states.get(session.id);
      if (state !== undefined) state.sawTool = true;
      return;
    }

    if (disposed || event.type !== 'turn/end') return;
    const agent = ctx.agents.get(session.id);
    if (agent === undefined || agent.session !== session) return;
    // Only a session that is armed (or has a persisted arming to rehydrate) owns
    // a record: creating one for every session that ever ended a turn would
    // grow this map for the whole life of the process.
    const known = states.get(session.id);
    const state =
      known !== undefined
        ? known
        : restored[session.id] !== undefined
          ? ensure(session.id)
          : undefined;
    if (state === undefined || !(state.deadline > 0)) return;

    const s = settings();
    // The session publishes `{type, seq, time, data}` and keeps the payload —
    // including the turn-end reason — under `data`. Reading `event.reason`
    // directly silently yields `undefined` in the real host, which would leave
    // every error/truncation/idle branch of `decide` unreachable. Accept the
    // flattened shape too, so both publishers stay supported.
    const reason = (event.data ?? event).reason?.kind;
    // Remembered so the `agent/status` path can honour the same deferral: that
    // event fires right after this one, and without this it would immediately
    // continue a turn this hook just handed to `continue-on-limit`.
    state.lastReason = reason;
    if (reason === 'error') state.consecutiveErrors += 1;
    else if (reason === 'completed') state.consecutiveErrors = 0;
    if (reason === 'completed') {
      if (state.sawTool) state.idleRounds = 0;
      else state.idleRounds += 1;
      state.sawTool = false;
    }
    if (state.idleRounds !== undefined && state.idleRounds > 0) persist();

    // A truncation is `continue-on-limit`'s case; the sweep picks the session up
    // a tick later when that plugin is not there to answer it.
    if (reason === 'max-tokens' && s.skipTruncatedTurnEnd) return;

    const verdict = decide({ settings: s, state, now: Date.now(), reason });
    if (verdict.action === 'send') void send(state, verdict.why);
    else if (verdict.action === 'stop') disarm(state, verdict.why);
  });

  // An idle agent is the earliest moment a queued turn can be opened; the sweep
  // is only the fallback for the times this event does not fire.
  ctx.on('agent/status', ({ agent, status }) => {
    if (disposed || status !== 'idle') return;
    const state = states.get(agent.session.id);
    if (state === undefined || !(state.deadline > 0) || state.pending) return;
    const s = settings();
    if (state.lastReason === 'max-tokens' && s.skipTruncatedTurnEnd) return;
    // The deferral above is one-shot. Clearing it here keeps a stale reason from
    // quietly disabling the watchdog for the rest of a long session: the next
    // idle moment after a truncation belongs to `continue-on-limit` only if that
    // plugin actually opened a turn, and if it did not, this sweep and this
    // event are the safety net.
    state.lastReason = undefined;
    const verdict = decide({ settings: s, state, now: Date.now(), reason: 'completed' });
    if (verdict.action === 'send') void send(state, verdict.why);
  });

  ctx.on('session/disposed', (session) => {
    if (states.delete(session.id)) persist();
  });

  ctx.effect(() => () => {
    disposed = true;
    if (heartbeat !== undefined) clearTimeout(heartbeat);
    heartbeat = undefined;
  });

  /**
   * Execute one slash invocation.
   *
   * This is a *scripting fallback*, not the interface: the composer button is
   * how the plugin is meant to be driven, and the command only exists so a
   * headless session or a shell can arm and stop without a browser. It owns no
   * third job — no "show me" listing, no argument grammar — and it is mounted
   * only when somebody sets `enableCommand: true`.
   *
   * Arming while the agent is idle is intentionally quiet: the person almost
   * always arms and then types the task, and a nudge queued ahead of that
   * message would be answering itself.
   */
  function handleCommand(invocation) {
    const session = invocation.agent.session;
    const now = Date.now();
    const raw = String(invocation.rawInput ?? '').trim().toLowerCase();
    const state = ensure(session.id);
    // `stop` / `off` / `停` … are the scripted "stop" words. An empty argument
    // gets the state line, which points at the button rather than at syntax.
    if (raw === '' || SHOW_WORDS.has(raw)) {
      return {
        kind: 'success',
        text: describeArming({
          state: states.get(session.id),
          now,
          settings: settings(),
          sessionId: session.id,
        }),
      };
    }
    if (STOP_WORDS.has(raw)) {
      return { kind: 'success', text: stopSession(state, now).text };
    }
    const result = armSession(state, String(invocation.rawInput ?? '').trim(), now);
    return { kind: result.ok ? 'success' : 'error', text: result.text };
  }

  // The slash command is OFF by default. It exists for scripts and headless
  // sessions; mounting it in a GUI install puts two contradictory interfaces
  // in front of the same person, and the button is the one this plugin is for.
  if (settings().enableCommand) {
    ctx.inject(['commands'], (child) => {
      const definition = {
        definitionId: 'dsh-nightwatch',
        description: 'Keep this session working until a clock time, then stop',
        input: { hint: '[22:30 | +90m | 明天 07:00 | stop | 空=查看]', attachments: false },
        handler: handleCommand,
      };
      // `run-until` stays registered alongside the new name because that is
      // what 1.1.0 documented, and a renamed command silently becomes
      // "unknown command" in someone's muscle memory.
      for (const commandName of ['nightwatch', 'run-until']) {
        try {
          child.commands.register({ ...definition, name: commandName });
        } catch (error) {
          // A name taken by another plugin must not stop the watchdog itself.
          logger().error?.(error);
        }
      }
    });
  }

  // ---------------------------------------------------------------- 按钮接口
  // The composer button cannot call a slash command without polluting the
  // transcript, so it talks to these three routes instead. `sessionId` is
  // validated against the live registry: an unknown id is a 404, never a new
  // arming record.
  const liveAgent = (sessionId) => {
    if (typeof sessionId !== 'string' || sessionId === '') return undefined;
    const agent = ctx.agents.get(sessionId);
    return agent !== undefined && agent.session?.id === sessionId ? agent : undefined;
  };

  const readBody = async (req) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8').slice(0, 4000);
    if (raw.trim() === '') return {};
    try {
      const parsed = JSON.parse(raw);
      return parsed !== null && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  };

  const sendJson = (res, status, payload) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(payload));
  };

  /**
   * Refuse requests a browser was told to send from somewhere else.
   *
   * The harness mounts plugin routes without the checks it applies to its own
   * `/api` path, so this gate is the plugin's own. Without it any page the
   * browser happens to have open could POST an arming for a session id it
   * guessed, or stop a watch that is already running.
   *
   * `sec-fetch-site` is the signal browsers always send; `Origin` is the
   * fallback for clients that do not. A request with neither header did not come
   * from a page at all (curl, a test), so it is allowed: this gate is about
   * pages, not about authentication.
   *
   * @param req - the incoming node request.
   * @returns true when the request may be served.
   */
  const sameOrigin = (req) => {
    const site = String(req.headers['sec-fetch-site'] ?? '').toLowerCase();
    if (site !== '' && site !== 'same-origin' && site !== 'none') return false;
    const origin = req.headers.origin;
    if (origin === undefined || origin === '') return true;
    try {
      return new URL(String(origin)).host === String(req.headers.host ?? '');
    } catch {
      return false;
    }
  };

  ctx.inject(['webServer'], (childCtx) => {
    /** Routes are matched by suffix so both mount points share one handler. */
    const routeOf = (pathname) => {
      const prefix = pathname.startsWith('/nightwatch')
        ? '/nightwatch'
        : pathname.startsWith('/run-until')
          ? '/run-until'
          : undefined;
      return prefix === undefined ? undefined : pathname.slice(prefix.length);
    };

    const handler = async (req, res) => {
      const url = new URL(String(req.url || ''), 'http://dsh.invalid');
      // `/run-until` is kept for links and bookmarks made against 1.1.0; the
      // button itself speaks `/nightwatch`.
      const route = routeOf(url.pathname);
      try {
        if (route === undefined) {
          sendJson(res, 404, { ok: false, error: 'not-found' });
          return;
        }
        if (!sameOrigin(req)) {
          sendJson(res, 403, { ok: false, error: 'cross-origin' });
          return;
        }
        if (route === '/state' && req.method === 'GET') {
          const sessionId = url.searchParams.get('sessionId') ?? '';
          if (liveAgent(sessionId) === undefined) {
            sendJson(res, 404, { ok: false, error: 'unknown-session' });
            return;
          }
          sendJson(res, 200, {
            ok: true,
            value: armingSnapshot({
              state: states.get(sessionId),
              now: Date.now(),
              settings: settings(),
            }),
          });
          return;
        }
        if (req.method !== 'POST') {
          sendJson(res, 404, { ok: false, error: 'not-found' });
          return;
        }
        const body = await readBody(req);
        const agent = liveAgent(body.sessionId);
        if (agent === undefined) {
          sendJson(res, 404, { ok: false, error: 'unknown-session' });
          return;
        }
        const state = ensure(agent.session.id);
        if (route === '/arm') {
          const result = armSession(state, String(body.until ?? ''), Date.now());
          sendJson(res, result.ok ? 200 : 400, { ok: result.ok, text: result.text });
          return;
        }
        if (route === '/stop') {
          const result = stopSession(state, Date.now());
          sendJson(res, 200, { ok: true, text: result.text });
          return;
        }
        sendJson(res, 404, { ok: false, error: 'not-found' });
      } catch (error) {
        sendJson(res, 500, { ok: false, error: String(error) });
      }
    };

    try {
      childCtx.effect(
        () => {
          const disposers = ['/nightwatch', '/run-until'].map((path) =>
            childCtx.webServer.register({ kind: 'prefix', path, handler }),
          );
          return () => {
            for (const dispose of disposers) {
              try {
                if (typeof dispose === 'function') dispose();
              } catch (error) {
                logger().error?.(error);
              }
            }
          };
        },
        'nightwatch: button routes',
      );
      info('button routes mounted at /nightwatch (and /run-until)');
    } catch (error) {
      logger().error?.(error);
    }
  });

  scheduleSweep();
  info(`watchdog armed (heartbeat ${settings().heartbeatMs}ms, state ${STATE_FILE})`);
}
