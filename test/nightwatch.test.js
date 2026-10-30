/**
 * Tests for `nightwatch`.
 *
 * Two layers: the pure policy (clock in, verdict out — no host, no timers), and
 * an integration layer that loads the real `lib/index.js` into a fake host and
 * drives whole turns through it. The integration layer is the one that matters:
 * it catches the reentrancy, the double-send, and the deadline races that a
 * pure-function test cannot see.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

// The state file path is resolved at module load, so DSH_HOME has to be set
// before the plugin is imported.
const sandbox = mkdtempSync(join(tmpdir(), 'nightwatch-'));
process.env.DSH_HOME = sandbox;

const policy = await import('../lib/policy.js');
const plugin = await import('../lib/index.js');
const { FakeHost, until } = await import('./fake-host.js');

const {
  DEFAULTS,
  parseDeadline,
  readSettings,
  decide,
  decideHeartbeat,
  renderContinueText,
  remainingLabel,
  describeArming,
  shouldForget,
  parseHint,
} = policy;

after(() => rmSync(sandbox, { recursive: true, force: true }));

const NOW = Date.parse('2026-10-29T05:30:00+08:00');

describe('parseDeadline', () => {
  it('reads a bare clock time as today when it is still ahead', () => {
    const got = parseDeadline('22:30', NOW);
    assert.equal(got.ok, true);
    assert.equal(new Date(got.at).getHours(), 22);
    assert.equal(new Date(got.at).getMinutes(), 30);
    assert.equal(new Date(got.at).getDate(), new Date(NOW).getDate());
  });

  it('rolls a past clock time forward to tomorrow', () => {
    const got = parseDeadline('05:00', NOW);
    assert.equal(got.ok, true);
    assert.equal(got.rolled, true);
    assert.ok(got.at > NOW);
    assert.equal(new Date(got.at).getDate(), new Date(NOW).getDate() + 1);
  });

  it('accepts relative offsets in every unit and combination', () => {
    assert.equal(parseDeadline('+90m', NOW).at, NOW + 90 * 60_000);
    assert.equal(parseDeadline('+1h30m', NOW).at, NOW + 90 * 60_000);
    assert.equal(parseDeadline('+45s', NOW).at, NOW + 45_000);
    assert.equal(parseDeadline('+250ms', NOW).at, NOW + 250);
    assert.equal(parseDeadline('+2d', NOW).at, NOW + 2 * 86_400_000);
  });

  it('rejects a zero or unparsable offset rather than arming nothing', () => {
    assert.equal(parseDeadline('+0m', NOW).ok, false);
    assert.equal(parseDeadline('+m', NOW).ok, false);
    assert.equal(parseDeadline('+90', NOW).ok, false);
  });

  it('tolerates the fullwidth colon and a leading-zero hour', () => {
    assert.equal(parseDeadline('22：45', NOW).at, parseDeadline('22:45', NOW).at);
    assert.equal(parseDeadline('7:05', NOW).at, parseDeadline('07:05', NOW).at);
  });

  it('understands 明天 on either side', () => {
    assert.equal(parseDeadline('明天 07:00', NOW).at, parseDeadline('07:00 明天', NOW).at);
    assert.equal(parseDeadline('07:00 明天', NOW).rolled, undefined);
  });

  it('reads an explicit local date and time', () => {
    const got = parseDeadline('2026-10-30 06:00', NOW);
    assert.equal(got.ok, true);
    const d = new Date(got.at);
    assert.equal(d.getFullYear(), 2026);
    assert.equal(d.getMonth(), 9);
    assert.equal(d.getDate(), 30);
    assert.equal(d.getHours(), 6);
  });

  it('reports why it could not read an input', () => {
    assert.equal(parseDeadline('', NOW).reason, 'empty');
    assert.equal(parseDeadline('abc', NOW).reason, 'unrecognised');
    assert.equal(parseDeadline('25:00', NOW).reason, 'clock-out-of-range');
    assert.equal(parseDeadline('22:70', NOW).reason, 'clock-out-of-range');
  });

  it('treats 24:00 as the next midnight', () => {
    const got = parseDeadline('24:00', NOW);
    assert.equal(got.ok, true);
    assert.equal(new Date(got.at).getTime(), new Date('2026-10-30T00:00:00+08:00').getTime());
  });
});

describe('readSettings', () => {
  it('returns the defaults for an empty config', () => {
    const s = readSettings({});
    assert.equal(s.enabled, DEFAULTS.enabled);
    assert.equal(s.maxRounds, DEFAULTS.maxRounds);
    assert.equal(s.heartbeatMs, DEFAULTS.heartbeatMs);
    assert.equal(s.continueText, DEFAULTS.continueText);
  });

  it('clamps a hostile number instead of trusting the schema', () => {
    const s = readSettings({ heartbeatMs: 1, maxRounds: -5, graceMs: 99_999_999 });
    assert.equal(s.heartbeatMs, 2_000);
    assert.equal(s.maxRounds, 0);
    assert.equal(s.graceMs, 3_600_000);
  });

  it('keeps 0 where 0 is a deliberate opt-out', () => {
    const s = readSettings({ minIntervalMs: 0, maxRounds: 0, graceMs: 0 });
    assert.equal(s.minIntervalMs, 0);
    assert.equal(s.maxRounds, 0);
    assert.equal(s.graceMs, 0);
  });

  it('falls back to the default text when the override is empty', () => {
    assert.equal(readSettings({ continueText: '' }).continueText, DEFAULTS.continueText);
    assert.equal(readSettings({ continueText: '跑' }).continueText, '跑');
  });

  it('unwraps a volatile cell to observe a live change', () => {
    let value = 20_000;
    const cell = { get: () => value };
    const config = { heartbeatMs: cell };
    assert.equal(readSettings(config).heartbeatMs, 20_000);
    value = 45_000;
    assert.equal(readSettings(config).heartbeatMs, 45_000);
  });

  it('exposes the Config schema the loader expects', () => {
    const validated = plugin.Config['~standard'].validate({ heartbeatMs: 1 });
    assert.equal(validated.issues, undefined);
    assert.equal(validated.value.heartbeatMs, 2_000);
    assert.ok(plugin.Config['~standard'].validate('nope').issues.length > 0);
  });
});

describe('decide', () => {
  const armed = (over = {}) => ({
    sessionId: 's1',
    deadline: NOW + 60_000,
    armedAt: NOW,
    rounds: 0,
    lastSendAt: 0,
    consecutiveErrors: 0,
    pending: false,
    expired: false,
    ...over,
  });

  it('sends when armed, finished, and past the cooldown', () => {
    const verdict = decide({ settings: readSettings({}), state: armed(), now: NOW, reason: 'completed' });
    assert.equal(verdict.action, 'send');
  });

  it('never sends when nothing is armed', () => {
    const verdict = decide({ settings: readSettings({}), state: armed({ deadline: 0 }), now: NOW, reason: 'completed' });
    assert.equal(verdict.action, 'idle');
  });

  it('stops at the deadline instead of sending', () => {
    const state = armed();
    const verdict = decide({ settings: readSettings({}), state, now: state.deadline, reason: 'completed' });
    assert.deepEqual(verdict, { action: 'stop', why: 'deadline' });
  });

  it('stops when the round cap is reached, and ignores a cap of 0', () => {
    const capped = decide({
      settings: readSettings({ maxRounds: 5 }),
      state: armed({ rounds: 5 }),
      now: NOW,
      reason: 'completed',
    });
    assert.equal(capped.action, 'stop');
    assert.equal(capped.why, 'round-cap');
    const uncapped = decide({
      settings: readSettings({ maxRounds: 0 }),
      state: armed({ rounds: 5 }),
      now: NOW,
      reason: 'completed',
    });
    assert.equal(uncapped.action, 'send');
  });

  it('stops after a streak of rounds that touched no tool, and ignores a cap of 0', () => {
    const streaked = decide({
      settings: readSettings({ maxIdleRounds: 2 }),
      state: armed({ idleRounds: 2 }),
      now: NOW,
      reason: 'completed',
    });
    assert.deepEqual(streaked, { action: 'stop', why: 'idle-streak' });
    const stillWorking = decide({
      settings: readSettings({ maxIdleRounds: 2 }),
      state: armed({ idleRounds: 1 }),
      now: NOW,
      reason: 'completed',
    });
    assert.equal(stillWorking.action, 'send');
    const off = decide({
      settings: readSettings({ maxIdleRounds: 0 }),
      state: armed({ idleRounds: 99 }),
      now: NOW,
      reason: 'completed',
    });
    assert.equal(off.action, 'send');
  });

  it('honours a manual abort over everything else', () => {
    const verdict = decide({ settings: readSettings({}), state: armed(), now: NOW, reason: 'aborted' });
    assert.deepEqual(verdict, { action: 'stop', why: 'aborted' });
  });

  it('stops only after the error streak, not on the first error', () => {
    const one = decide({
      settings: readSettings({ maxConsecutiveErrors: 3 }),
      state: armed({ consecutiveErrors: 1 }),
      now: NOW,
      reason: 'error',
    });
    assert.equal(one.action, 'send');
    const three = decide({
      settings: readSettings({ maxConsecutiveErrors: 3 }),
      state: armed({ consecutiveErrors: 3 }),
      now: NOW,
      reason: 'error',
    });
    assert.deepEqual(three, { action: 'stop', why: 'error-streak' });
  });

  it('waits while a send is already in flight', () => {
    const verdict = decide({ settings: readSettings({}), state: armed({ pending: true }), now: NOW, reason: 'completed' });
    assert.deepEqual(verdict, { action: 'wait', why: 'pending' });
  });

  it('waits out the cooldown', () => {
    const verdict = decide({
      settings: readSettings({ minIntervalMs: 5_000 }),
      state: armed({ lastSendAt: NOW - 1_000 }),
      now: NOW,
      reason: 'completed',
    });
    assert.deepEqual(verdict, { action: 'wait', why: 'cooldown' });
  });
});

describe('decideHeartbeat', () => {
  const armed = (over = {}) => ({
    sessionId: 's1',
    deadline: NOW + 60_000,
    armedAt: NOW - 60_000,
    rounds: 3,
    lastSendAt: 0,
    consecutiveErrors: 0,
    pending: false,
    expired: false,
    ...over,
  });

  it('nudges an idle armed session that fell through the cracks', () => {
    const verdict = decideHeartbeat({ settings: readSettings({}), state: armed(), now: NOW, idle: true });
    assert.equal(verdict.action, 'send');
  });

  it('leaves a busy session alone', () => {
    const verdict = decideHeartbeat({ settings: readSettings({}), state: armed(), now: NOW, idle: false });
    assert.deepEqual(verdict, { action: 'wait', why: 'busy' });
  });

  it('does not race the person right after arming', () => {
    const state = armed({ rounds: 0, armedAt: NOW - 1_000 });
    const verdict = decideHeartbeat({ settings: readSettings({ armKickDelayMs: 20_000 }), state, now: NOW, idle: true });
    assert.deepEqual(verdict, { action: 'wait', why: 'arm-delay' });
  });

  it('kicks in once the arm delay has passed', () => {
    const state = armed({ rounds: 0, armedAt: NOW - 30_000 });
    const verdict = decideHeartbeat({ settings: readSettings({ armKickDelayMs: 20_000 }), state, now: NOW, idle: true });
    assert.equal(verdict.action, 'send');
  });

  it('stops on an idle streak before the next nudge', () => {
    const verdict = decideHeartbeat({
      settings: readSettings({ maxIdleRounds: 3 }),
      state: armed({ idleRounds: 3 }),
      now: NOW,
      idle: true,
    });
    assert.deepEqual(verdict, { action: 'stop', why: 'idle-streak' });
  });

  it('stops at the deadline even when idle', () => {
    const state = armed();
    const verdict = decideHeartbeat({ settings: readSettings({}), state, now: state.deadline + 1, idle: true });
    assert.deepEqual(verdict, { action: 'stop', why: 'deadline' });
  });

  it('reports a disarmed session as idle', () => {
    const verdict = decideHeartbeat({ settings: readSettings({}), state: armed({ deadline: 0 }), now: NOW, idle: true });
    assert.equal(verdict.action, 'idle');
  });
});

describe('shouldForget', () => {
  const TTL = 10 * 60_000;

  it('drops a record that never held an arming right away', () => {
    // `/nightwatch stop` on a quiet session still creates a record; keeping it
    // would leave one entry per session the process ever saw.
    const state = { deadline: 0, armedAt: 0, rounds: 0, pending: false };
    assert.equal(shouldForget({ state, now: NOW, ttlMs: TTL }), true);
  });

  it('keeps an armed record and a send in flight', () => {
    assert.equal(shouldForget({ state: { deadline: NOW + 1, armedAt: NOW, pending: false }, now: NOW, ttlMs: TTL }), false);
    assert.equal(shouldForget({ state: { deadline: 0, armedAt: NOW, pending: true }, now: NOW, ttlMs: TTL }), false);
  });

  it('keeps a just-stopped record long enough to report its rounds', () => {
    const state = { deadline: 0, armedAt: NOW - 60_000, goneAt: NOW - 1_000, rounds: 12, pending: false };
    assert.equal(shouldForget({ state, now: NOW, ttlMs: TTL }), false);
    assert.equal(shouldForget({ state, now: NOW + TTL, ttlMs: TTL }), true);
  });
});

describe('rendering', () => {
  it('expands the placeholders in a continue template', () => {
    const text = renderContinueText('{now}|{deadline}|{left}', { now: NOW, deadline: NOW + 90 * 60_000 });
    assert.match(text, /^\d\d:\d\d\|\d\d:\d\d\|/u);
    assert.match(text, /1 小时 30 分|90 分/u);
  });

  it('labels remaining time at several magnitudes', () => {
    assert.equal(remainingLabel(0, 90 * 60_000), '1 小时 30 分');
    assert.equal(remainingLabel(0, 120 * 60_000), '2 小时');
    assert.equal(remainingLabel(0, 42_000), '1 分');
    assert.equal(remainingLabel(0, 0), '0 分');
  });

  it('renders the usage hint against the day it is shown, not a frozen date', () => {
    // A hint pinned to one date turns into a wrong example the next morning.
    const hint = parseHint(NOW);
    assert.match(hint, /22:30/u);
    assert.match(hint, /\+90m/u);
    assert.match(hint, /0710|10-29/u);
    assert.ok(hint.includes('2026-10-29'), 'the current date is rendered live');
  });

  it('describes an empty and an armed session differently', () => {
    const off = describeArming({ state: undefined, now: NOW, settings: readSettings({}), sessionId: 'abcdef12345' });
    assert.match(off, /守夜：未开启/u);
    const on = describeArming({
      state: { deadline: NOW + 3_600_000, armedAt: NOW, rounds: 7, expired: false },
      now: NOW,
      settings: readSettings({}),
      sessionId: 'abcdef12345',
    });
    assert.match(on, /守夜：进行中/u);
    assert.match(on, /已续跑：7 轮/u);
  });
});

/** Build a host with the plugin mounted and one agent registered. */
async function mount(overrides = {}) {
  const host = new FakeHost();
  const agent = host.addAgent('session-1');
  const config = readSettings({
    heartbeatMs: 2_000,
    armKickDelayMs: 0,
    minIntervalMs: 0,
    maxConsecutiveErrors: 3,
    ...overrides,
  });
  plugin.apply(host, config);
  return { host, agent, config };
}

/** Same-origin headers: the button always speaks from the page's own origin. */
const SAME_ORIGIN = {
  host: '127.0.0.1:1',
  'sec-fetch-site': 'same-origin',
  origin: 'http://127.0.0.1:1',
};

/** Arm (or re-arm) one session through the button route — the shipped interface. */
async function arm(host, agent, until) {
  return host.request({
    method: 'POST',
    path: '/nightwatch/arm',
    headers: SAME_ORIGIN,
    body: { sessionId: agent.session.id, until },
  });
}

/** Stop one session through the button route. */
async function stopWatch(host, agent) {
  return host.request({
    method: 'POST',
    path: '/nightwatch/stop',
    headers: SAME_ORIGIN,
    body: { sessionId: agent.session.id },
  });
}

/** Read the snapshot the pill renders. */
async function snapshotOf(host, agent) {
  return host.request({
    path: `/nightwatch/state?sessionId=${agent.session.id}`,
    headers: SAME_ORIGIN,
  });
}

describe('plugin integration', () => {
  it('ships without a slash command', async () => {
    // The button is the interface. A command doing the same job gives one
    // person two ways to do one thing, so it is opt-in for headless installs.
    const { host } = await mount();
    assert.deepEqual([...host.commands.keys()], []);
    host.dispose();
  });

  it('registers the command and its legacy alias when asked to', async () => {
    const { host } = await mount({ enableCommand: true });
    assert.deepEqual([...host.commands.keys()], ['nightwatch', 'run-until']);
    const definition = host.commands.get('nightwatch');
    assert.match(definition.name, /^[a-z][a-z0-9_-]*$/u);
    assert.ok(definition.description.length > 0);
    assert.equal(typeof definition.handler, 'function');
    host.dispose();
  });

  it('reports its state before anything is armed', async () => {
    const { host, agent } = await mount();
    const state = await snapshotOf(host, agent);
    assert.equal(state.status, 200);
    assert.equal(state.json.value.armed, false);
    host.dispose();
  });

  it('refuses a deadline it cannot read, and stays disarmed', async () => {
    const { host, agent } = await mount();
    const result = await arm(host, agent, '瞎写的');
    assert.equal(result.status, 400);
    assert.equal(result.json.ok, false);
    assert.match(result.json.text, /看不懂/u);
    assert.equal(agent.received.length, 0);
    // Still disarmed: nothing should ever be sent.
    agent.startTurn();
    agent.endTurn(host);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(agent.received.length, 0);
    host.dispose();
  });

  it('continues the session on every turn/end until the deadline passes', async () => {
    const { host, agent } = await mount({ wrapUpMinutes: 0 });
    const armed = await arm(host, agent, '+400ms');
    assert.equal(armed.status, 200);
    assert.equal(armed.json.ok, true);

    agent.startTurn();
    agent.endTurn(host);
    await until(() => agent.received.length === 1, { label: 'first continuation' });

    agent.startTurn();
    agent.endTurn(host);
    await until(() => agent.received.length === 2, { label: 'second continuation' });

    assert.match(agent.received[0].content[0].text, /距离/u);
    assert.equal(agent.received[0].source.kind, 'cordis-host-runner');
    assert.notEqual(agent.received[0].source.kind, 'user');
    assert.equal(agent.received[0].role, 'user');
    assert.ok(Object.isFrozen(agent.received[0]));

    // Let the deadline pass, then make one more turn end: nothing may be sent.
    await new Promise((r) => setTimeout(r, 450));
    const before = agent.received.length;
    agent.startTurn();
    agent.endTurn(host);
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(agent.received.length, before, 'no continuation after the deadline');
    host.dispose();
  });

  it('switches to the wrap-up text near the deadline', async () => {
    const { host, agent } = await mount({ wrapUpMinutes: 240 });
    await arm(host, agent, '+600ms');
    agent.startTurn();
    agent.endTurn(host);
    await until(() => agent.received.length === 1, { label: 'wrap-up continuation' });
    assert.match(agent.received[0].content[0].text, /收尾/u);
    host.dispose();
  });

  it('stops immediately when the button says stop', async () => {
    const { host, agent } = await mount();
    await arm(host, agent, '+10m');
    const stopped = await stopWatch(host, agent);
    assert.equal(stopped.status, 200);
    assert.equal(stopped.json.ok, true);
    assert.match(stopped.json.text, /已续跑 0 轮/u);
    agent.startTurn();
    agent.endTurn(host);
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(agent.received.length, 0);
    host.dispose();
  });

  it('enforces the round cap', async () => {
    const { host, agent } = await mount({ maxRounds: 2 });
    await arm(host, agent, '+10m');
    for (let i = 0; i < 2; i += 1) {
      agent.startTurn();
      agent.endTurn(host);
      await until(() => agent.received.length === i + 1, { label: `round ${i + 1}` });
    }
    agent.startTurn();
    agent.endTurn(host);
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(agent.received.length, 2);
    host.dispose();
  });

  it('stops after a run of consecutive errors', async () => {
    const { host, agent } = await mount({ maxConsecutiveErrors: 2 });
    await arm(host, agent, '+10m');
    for (let i = 0; i < 2; i += 1) {
      agent.startTurn();
      agent.endTurn(host, 'error');
      await new Promise((r) => setTimeout(r, 40));
    }
    // The first error still continues, the second stops the watch.
    assert.equal(agent.received.length, 1);
    agent.startTurn();
    agent.endTurn(host, 'error');
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(agent.received.length, 1);
    host.dispose();
  });

  it('stops on a manual abort without fighting the person', async () => {
    const { host, agent } = await mount();
    await arm(host, agent, '+10m');
    agent.startTurn();
    agent.endTurn(host, 'aborted');
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(agent.received.length, 0);
    host.dispose();
  });

  it('stops after a streak of rounds that touched no tool', async () => {
    const { host, agent } = await mount({ maxIdleRounds: 2 });
    await arm(host, agent, '+10m');
    // Two completed rounds, neither of which called a tool.
    for (let i = 0; i < 3; i += 1) {
      agent.startTurn();
      agent.endTurn(host);
      await new Promise((r) => setTimeout(r, 60));
    }
    // Round 1 still continues; round 2 hits the streak and stops the watch.
    assert.equal(agent.received.length, 1);
    host.dispose();
  });

  it('a round that called a tool resets the idle streak', async () => {
    const { host, agent } = await mount({ maxIdleRounds: 2 });
    await arm(host, agent, '+10m');
    for (let i = 0; i < 4; i += 1) {
      agent.startTurn();
      // The turn did real work, so it must not count toward the idle streak.
      host.emit('session/event', agent.session, { type: 'tool/call', callId: 'c1', name: 'ops_bash' });
      agent.endTurn(host);
      await until(() => agent.received.length === i + 1, { label: `working round ${i + 1}` });
    }
    assert.equal(agent.received.length, 4);
    host.dispose();
  });

  it('leaves a truncated turn to the truncation plugin but still recovers', async () => {
    const { host, agent } = await mount({ heartbeatMs: 2_000 });
    await arm(host, agent, '+10m');
    agent.startTurn();
    agent.endTurn(host, 'max-tokens');
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(agent.received.length, 0, 'the turn/end hook defers');
    agent.startTurn();
    agent.endTurn(host, 'completed');
    await until(() => agent.received.length === 1, { label: 'recovery after truncation' });
    host.dispose();
  });

  it('does not double-send when turn/end and idle both fire', async () => {
    const { host, agent } = await mount();
    await arm(host, agent, '+10m');
    // `endTurn` emits both events in the real order.
    agent.startTurn();
    agent.endTurn(host);
    await until(() => agent.received.length >= 1, { label: 'one continuation' });
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(agent.received.length, 1);
    host.dispose();
  });

  it('waits for a busy agent instead of appending mid-turn', async () => {
    const { host, agent } = await mount();
    await arm(host, agent, '+10m');
    agent.startTurn();
    // A turn/end while the agent is somehow still running: the follow-up has to
    // wait for idle rather than trip the reentrant-append guard.
    host.emit('session/event', agent.session, { type: 'turn/end', reason: { kind: 'completed' } });
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(agent.received.length, 0);
    agent.status = 'idle';
    await until(() => agent.received.length === 1, { label: 'delivery after idle' });
    host.dispose();
  });

  it('persists the arming so a restart keeps watching', async () => {
    const { host, agent } = await mount();
    await arm(host, agent, '+30m');
    const raw = JSON.parse(readFileSync(join(sandbox, 'nightwatch.json'), 'utf8'));
    assert.equal(raw.version, 1);
    assert.ok(raw.armings[agent.session.id].deadline > Date.now());
    host.dispose();
  });

  it('resumes watching a persisted arming after a restart', async () => {
    // Simulate a crash: the file says a session is armed, and nothing else in
    // this process knows about it. The first sweep has to promote that record
    // or the arming would silently rot until the next turn/end.
    const sessionId = 'session-restart';
    const deadline = Date.now() + 30 * 60_000;
    writeFileSync(
      join(sandbox, 'nightwatch.json'),
      `${JSON.stringify(
        { version: 1, armings: { [sessionId]: { deadline, armedAt: Date.now(), rounds: 0 } } },
        null,
        2,
      )}\n`,
      'utf8',
    );

    const host = new FakeHost();
    const agent = host.addAgent(sessionId);
    plugin.apply(
      host,
      readSettings({ heartbeatMs: 2_000, armKickDelayMs: 0, minIntervalMs: 0, wrapUpMinutes: 0 }),
    );
    // heartbeatMs floors at 2000, so this test has to outwait a full beat.
    await until(() => agent.received.length >= 1, {
      label: 'restored arming continues',
      timeoutMs: 8_000,
    });
    assert.equal(agent.received[0].source.kind, 'cordis-host-runner');
    assert.match(agent.received[0].content[0].text, /距离/u);
    host.dispose();
    writeFileSync(join(sandbox, 'nightwatch.json'), '{"version":1,"armings":{}}\n', 'utf8');
  });

  it('drops the arming when the session is disposed', async () => {
    const { host, agent } = await mount();
    await arm(host, agent, '+30m');
    host.emit('session/disposed', agent.session);
    await new Promise((r) => setTimeout(r, 20));
    const raw = JSON.parse(readFileSync(join(sandbox, 'nightwatch.json'), 'utf8'));
    assert.equal(raw.armings[agent.session.id], undefined);
    host.dispose();
  });

  it('clears its timer when disposed', async () => {
    const { host } = await mount({ heartbeatMs: 2_000 });
    host.dispose();
    // Nothing to assert beyond "did not throw / did not keep the loop alive":
    // the timer is unref'ed, so a leaked one would not block, but the disposer
    // must still run without touching a torn-down host.
    assert.equal(host.bus.listenerCount('session/event'), 0);
  });
});

describe('persistence edges', () => {
  it('keeps an unclaimed arming when another session persists', async () => {
    // A crash left `session-crash` armed but unloaded; a different session
    // arms and writes the file. The unloaded record must survive that write,
    // otherwise a restart would quietly lose it.
    const crashDeadline = Date.now() + 45 * 60_000;
    writeFileSync(
      join(sandbox, 'nightwatch.json'),
      `${JSON.stringify(
        {
          version: 1,
          armings: {
            'session-crash': { deadline: crashDeadline, armedAt: Date.now(), rounds: 3 },
          },
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    const host = new FakeHost();
    const agent = host.addAgent('session-live');
    plugin.apply(host, readSettings({ heartbeatMs: 2_000, armKickDelayMs: 0, minIntervalMs: 0 }));
    await arm(host, agent, '+90m');
    await new Promise((r) => setTimeout(r, 30));

    const raw = JSON.parse(readFileSync(join(sandbox, 'nightwatch.json'), 'utf8'));
    assert.ok(raw.armings['session-crash'], 'the unloaded arming is still persisted');
    assert.equal(raw.armings['session-crash'].deadline, crashDeadline);
    assert.equal(raw.armings['session-crash'].rounds, 3);
    host.dispose();
  });

  it('forgets an arming that expired while nothing was watching', async () => {
    const staleDeadline = Date.now() - 60_000;
    writeFileSync(
      join(sandbox, 'nightwatch.json'),
      `${JSON.stringify(
        {
          version: 1,
          armings: { 'session-stale': { deadline: staleDeadline, armedAt: 1, rounds: 9 } },
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    const host = new FakeHost();
    const agent = host.addAgent('session-stale');
    plugin.apply(host, readSettings({ heartbeatMs: 2_000, armKickDelayMs: 0, minIntervalMs: 0 }));
    await new Promise((r) => setTimeout(r, 2_300));

    assert.equal(agent.received.length, 0, 'an expired arming never resumes');
    const raw = JSON.parse(readFileSync(join(sandbox, 'nightwatch.json'), 'utf8'));
    assert.equal(raw.armings['session-stale'], undefined, 'the stale record is dropped');
    host.dispose();
  });

  it('adopts armings left in the 1.1.0 state file exactly once', async () => {
    // 1.1.0 wrote `run-until.json`. An upgrade must not lose a watch that is
    // already running, and the fold-over must happen on the new file so the
    // old one stops being consulted.
    const sessionId = 'session-migrated';
    const deadline = Date.now() + 30 * 60_000;
    writeFileSync(
      join(sandbox, 'run-until.json'),
      `${JSON.stringify(
        { version: 1, armings: { [sessionId]: { deadline, armedAt: Date.now(), rounds: 2 } } },
        null,
        2,
      )}\n`,
      'utf8',
    );

    const host = new FakeHost();
    const agent = host.addAgent(sessionId);
    plugin.apply(
      host,
      readSettings({ heartbeatMs: 2_000, armKickDelayMs: 0, minIntervalMs: 0, wrapUpMinutes: 0 }),
    );
    await until(() => agent.received.length >= 1, {
      label: 'migrated arming continues',
      timeoutMs: 8_000,
    });

    const folded = JSON.parse(readFileSync(join(sandbox, 'nightwatch.json'), 'utf8'));
    assert.ok(folded.armings[sessionId], 'the arming now lives in the new file');
    const legacy = JSON.parse(readFileSync(join(sandbox, 'run-until.json'), 'utf8'));
    assert.ok(legacy.armings[sessionId], 'the old file is left alone for a rollback');
    host.dispose();
    writeFileSync(join(sandbox, 'nightwatch.json'), '{"version":1,"armings":{}}\n', 'utf8');
    writeFileSync(join(sandbox, 'run-until.json'), '{"version":1,"armings":{}}\n', 'utf8');
  });
});

describe('button routes', () => {
  const HOST = '127.0.0.1:13232';

  it('serves the same three routes under both mount points', async () => {
    // `/run-until` stays mounted because 1.1.0 documented it; the button speaks
    // `/nightwatch`. One handler owns both so they cannot drift apart.
    const { host, agent } = await mount();
    for (const base of ['/nightwatch', '/run-until']) {
      const state = await host.request({
        path: `${base}/state?sessionId=${agent.session.id}`,
        headers: { host: HOST, 'sec-fetch-site': 'same-origin' },
      });
      assert.equal(state.status, 200);
      assert.equal(state.json.value.armed, false);
    }
    host.dispose();
  });

  it('arms and stops a session through the POST routes', async () => {
    const { host, agent } = await mount();
    const armed = await host.request({
      method: 'POST',
      path: '/nightwatch/arm',
      headers: { host: HOST, 'sec-fetch-site': 'same-origin', origin: `http://${HOST}` },
      body: { sessionId: agent.session.id, until: '+90m' },
    });
    assert.equal(armed.status, 200);
    assert.match(armed.json.text, /守夜已开启/u);
    const state = await host.request({
      path: `/nightwatch/state?sessionId=${agent.session.id}`,
      headers: { host: HOST },
    });
    assert.equal(state.json.value.armed, true);
    assert.ok(state.json.value.remainingMs > 0);

    const stopped = await host.request({
      method: 'POST',
      path: '/nightwatch/stop',
      headers: { host: HOST, 'sec-fetch-site': 'same-origin', origin: `http://${HOST}` },
      body: { sessionId: agent.session.id },
    });
    assert.equal(stopped.status, 200);
    assert.match(stopped.json.text, /守夜已停/u);
    host.dispose();
  });

  it('refuses a request another site told the browser to send', async () => {
    // The harness mounts plugin routes without the Host/Origin gate it applies
    // to its own `/api`, so a page the browser happens to have open could
    // otherwise arm a watch for a session id it guessed.
    const { host, agent } = await mount();
    const crossSite = await host.request({
      method: 'POST',
      path: '/nightwatch/arm',
      headers: {
        host: HOST,
        'sec-fetch-site': 'cross-site',
        origin: 'https://evil.example',
        'content-type': 'text/plain',
      },
      body: { sessionId: agent.session.id, until: '+90m' },
    });
    assert.equal(crossSite.status, 403);
    assert.equal(crossSite.json.error, 'cross-origin');

    const wrongOrigin = await host.request({
      method: 'POST',
      path: '/nightwatch/arm',
      headers: { host: HOST, origin: 'https://evil.example' },
      body: { sessionId: agent.session.id, until: '+90m' },
    });
    assert.equal(wrongOrigin.status, 403);

    // Nothing was armed by either attempt.
    const state = await host.request({
      path: `/nightwatch/state?sessionId=${agent.session.id}`,
      headers: { host: HOST },
    });
    assert.equal(state.json.value.armed, false);

    // A client with no browser markers at all (curl, a test) is still served:
    // this gate is about pages, not about authentication.
    const curl = await host.request({
      method: 'POST',
      path: '/nightwatch/arm',
      headers: { host: HOST },
      body: { sessionId: agent.session.id, until: '+90m' },
    });
    assert.equal(curl.status, 200);
    host.dispose();
  });

  it('rejects an unknown session instead of creating a record for it', async () => {
    const { host } = await mount();
    const state = await host.request({
      path: '/nightwatch/state?sessionId=session-nobody',
      headers: { host: HOST },
    });
    assert.equal(state.status, 404);
    assert.equal(state.json.error, 'unknown-session');
    const arm = await host.request({
      method: 'POST',
      path: '/nightwatch/arm',
      headers: { host: HOST },
      body: { sessionId: 'session-nobody', until: '+10m' },
    });
    assert.equal(arm.status, 404);
    host.dispose();
  });
});
