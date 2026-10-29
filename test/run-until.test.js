/**
 * Tests for `run-until`.
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
const sandbox = mkdtempSync(join(tmpdir(), 'run-until-'));
process.env.DSH_HOME = sandbox;

const policy = await import('../lib/policy.js');
const plugin = await import('../lib/index.js');
const { FakeHost, until } = await import('./fake-host.js');

const {
  DEFAULTS,
  parseDeadline,
  parseCommand,
  readSettings,
  decide,
  decideHeartbeat,
  renderContinueText,
  remainingLabel,
  describeArming,
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

describe('parseCommand', () => {
  it('reads the three words this command owns', () => {
    assert.equal(parseCommand('').kind, 'show');
    assert.equal(parseCommand('  ').kind, 'show');
    assert.equal(parseCommand('状态').kind, 'show');
    assert.equal(parseCommand('stop').kind, 'stop');
    assert.equal(parseCommand('停').kind, 'stop');
    assert.equal(parseCommand('OFF').kind, 'stop');
  });

  it('treats everything else as a deadline, including nonsense', () => {
    assert.deepEqual(parseCommand('22:30'), { kind: 'arm', raw: '22:30' });
    assert.deepEqual(parseCommand('+90m'), { kind: 'arm', raw: '+90m' });
    assert.deepEqual(parseCommand('随便写的'), { kind: 'arm', raw: '随便写的' });
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

/** Run one `/run-until <arg>` through the registered command. */
async function runCommand(host, agent, rawInput) {
  const definition = [...host.commands.values()][0];
  assert.ok(definition, 'the command should be registered');
  return definition.handler({ agent, rawInput, attachments: [] });
}

describe('plugin integration', () => {
  it('registers exactly one slash command with a valid name', async () => {
    const { host } = await mount();
    assert.deepEqual([...host.commands.keys()], ['run-until']);
    const definition = host.commands.get('run-until');
    assert.match(definition.name, /^[a-z][a-z0-9_-]*$/u);
    assert.ok(definition.description.length > 0);
    assert.equal(typeof definition.handler, 'function');
    host.dispose();
  });

  it('reports its state before anything is armed', async () => {
    const { host, agent } = await mount();
    const result = await runCommand(host, agent, '');
    assert.equal(result.kind, 'success');
    assert.match(result.text, /未开启/u);
    host.dispose();
  });

  it('refuses a deadline it cannot read, and stays disarmed', async () => {
    const { host, agent } = await mount();
    const result = await runCommand(host, agent, '瞎写的');
    assert.equal(result.kind, 'error');
    assert.match(result.text, /看不懂/u);
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
    const armed = await runCommand(host, agent, '+400ms');
    assert.equal(armed.kind, 'success');

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
    await runCommand(host, agent, '+600ms');
    agent.startTurn();
    agent.endTurn(host);
    await until(() => agent.received.length === 1, { label: 'wrap-up continuation' });
    assert.match(agent.received[0].content[0].text, /收尾/u);
    host.dispose();
  });

  it('stops immediately on the stop word', async () => {
    const { host, agent } = await mount();
    await runCommand(host, agent, '+10m');
    const stopped = await runCommand(host, agent, 'stop');
    assert.equal(stopped.kind, 'success');
    assert.match(stopped.text, /已续跑 0 轮/u);
    agent.startTurn();
    agent.endTurn(host);
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(agent.received.length, 0);
    host.dispose();
  });

  it('enforces the round cap', async () => {
    const { host, agent } = await mount({ maxRounds: 2 });
    await runCommand(host, agent, '+10m');
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
    await runCommand(host, agent, '+10m');
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
    await runCommand(host, agent, '+10m');
    agent.startTurn();
    agent.endTurn(host, 'aborted');
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(agent.received.length, 0);
    host.dispose();
  });

  it('stops after a streak of rounds that touched no tool', async () => {
    const { host, agent } = await mount({ maxIdleRounds: 2 });
    await runCommand(host, agent, '+10m');
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
    await runCommand(host, agent, '+10m');
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
    await runCommand(host, agent, '+10m');
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
    await runCommand(host, agent, '+10m');
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
    await runCommand(host, agent, '+10m');
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
    await runCommand(host, agent, '+30m');
    const raw = JSON.parse(readFileSync(join(sandbox, 'run-until.json'), 'utf8'));
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
      join(sandbox, 'run-until.json'),
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
    writeFileSync(join(sandbox, 'run-until.json'), '{"version":1,"armings":{}}\n', 'utf8');
  });

  it('drops the arming when the session is disposed', async () => {
    const { host, agent } = await mount();
    await runCommand(host, agent, '+30m');
    host.emit('session/disposed', agent.session);
    await new Promise((r) => setTimeout(r, 20));
    const raw = JSON.parse(readFileSync(join(sandbox, 'run-until.json'), 'utf8'));
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
      join(sandbox, 'run-until.json'),
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
    await runCommand(host, agent, '+90m');
    await new Promise((r) => setTimeout(r, 30));

    const raw = JSON.parse(readFileSync(join(sandbox, 'run-until.json'), 'utf8'));
    assert.ok(raw.armings['session-crash'], 'the unloaded arming is still persisted');
    assert.equal(raw.armings['session-crash'].deadline, crashDeadline);
    assert.equal(raw.armings['session-crash'].rounds, 3);
    host.dispose();
  });

  it('forgets an arming that expired while nothing was watching', async () => {
    const staleDeadline = Date.now() - 60_000;
    writeFileSync(
      join(sandbox, 'run-until.json'),
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
    const raw = JSON.parse(readFileSync(join(sandbox, 'run-until.json'), 'utf8'));
    assert.equal(raw.armings['session-stale'], undefined, 'the stale record is dropped');
    host.dispose();
  });
});
