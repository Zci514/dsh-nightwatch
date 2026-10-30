/**
 * A miniature stand-in for the parts of the DSH host that `nightwatch` touches.
 *
 * The point is to run the real plugin file — its real `apply()`, its real event
 * wiring, its real timers — against a fake host that is *fast* (millisecond
 * deadlines instead of hours) and *inspectable* (every follow-up is recorded).
 * Nothing here is smart: the fake agent is a status flag plus an inbox, exactly
 * like the real one, so a plugin that forgets `whenIdle()` or ignores a queued
 * message fails here the same way it would in the harness.
 */

import { EventEmitter } from 'node:events';

/** Fake settings service entry: an object with `get`, like a volatile cell. */
export function cell(value) {
  return { get: () => value };
}

/**
 * One fake agent.
 *
 * `run()` mimics a turn: status goes running, then idle again, which is what
 * lets a plugin continue itself. Tests drive it explicitly so the timing is
 * deterministic instead of wall-clock dependent.
 */
export class FakeAgent {
  constructor(sessionId) {
    this.id = sessionId;
    this.session = { id: sessionId };
    this.status = 'idle';
    this.inbox = { nextTurn: [], nextStep: [] };
    /** Every message ever followed up on, in order. */
    this.received = [];
    /** Cancels requested by the plugin, in order. */
    this.cancellations = [];
  }

  followup(message) {
    this.received.push(message);
    this.inbox.nextTurn.push(message);
  }

  /**
   * Poll until idle.
   *
   * The real `Agent.whenIdle()` awaits the driver's activity promise. Polling
   * reproduces the observable contract — "resolve once the turn is over" —
   * without the fake having to model the driver, and it survives a test that
   * flips `status` directly.
   */
  async whenIdle() {
    while (this.status !== 'idle') await sleep(5);
  }

  cancel(cause, _options) {
    this.cancellations.push(cause);
    this.status = 'idle';
  }

  /** Enter a turn. */
  startTurn() {
    this.status = 'running';
    this.inbox.nextTurn.length = 0;
  }

  /** Finish the current turn and announce it through the host. */
  endTurn(host, reason = 'completed') {
    this.status = 'idle';
    // Production shape: the session layer publishes `{type, seq, time, data}`,
    // so the turn-end reason lives at `event.data.reason` — never on the event
    // itself. Mirroring that here is what makes these tests able to catch a
    // plugin that reads the wrong path.
    host.emit('session/event', this.session, {
      type: 'turn/end',
      seq: 0,
      time: Date.now(),
      data: { turn: 1, reason: { kind: reason } },
    });
    host.emit('agent/status', { agent: this, status: 'idle' });
  }
}

/**
 * A fake cordis context.
 *
 * Implements only the surface `nightwatch` uses. `inject` runs its callback
 * immediately with the same object, which mirrors the real behaviour closely
 * enough for a plugin whose injected service is always present.
 */
export class FakeHost {
  constructor() {
    this.bus = new EventEmitter({ captureRejections: false });
    this.bus.setMaxListeners(0);
    this.agentsById = new Map();
    this.commands = new Map();
    this.logs = [];
    this.disposers = [];
    this.agents = {
      get: (id) => this.agentsById.get(id),
      list: () => [...this.agentsById.values()],
    };
    this.services = {
      agents: this.agents,
      commands: {
        register: (definition) => {
          if (this.commands.has(definition.name)) {
            throw new Error(`command "${definition.name}" is already registered`);
          }
          this.commands.set(definition.name, definition);
          return () => this.commands.delete(definition.name);
        },
      },
      webServer: {
        register: (route) => {
          // Duplicate (kind, path) throws in the real webserver; mirroring that
          // here is what keeps a second registration from passing silently.
          const key = `${route.kind}:${route.path}`;
          if (this.routes.has(key)) throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`);
          this.routes.set(key, route);
          return () => this.routes.delete(key);
        },
      },
    };
    /** Registered HTTP routes, keyed by `kind:path`. */
    this.routes = new Map();
  }

  /** The route whose prefix owns `pathname`, longest prefix first. */
  routeFor(pathname) {
    let best;
    for (const route of this.routes.values()) {
      if (route.kind === 'exact') {
        if (route.path === pathname) return route;
        continue;
      }
      if (pathname !== route.path && !pathname.startsWith(`${route.path}/`)) continue;
      if (best === undefined || route.path.length > best.path.length) best = route;
    }
    return best;
  }

  /**
   * Drive one request through the mounted routes and return the recorded reply.
   *
   * @param options.method - HTTP method.
   * @param options.path - full path including the query string.
   * @param options.headers - request headers (lower-case keys).
   * @param options.body - JSON body, serialized as the request stream.
   * @returns `{ status, headers, json }` — `json` is parsed when it parses.
   */
  async request({ method = 'GET', path, headers = {}, body = undefined }) {
    const route = this.routeFor(path.split('?')[0]);
    if (route === undefined) throw new Error(`no route for ${path}`);
    const payload = body === undefined ? '' : JSON.stringify(body);
    const req = {
      method,
      url: path,
      headers,
      async *[Symbol.asyncIterator]() {
        if (payload !== '') yield Buffer.from(payload);
      },
    };
    const record = { status: 200, headers: {}, body: '' };
    const res = {
      writeHead(status, outgoing) {
        record.status = status;
        record.headers = outgoing ?? {};
      },
      end(chunk) {
        record.body = String(chunk ?? '');
      },
    };
    await route.handler(req, res);
    let json;
    try {
      json = JSON.parse(record.body);
    } catch {
      json = undefined;
    }
    return { ...record, json };
  }

  /** Add one agent and return it. */
  addAgent(sessionId) {
    const agent = new FakeAgent(sessionId);
    this.agentsById.set(sessionId, agent);
    return agent;
  }

  on(event, listener) {
    this.bus.on(event, listener);
    return () => this.bus.off(event, listener);
  }

  emit(...args) {
    this.bus.emit(...args);
  }

  effect(body) {
    const dispose = body();
    if (typeof dispose === 'function') this.disposers.push(dispose);
    return dispose;
  }

  inject(names, callback) {
    const child = this.child(names);
    return callback(child);
  }

  /** A same-shaped context that only exposes the named services. */
  child(names = []) {
    const ctx = Object.create(this);
    for (const name of names) ctx[name] = this.services[name];
    return ctx;
  }

  logger(label) {
    return {
      info: (message) => this.logs.push(['info', label, message]),
      debug: (message) => this.logs.push(['debug', label, message]),
      warn: (message) => this.logs.push(['warn', label, message]),
      error: (error) => this.logs.push(['error', label, String(error)]),
    };
  }

  /** Run every registered teardown. */
  dispose() {
    for (const dispose of this.disposers.splice(0)) dispose();
    this.bus.removeAllListeners();
  }
}

/** Await this many real milliseconds. */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll until `predicate` holds, or throw after `timeoutMs`. */
export async function until(predicate, { timeoutMs = 2_000, stepMs = 5, label = 'condition' } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await sleep(stepMs);
  }
  throw new Error(`timed out waiting for ${label}`);
}
