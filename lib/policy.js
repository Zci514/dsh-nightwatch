/**
 * Pure decision logic for `run-until`.
 *
 * No imports, no clock reads, no DSH types: every function here takes an
 * explicit `now` and plain data, so the whole policy is testable with a bare
 * `node --test` and nothing has to be mocked.
 *
 * @module dsh-run-until/policy
 */

/**
 * Source kind stamped on every host-generated message.
 *
 * Never `'user'`: `Agent.followup()` stamps `{ kind: 'user' }` when the caller
 * omits a source, and that kind is what the harness treats as human authority —
 * it would let an automatic loop answer its own approval prompts. The value is
 * kept inside the harness's `MessageSourceMap` union so projections that type
 * the field still accept the message.
 */
export const RUN_SOURCE_KIND = 'cordis-host-runner';

/**
 * Hard bounds applied to every numeric config field.
 *
 * `.volatile()` fields are written straight into their reference cell by the
 * settings page with no re-validation, so the runtime clamps every read here
 * instead of trusting the schema alone.
 */
export const LIMITS = Object.freeze({
  minIntervalMs: Object.freeze({ min: 0, max: 600_000 }),
  maxRounds: Object.freeze({ min: 0, max: 100_000 }),
  maxConsecutiveErrors: Object.freeze({ min: 1, max: 100 }),
  /** Consecutive rounds that changed nothing before the watch gives up. */
  maxIdleRounds: Object.freeze({ min: 0, max: 100 }),
  graceMs: Object.freeze({ min: 0, max: 3_600_000 }),
  heartbeatMs: Object.freeze({ min: 2_000, max: 300_000 }),
  armKickDelayMs: Object.freeze({ min: 0, max: 600_000 }),
  wrapUpMinutes: Object.freeze({ min: 0, max: 240 }),
  continueText: Object.freeze({ min: 1, max: 4_000 }),
});

/** Defaults for a fresh install. */
export const DEFAULTS = Object.freeze({
  enabled: true,
  /** Minimum gap between two automatic continuations of one session. */
  minIntervalMs: 1_500,
  /** Hard stop after this many continuations, whatever the clock says. */
  maxRounds: 400,
  /** Stop after this many consecutive failed turns (the model is wedged). */
  maxConsecutiveErrors: 3,
  /**
   * Stop after this many consecutive rounds that produced no tool call and no
   * file edit — the model is replying "好的，继续" without doing anything, and
   * every one of those costs a whole context window. `0` disables the check.
   */
  maxIdleRounds: 4,
  /**
   * How long a turn already in flight may overrun the deadline before it is
   * force-cancelled. `0` never cancels: the deadline then means "open no new
   * turn after this instant" and the turn in flight runs to its own end.
   */
  graceMs: 0,
  /** How often the idle watchdog re-checks an armed session. */
  heartbeatMs: 20_000,
  /** Idle time after arming before the watchdog may open the first turn itself. */
  armKickDelayMs: 20_000,
  /**
   * Inside this final window the continuation text switches to a wrap-up
   * instruction, so the last turn lands work instead of opening a new one.
   */
  wrapUpMinutes: 10,
  /**
   * Leave a truncation (`max-tokens`) turn to the `continue-on-limit` plugin,
   * which already owns that case, and pick the session up on the next watchdog
   * tick. Set false to have this plugin answer truncations itself.
   */
  skipTruncatedTurnEnd: true,
  continueText:
    '继续。现在是 {now}，距离 {deadline} 还有 {left}。接着推进手头的工作；如果手上已经没有待办，就自己挑一个对当前目标最有价值的下一步接着做，不要停下来等我。',
  wrapUpText:
    '快到点了（{now}，{deadline} 停）。现在开始收尾：把手上这件事做到一个能交代的状态，写下还差什么、下一步从哪接着做，不要再开新的大动作。',
});

/** Commands meaning "stop watching". */
const STOP_WORDS = new Set([
  'stop',
  'off',
  'clear',
  'cancel',
  'disarm',
  '停',
  '停止',
  '关',
  '关掉',
  '取消',
]);

/** Commands meaning "show me". */
const SHOW_WORDS = new Set(['', 'show', 'status', 'status?', '状态']);

/**
 * Unwrap a possibly-volatile scalar.
 *
 * A `.volatile()` field reaches the runtime as a frozen `{ get }` cell rather
 * than a plain value, so every read goes through here to observe a live change
 * without a reload. Plain values pass through untouched.
 *
 * @param value - a resolved config field value.
 * @param fallback - returned when the field is absent.
 * @returns the plain value behind the cell, else the value itself.
 */
export function plain(value, fallback = undefined) {
  if (value === null || typeof value !== 'object' || typeof value.get !== 'function') {
    return value === undefined ? fallback : value;
  }
  const inner = value.get();
  return inner === undefined ? fallback : inner;
}

/** Coerce an optional integer onto a closed range, else fall back. */
export function clampInt(value, fallback, bounds) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(bounds.max, Math.max(bounds.min, Math.round(n)));
}

/**
 * Read the current settings, tolerating a missing, partial, or badly typed
 * entry config.
 *
 * Every numeric field is clamped rather than only defaulted, so a wrong value
 * can never silently disable a safety gate. `0` stays legal where it means a
 * deliberate opt-out (no gap, no round cap).
 *
 * @param config - the composed entry config.
 * @returns the normalised runtime settings.
 */
export function readSettings(config = {}) {
  const text = String(plain(config.continueText, DEFAULTS.continueText) ?? DEFAULTS.continueText);
  const bounded =
    text.length >= LIMITS.continueText.min && text.length <= LIMITS.continueText.max
      ? text
      : DEFAULTS.continueText;
  const wrapUp = String(plain(config.wrapUpText, DEFAULTS.wrapUpText) ?? DEFAULTS.wrapUpText);
  const wrapUpBounded =
    wrapUp.length >= LIMITS.continueText.min && wrapUp.length <= LIMITS.continueText.max
      ? wrapUp
      : DEFAULTS.wrapUpText;
  const enabled = plain(config.enabled, DEFAULTS.enabled);
  const skipTruncated = plain(config.skipTruncatedTurnEnd, DEFAULTS.skipTruncatedTurnEnd);
  return {
    enabled: typeof enabled === 'boolean' ? enabled : DEFAULTS.enabled,
    skipTruncatedTurnEnd:
      typeof skipTruncated === 'boolean' ? skipTruncated : DEFAULTS.skipTruncatedTurnEnd,
    minIntervalMs: clampInt(
      plain(config.minIntervalMs, DEFAULTS.minIntervalMs),
      DEFAULTS.minIntervalMs,
      LIMITS.minIntervalMs,
    ),
    maxRounds: clampInt(
      plain(config.maxRounds, DEFAULTS.maxRounds),
      DEFAULTS.maxRounds,
      LIMITS.maxRounds,
    ),
    maxConsecutiveErrors: clampInt(
      plain(config.maxConsecutiveErrors, DEFAULTS.maxConsecutiveErrors),
      DEFAULTS.maxConsecutiveErrors,
      LIMITS.maxConsecutiveErrors,
    ),
    graceMs: clampInt(plain(config.graceMs, DEFAULTS.graceMs), DEFAULTS.graceMs, LIMITS.graceMs),
    maxIdleRounds: clampInt(
      plain(config.maxIdleRounds, DEFAULTS.maxIdleRounds),
      DEFAULTS.maxIdleRounds,
      LIMITS.maxIdleRounds,
    ),
    heartbeatMs: clampInt(
      plain(config.heartbeatMs, DEFAULTS.heartbeatMs),
      DEFAULTS.heartbeatMs,
      LIMITS.heartbeatMs,
    ),
    armKickDelayMs: clampInt(
      plain(config.armKickDelayMs, DEFAULTS.armKickDelayMs),
      DEFAULTS.armKickDelayMs,
      LIMITS.armKickDelayMs,
    ),
    wrapUpMinutes: clampInt(
      plain(config.wrapUpMinutes, DEFAULTS.wrapUpMinutes),
      DEFAULTS.wrapUpMinutes,
      LIMITS.wrapUpMinutes,
    ),
    continueText: bounded,
    wrapUpText: wrapUpBounded,
  };
}

/** `HH:MM` / `H:MM` on a 24h clock, tolerating the fullwidth colon. */
const CLOCK = /^(\d{1,2})\s*[:：]\s*(\d{2})$/u;
/** One offset term: `30m`, `2h`, `90s`, `1d`. */
const OFFSET_TERM = /(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)/giu;
const ISO_LIKE = /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2})\s*[:：]\s*(\d{2})$/u;
const UNIT_MS = Object.freeze({ ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 });

/**
 * Parse a human deadline expression into an absolute epoch-ms instant.
 *
 * Supported forms:
 * - `+30m`, `+2h`, `+90s`, `+1h30m`, `+0.5h` — a relative offset from `now`
 * - `22:30`, `7:05`, `22：30` — a wall-clock time today
 * - `22:30 明天` / `明天 07:00` — tomorrow at that clock time
 * - `2026-10-30 06:00` — an explicit local date and time
 *
 * A bare clock time already in the past rolls forward to tomorrow, which is
 * what "跑到 22:30" means when it is said at 23:00: the next 22:30.
 *
 * @param raw - the user's trimmed input.
 * @param now - current epoch-ms.
 * @returns `{ ok: true, at }` or `{ ok: false, reason }`.
 */
export function parseDeadline(raw, now) {
  const input = String(raw ?? '').trim();
  if (input === '') return { ok: false, reason: 'empty' };

  if (input.startsWith('+')) {
    const body = input.slice(1).replace(/\s+/gu, '').toLowerCase();
    let total = 0;
    let consumed = 0;
    OFFSET_TERM.lastIndex = 0;
    let term;
    while ((term = OFFSET_TERM.exec(body)) !== null) {
      if (term.index !== consumed) break;
      total += Number(term[1]) * UNIT_MS[term[2]];
      consumed = term.index + term[0].length;
    }
    if (consumed === 0 || consumed !== body.length || !Number.isFinite(total) || total <= 0) {
      return { ok: false, reason: 'offset-invalid' };
    }
    return { ok: true, at: now + Math.round(total) };
  }

  const iso = ISO_LIKE.exec(input);
  if (iso !== null) {
    const at = new Date(
      Number(iso[1]),
      Number(iso[2]) - 1,
      Number(iso[3]),
      Number(iso[4]),
      Number(iso[5]),
      0,
      0,
    ).getTime();
    if (!Number.isFinite(at)) return { ok: false, reason: 'date-invalid' };
    return { ok: true, at };
  }

  let rest = input;
  let tomorrow = false;
  if (/^明天/u.test(rest)) {
    tomorrow = true;
    rest = rest.replace(/^明天\s*/u, '');
  }
  if (/明天$/u.test(rest)) {
    tomorrow = true;
    rest = rest.replace(/\s*明天$/u, '');
  }

  const clock = CLOCK.exec(rest.trim());
  if (clock === null) return { ok: false, reason: 'unrecognised' };
  const hour = Number(clock[1]);
  const minute = Number(clock[2]);
  if (!(hour >= 0 && hour <= 24) || !(minute >= 0 && minute <= 59)) {
    return { ok: false, reason: 'clock-out-of-range' };
  }

  const base = new Date(now);
  const at = new Date(
    base.getFullYear(),
    base.getMonth(),
    base.getDate() + (tomorrow ? 1 : 0),
    hour,
    minute,
    0,
    0,
  ).getTime();
  if (!Number.isFinite(at)) return { ok: false, reason: 'clock-invalid' };
  if (!tomorrow && at <= now) {
    const rolled = new Date(at);
    rolled.setDate(rolled.getDate() + 1);
    return { ok: true, at: rolled.getTime(), rolled: true };
  }
  return { ok: true, at };
}

/**
 * Split one `/run-until` argument string into an intent.
 *
 * Only the three words owned by this command are interpreted; anything else is
 * a deadline expression, so an unrecognised word produces `arm` and the
 * deadline parser reports why it failed.
 *
 * @param raw - the raw command argument.
 * @returns `{kind:'show'}` | `{kind:'stop'}` | `{kind:'arm', raw}`.
 */
export function parseCommand(raw) {
  const input = String(raw ?? '').trim();
  const lower = input.toLowerCase();
  if (SHOW_WORDS.has(lower)) return { kind: 'show' };
  if (STOP_WORDS.has(lower)) return { kind: 'stop' };
  return { kind: 'arm', raw: input };
}

/**
 * Decide what to do after one `turn/end` event.
 *
 * @param options - the decision inputs.
 * @param options.settings - normalised settings from {@link readSettings}.
 * @param options.state - the per-session arming record.
 * @param options.now - current epoch-ms.
 * @param options.reason - `turn/end.reason.kind`, or `undefined`.
 * @returns `{action:'send'|'wait'|'stop'|'idle', why}`.
 */
export function decide({ settings, state, now, reason }) {
  if (!(state.deadline > 0)) return { action: 'idle', why: 'disarmed' };
  if (!settings.enabled) return { action: 'idle', why: 'disabled' };
  // A person pressed stop, or the harness unloaded the session: never fight it.
  if (reason === 'aborted') return { action: 'stop', why: 'aborted' };
  if (reason === 'error' && state.consecutiveErrors >= settings.maxConsecutiveErrors) {
    return { action: 'stop', why: 'error-streak' };
  }
  if (now >= state.deadline) return { action: 'stop', why: 'deadline' };
  if (settings.maxRounds > 0 && state.rounds >= settings.maxRounds) {
    return { action: 'stop', why: 'round-cap' };
  }
  if (settings.maxIdleRounds > 0 && (state.idleRounds ?? 0) >= settings.maxIdleRounds) {
    return { action: 'stop', why: 'idle-streak' };
  }
  if (state.pending) return { action: 'wait', why: 'pending' };
  if (now - state.lastSendAt < settings.minIntervalMs) return { action: 'wait', why: 'cooldown' };
  return { action: 'send', why: 'armed' };
}

/**
 * Decide what the idle watchdog should do for one armed session.
 *
 * This is the belt to `turn/end`'s braces: a session that reachable idle
 * without a turn having just ended (armed while already idle, a rejected
 * follow-up, a reload) would otherwise never be nudged again.
 *
 * @param options - the decision inputs.
 * @param options.settings - normalised settings from {@link readSettings}.
 * @param options.state - the per-session arming record.
 * @param options.now - current epoch-ms.
 * @param options.idle - whether the agent is idle with an empty inbox.
 * @returns `{action:'send'|'wait'|'stop'|'idle', why}`.
 */
export function decideHeartbeat({ settings, state, now, idle }) {
  if (!(state.deadline > 0)) return { action: 'idle', why: 'disarmed' };
  if (!settings.enabled) return { action: 'idle', why: 'disabled' };
  if (now >= state.deadline) return { action: 'stop', why: 'deadline' };
  if (settings.maxRounds > 0 && state.rounds >= settings.maxRounds) {
    return { action: 'stop', why: 'round-cap' };
  }
  if (state.consecutiveErrors >= settings.maxConsecutiveErrors) {
    return { action: 'stop', why: 'error-streak' };
  }
  if (settings.maxIdleRounds > 0 && (state.idleRounds ?? 0) >= settings.maxIdleRounds) {
    return { action: 'stop', why: 'idle-streak' };
  }
  if (state.pending) return { action: 'wait', why: 'pending' };
  if (!idle) return { action: 'wait', why: 'busy' };
  // Arming alone should not open a turn: the person usually arms and then types
  // the task, and a nudge racing their first message would queue behind it.
  if (state.rounds === 0 && now - state.armedAt < settings.armKickDelayMs) {
    return { action: 'wait', why: 'arm-delay' };
  }
  if (now - state.lastSendAt < settings.minIntervalMs) return { action: 'wait', why: 'cooldown' };
  return { action: 'send', why: 'idle' };
}

/** Human `HH:MM` for a timestamp in the host's local zone. */
export function clockLabel(epochMs) {
  const d = new Date(epochMs);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Human `MM-DD HH:MM` for a timestamp in the host's local zone. */
export function stampLabel(epochMs) {
  const d = new Date(epochMs);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Coarse remaining-time label such as `2 小时 15 分`. */
export function remainingLabel(fromMs, toMs) {
  const ms = Math.max(0, toMs - fromMs);
  const totalMinutes = Math.ceil(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0 && minutes > 0) return `${hours} 小时 ${minutes} 分`;
  if (hours > 0) return `${hours} 小时`;
  return `${minutes} 分`;
}

/** Expand `{now}` / `{deadline}` / `{left}` placeholders in the continue text. */
export function renderContinueText(template, { now, deadline }) {
  return String(template)
    .replaceAll('{now}', clockLabel(now))
    .replaceAll('{deadline}', clockLabel(deadline))
    .replaceAll('{left}', remainingLabel(now, deadline));
}

/** Human reason for a stop verdict. */
export function stopReasonLabel(why) {
  switch (why) {
    case 'deadline':
      return '已到点';
    case 'round-cap':
      return '达到轮次上限';
    case 'error-streak':
      return '连续出错';
    case 'idle-streak':
      return '连续几轮没动手';
    case 'aborted':
      return '被手动中止';
    case 'disarmed':
      return '已关闭';
    case 'disabled':
      return '插件已停用';
    case 'orphaned':
      return '会话已不存在';
    default:
      return why;
  }
}

/**
 * Render the `/run-until` status block for one session.
 *
 * @param options - render inputs.
 * @param options.state - the arming record, or `undefined` when disarmed.
 * @param options.now - current epoch-ms.
 * @param options.settings - normalised settings.
 * @param options.sessionId - the session the command ran in.
 * @returns one multi-line plain-text block.
 */
export function describeArming({ state, now, settings, sessionId }) {
  if (state === undefined || !(state.deadline > 0)) {
    return [
      '守夜：未开启',
      `会话：${String(sessionId).slice(0, 8)}`,
      '',
      '用法：/run-until 22:30    → 一直干到 22:30 自动停',
      '      /run-until +90m    → 再干 90 分钟',
      '      /run-until 明天 07:00',
      '      /run-until stop    → 立刻停',
    ].join('\n');
  }
  const left = now < state.deadline ? `还有 ${remainingLabel(now, state.deadline)}` : '已到点';
  return [
    `守夜：${state.expired ? '已停止' : '进行中'}`,
    `会话：${String(sessionId).slice(0, 8)}`,
    `截止：${stampLabel(state.deadline)}（${left}）`,
    `已续跑：${state.rounds} 轮${settings.maxRounds > 0 ? ` / 上限 ${settings.maxRounds}` : ''}`,
    `停止条件：到点${settings.graceMs > 0 ? `（宽限 ${remainingLabel(0, settings.graceMs)} 后仍在跑则中止）` : ''}`
      + `${settings.maxRounds > 0 ? `、${settings.maxRounds} 轮` : ''}`
      + `${settings.maxIdleRounds > 0 ? `、连续 ${settings.maxIdleRounds} 轮没动手` : ''}`
      + `、连续出错 ${settings.maxConsecutiveErrors} 次`,
  ].join('\n');
}

/**
 * Compact state for the composer button, so the UI can poll cheaply.
 *
 * Deliberately plain JSON with the verdict already computed: the button renders
 * it directly and never has to re-derive "is this still armed" from a timestamp
 * it might have read a few hundred milliseconds late.
 *
 * @param options.state - the arming record, or `undefined` when disarmed.
 * @param options.now - current epoch-ms.
 * @param options.settings - normalised settings.
 * @returns a small JSON-safe snapshot.
 */
export function armingSnapshot({ state, now, settings }) {
  const armed = state !== undefined && state.deadline > 0;
  if (!armed) {
    return {
      armed: false,
      deadline: 0,
      remainingMs: 0,
      rounds: 0,
      roundsCap: settings.maxRounds,
      wrapUpMinutes: settings.wrapUpMinutes,
      stoppingSoon: false,
    };
  }
  const remainingMs = Math.max(0, state.deadline - now);
  return {
    armed: true,
    deadline: state.deadline,
    remainingMs,
    rounds: state.rounds,
    roundsCap: settings.maxRounds,
    wrapUpMinutes: settings.wrapUpMinutes,
    deadlineLabel: clockLabel(state.deadline),
    stampLabel: stampLabel(state.deadline),
    remainingLabel: remainingLabel(now, state.deadline),
    stoppingSoon: remainingMs <= settings.wrapUpMinutes * 60_000,
  };
}
