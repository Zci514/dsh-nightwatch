/**
 * dsh-run-until — Client half.
 *
 * 一颗放进输入框工具条的按钮：点开选/填一个钟点，会话就一直替你说「继续」到那个
 * 时刻；到点自己停。按钮本身显示还剩多久，点一下能立刻停。
 *
 * 没有 `dsh.client` 之外的新机制：注册一个 `conversation.input.left` 槽位，宿主侧
 * 通过 `/run-until/{state,arm,stop}` 三个本地路由读写守夜记录 —— 走 HTTP 而不是
 * 走 `/run-until` slash 命令，是因为发命令会在对话里留下一条命令流水，而按钮点十
 * 次就该只在界面上变十次。
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-run-until',
  factory(require) {
    const React = require('react');
    let ReactDOM = null;
    try {
      ReactDOM = require('react-dom');
    } catch {
      ReactDOM = null;
    }
    const h = React.createElement;
    const { useCallback, useEffect, useMemo, useRef, useState } = React;

    const NS = 'run-until';

    const zh = {
      btn: '守夜',
      btnArmed: '守夜 · {left}',
      title: '守夜：一直干到几点',
      body: '到点之前，每轮答完就自动接一句「继续」；到最后 {n} 分钟切成收尾语气。到点不再开新的一轮。',
      quick: '快点选',
      'q.30m': '+30 分',
      'q.1h': '+1 小时',
      'q.2h': '+2 小时',
      'q.2300': '今晚 23:00',
      'q.7am': '明早 7:00',
      'q.8h': '+8 小时',
      custom: '或者自己填',
      hint: '例：22:30 / +90m / 明天 07:00',
      start: '开始守夜',
      update: '改到',
      stop: '立刻停',
      cancel: '取消',
      busy: '提交中…',
      fail: '没成功：',
      armed: '守夜进行中 · 还剩 {left} · 已接 {rounds} 轮',
      stopped: '守夜已停',
      notArmed: '还没开守夜',
      cap: '上限 {n} 轮',
      stopping: '快到点了，正在收尾',
      closeHint: '点空白处关闭',
    };

    const en = {
      btn: 'Night watch',
      btnArmed: 'Until {left}',
      title: 'Night watch: keep going until a clock time',
      body: 'Until that time, each finished turn is followed by one automatic "continue"; the last {n} minutes switch to a wrap-up tone. No new turn is opened after the deadline.',
      quick: 'Quick picks',
      'q.30m': '+30 min',
      'q.1h': '+1 hour',
      'q.2h': '+2 hours',
      'q.2300': '23:00 tonight',
      'q.7am': '07:00 tomorrow',
      'q.8h': '+8 hours',
      custom: 'Or type one',
      hint: 'e.g. 22:30 / +90m / tomorrow 07:00',
      start: 'Start',
      update: 'Change to',
      stop: 'Stop now',
      cancel: 'Cancel',
      busy: 'Submitting…',
      fail: 'Failed: ',
      armed: 'Running · {left} left · {rounds} rounds',
      stopped: 'Stopped',
      notArmed: 'No watch running',
      cap: 'cap {n} rounds',
      stopping: 'Wrapping up',
      closeHint: 'Click outside to close',
    };

    /** `2h15m` / `45m` / `30s` — compact enough for a 26px pill. */
    function shortLeft(ms) {
      if (!(ms > 0)) return '0m';
      const totalMinutes = Math.ceil(ms / 60_000);
      if (totalMinutes >= 60) {
        const hours = Math.floor(totalMinutes / 60);
        const minutes = totalMinutes % 60;
        return minutes === 0 ? hours + 'h' : hours + 'h' + minutes + 'm';
      }
      if (totalMinutes >= 1) return totalMinutes + 'm';
      return Math.max(1, Math.ceil(ms / 1_000)) + 's';
    }

    const QUICK = [
      { key: 'q.30m', value: '+30m' },
      { key: 'q.1h', value: '+1h' },
      { key: 'q.2h', value: '+2h' },
      { key: 'q.2300', value: '23:00' },
      { key: 'q.7am', value: '明天 07:00' },
      { key: 'q.8h', value: '+8h' },
    ];

    const CSS = `
      .dsh-ru-wrap { position: relative; display: inline-flex; }
      .dsh-ru-btn { height: 26px; padding: 0 9px; display: inline-flex; align-items: center; gap: 5px;
        border-radius: 6px; border: 1px solid var(--dsw-alias-border-l1);
        background: transparent; color: var(--dsw-alias-label-primary);
        font: inherit; font-size: 12px; font-weight: 600; letter-spacing: .2px;
        cursor: pointer; white-space: nowrap; transition: background 120ms ease, border-color 120ms ease; }
      .dsh-ru-btn:hover { background: rgba(255,255,255,0.07); }
      .dsh-ru-btn.is-armed { border-color: var(--dsw-alias-state-success-primary, #2f7d4f);
        background: rgba(47,125,79,0.12); }
      .dsh-ru-btn.is-stopping { border-color: var(--dsw-alias-state-warn-primary, #b7791f);
        background: rgba(183,121,31,0.14); }
      .dsh-ru-dot { width: 6px; height: 6px; border-radius: 50%; flex: none;
        background: currentColor; opacity: .55; }
      .dsh-ru-btn.is-armed .dsh-ru-dot { opacity: 1;
        box-shadow: 0 0 0 0 rgba(47,125,79,.55); animation: dsh-ru-pulse 2s infinite; }
      @keyframes dsh-ru-pulse { 0%{box-shadow:0 0 0 0 rgba(47,125,79,.45)}
        70%{box-shadow:0 0 0 5px rgba(47,125,79,0)} 100%{box-shadow:0 0 0 0 rgba(47,125,79,0)} }
      .dsh-ru-glyph { font-size: 13px; line-height: 1; opacity: .8; }
      .dsh-ru-mask { position: fixed; inset: 0; z-index: 60; }
      .dsh-ru-card { position: fixed; z-index: 61; width: 300px; box-sizing: border-box;
        padding: 14px; border-radius: 12px;
        border: 1px solid var(--dsw-alias-border-l1);
        background: var(--dsw-alias-bg-overlay, #1b1d21);
        box-shadow: 0 12px 34px rgba(0,0,0,.42);
        color: var(--dsw-alias-label-primary); }
      .dsh-ru-h { font-size: 13.5px; font-weight: 700; margin: 0 0 6px; }
      .dsh-ru-sub { margin: 0 0 10px; font-size: 11.5px; line-height: 1.55;
        color: var(--dsw-alias-label-secondary); }
      .dsh-ru-status { margin: 0 0 10px; padding: 7px 9px; border-radius: 8px;
        font-size: 11.5px; line-height: 1.5;
        border: 1px solid var(--dsw-alias-border-l1); background: rgba(255,255,255,0.03); }
      .dsh-ru-status.is-armed { border-color: var(--dsw-alias-state-success-primary, #2f7d4f); }
      .dsh-ru-label { font-size: 11px; font-weight: 600; opacity: .6; margin: 0 0 5px; }
      .dsh-ru-quick { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 11px; }
      .dsh-ru-chip { height: 27px; padding: 0 9px; border-radius: 7px; font: inherit;
        font-size: 11.5px; cursor: pointer; color: inherit;
        border: 1px solid var(--dsw-alias-border-l1); background: transparent;
        transition: background 120ms ease; }
      .dsh-ru-chip:hover { background: rgba(255,255,255,0.07); }
      .dsh-ru-chip:disabled { opacity: .4; cursor: default; }
      .dsh-ru-input { width: 100%; box-sizing: border-box; height: 33px; padding: 0 10px;
        border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1);
        background: rgba(255,255,255,0.03); color: inherit; font: inherit; font-size: 12.5px;
        outline: none; transition: border-color 120ms ease; }
      .dsh-ru-input:focus { border-color: var(--dsw-alias-state-success-primary, #2f7d4f); }
      .dsh-ru-input::placeholder { opacity: .4; }
      .dsh-ru-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
      .dsh-ru-act { height: 32px; padding: 0 14px; border-radius: 8px; font: inherit;
        font-size: 12.5px; cursor: pointer; transition: opacity 120ms ease; }
      .dsh-ru-act:active { transform: scale(.985); }
      .dsh-ru-cancel { border: 1px solid var(--dsw-alias-border-l1); background: transparent;
        color: var(--dsw-alias-label-primary); }
      .dsh-ru-cancel:hover { background: rgba(255,255,255,0.06); }
      .dsh-ru-go { border: none; font-weight: 600; color: #fff;
        background: var(--dsw-alias-state-success-primary, #2f7d4f); }
      .dsh-ru-go:hover { opacity: .9; }
      .dsh-ru-go:disabled { opacity: .5; cursor: default; }
      .dsh-ru-stop { border: 1px solid var(--dsw-alias-state-error-primary, #c53030);
        background: transparent; color: var(--dsw-alias-state-error-primary, #c53030); }
      .dsh-ru-stop:hover { background: rgba(197,48,48,0.12); }
      .dsh-ru-err { font-size: 11.5px; margin-top: 8px;
        color: var(--dsw-alias-state-error-primary, #c53030); }
      .dsh-ru-hint { font-size: 10.5px; opacity: .4; margin-top: 7px; }
    `;

    const BtnGlyph = () =>
      h(
        'span',
        { className: 'dsh-ru-glyph', key: 'g' },
        '\u263D', // crescent moon
      );

    function makeButton(ctx) {
      return function RunUntilButton(props) {
        const t = props.t;
        const sessionId = props.sessionId;
        const [snapshot, setSnapshot] = useState(null);
        const [open, setOpen] = useState(false);
        const [text, setText] = useState('');
        const [busy, setBusy] = useState(false);
        const [error, setError] = useState(null);
        const anchorRef = useRef(null);
        /** Measured card, so placement uses the real height instead of a guess. */
        const cardRef = useRef(null);
        const [anchor, setAnchor] = useState(null);

        useEffect(() => {
          if (typeof props.onActiveChange === 'function') props.onActiveChange(false);
        }, []);

        const wrapMinutes = snapshot?.wrapUpMinutes ?? 10;

        const pull = useCallback(async () => {
          if (typeof sessionId !== 'string' || sessionId === '') return;
          try {
            const res = await fetch(
              '/run-until/state?sessionId=' + encodeURIComponent(sessionId),
              { cache: 'no-store' },
            );
            if (!res.ok) return;
            const body = await res.json();
            if (body && body.ok === true) setSnapshot(body.value);
          } catch {
            // A dropped poll is not worth surfacing; the next one will land.
          }
        }, [sessionId]);

        // Poll faster while armed: the pill shows a live countdown, and a stale
        // minute on screen reads as a broken plugin.
        useEffect(() => {
          let cancelled = false;
          pull();
          const armed = snapshot?.armed === true;
          const period = armed ? 5_000 : 20_000;
          const timer = setInterval(() => {
            if (!cancelled) pull();
          }, period);
          return () => {
            cancelled = true;
            clearInterval(timer);
          };
        }, [pull, snapshot?.armed]);

        const place = useCallback(() => {
          const el = anchorRef.current;
          const card = cardRef.current;
          if (el === null) return;
          const r = el.getBoundingClientRect();
          // Measure the card instead of guessing: the content height changes with
          // the status line (armed adds a row) and with error text, and a guessed
          // constant pushed the action buttons off the bottom of the viewport.
          const width = Math.min(320, window.innerWidth - 16);
          const height = card === null ? 300 : card.getBoundingClientRect().height;
          const left = Math.min(
            Math.max(8, r.left),
            Math.max(8, window.innerWidth - width - 8),
          );
          const aboveTop = r.top - height - 10;
          const belowTop = r.bottom + 10;
          // Prefer above the composer (it is at the bottom of the view); fall
          // back below only when above genuinely does not fit.
          const top = aboveTop >= 8 ? aboveTop : belowTop;
          setAnchor({
            left,
            top: Math.max(8, Math.min(top, Math.max(8, window.innerHeight - height - 8))),
          });
        }, []);

        const openCard = () => {
          setError(null);
          setText('');
          setOpen(true);
        };

        // Position after the card exists, then keep it on screen through resizes.
        useEffect(() => {
          if (!open) return undefined;
          const frame = requestAnimationFrame(place);
          const onResize = () => place();
          window.addEventListener('resize', onResize);
          window.addEventListener('scroll', onResize, true);
          return () => {
            cancelAnimationFrame(frame);
            window.removeEventListener('resize', onResize);
            window.removeEventListener('scroll', onResize, true);
          };
        }, [open, place]);

        const arm = async (value) => {
          const until = String(value ?? '').trim();
          if (until === '') {
            setError(t('hint'));
            return;
          }
          setBusy(true);
          setError(null);
          try {
            const res = await fetch('/run-until/arm', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ sessionId, until }),
            });
            const body = await res.json();
            if (!body || body.ok !== true) throw new Error((body && body.text) || 'arm-failed');
            setOpen(false);
            await pull();
          } catch (err) {
            setError(String((err && err.message) || err));
          } finally {
            setBusy(false);
          }
        };

        const stop = async () => {
          setBusy(true);
          setError(null);
          try {
            const res = await fetch('/run-until/stop', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ sessionId }),
            });
            const body = await res.json();
            if (!body || body.ok !== true) throw new Error('stop-failed');
            setOpen(false);
            await pull();
          } catch (err) {
            setError(String((err && err.message) || err));
          } finally {
            setBusy(false);
          }
        };

        const armed = snapshot?.armed === true;
        const left = armed ? shortLeft(snapshot.remainingMs) : '';
        const stoppingSoon = armed && snapshot.stoppingSoon === true;
        const rounds = snapshot?.rounds ?? 0;
        const cap = snapshot?.roundsCap ?? 0;

        const trigger = h(
          'button',
          {
            type: 'button',
            ref: anchorRef,
            className: 'dsh-ru-btn' + (armed ? (stoppingSoon ? ' is-stopping' : ' is-armed') : ''),
            onClick: openCard,
            title: armed ? t('armed', { left, rounds }) : t('title'),
          },
          h('span', { className: 'dsh-ru-dot', key: 'd' }),
          BtnGlyph(),
          h(
            'span',
            { key: 'l' },
            armed ? t('btnArmed', { left }) : t('btn'),
          ),
        );

        const status = h(
          'div',
          { className: 'dsh-ru-status' + (armed ? ' is-armed' : '') },
          armed
            ? t('armed', { left: left, rounds: String(rounds) })
              + (cap > 0 ? ' · ' + t('cap', { n: String(cap) }) : '')
              + (stoppingSoon ? ' · ' + t('stopping') : '')
            : t('notArmed'),
        );

        const card = open
          ? h(
              'div',
              { className: 'dsh-ru-mask', onClick: () => setOpen(false) },
              h(
                'div',
                {
                  className: 'dsh-ru-card',
                  ref: cardRef,
                  // Hidden for the first frame: rendered so it can be measured,
                  // but not shown at a stale position.
                  style: anchor === null
                    ? { left: 8, top: 8, visibility: 'hidden' }
                    : { left: anchor.left, top: anchor.top },
                  onClick: (event) => event.stopPropagation(),
                },
                h('div', { className: 'dsh-ru-h' }, t('title')),
                h('p', { className: 'dsh-ru-sub' }, t('body', { n: String(wrapMinutes) })),
                status,

                h('div', { className: 'dsh-ru-label' }, t('quick')),
                h(
                  'div',
                  { className: 'dsh-ru-quick' },
                  QUICK.map((item) =>
                    h(
                      'button',
                      {
                        key: item.value,
                        type: 'button',
                        className: 'dsh-ru-chip',
                        disabled: busy,
                        onClick: () => arm(item.value),
                      },
                      props.lang === 'en' ? item.en : item.label,
                      t(item.key),
                    ),
                  ),
                ),

                h('div', { className: 'dsh-ru-label' }, t('custom')),
                h('input', {
                  className: 'dsh-ru-input',
                  type: 'text',
                  value: text,
                  placeholder: t('hint'),
                  onChange: (event) => setText(event.target.value),
                  onKeyDown: (event) => {
                    if (event.key === 'Enter' && !busy) arm(text);
                    else if (event.key === 'Escape') setOpen(false);
                  },
                }),

                error !== null ? h('div', { className: 'dsh-ru-err' }, t('fail') + error) : null,

                h(
                  'div',
                  { className: 'dsh-ru-actions' },
                  armed
                    ? h(
                        'button',
                        {
                          type: 'button',
                          className: 'dsh-ru-act dsh-ru-stop',
                          disabled: busy,
                          onClick: stop,
                        },
                        t('stop'),
                      )
                    : null,
                  h(
                    'button',
                    { type: 'button', className: 'dsh-ru-act dsh-ru-cancel', onClick: () => setOpen(false) },
                    t('cancel'),
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dsh-ru-act dsh-ru-go',
                      disabled: busy || text.trim() === '',
                      onClick: () => arm(text),
                    },
                    busy ? t('busy') : armed ? t('update') : t('start'),
                  ),
                ),
                h('div', { className: 'dsh-ru-hint' }, t('closeHint')),
              ),
            )
          : null;

        const portal =
          card !== null && ReactDOM !== null && ReactDOM.createPortal
            ? ReactDOM.createPortal(card, document.body)
            : card;

        return h(
          'div',
          { className: 'dsh-ru-wrap' },
          h('style', { key: 'css' }, CSS),
          trigger,
          portal,
        );
      };
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'run-until: dictionaries');
      const Button = makeButton(ctx);
      ctx.slots.inject('conversation.input.left', () =>
        ctx.slots.register(
          {
            name: 'conversation.input.left',
            id: 'run-until',
            order: 110,
            locale: NS,
            inject: (sessionId) => ({ sessionId }),
          },
          Button,
        ),
      );
    }

    return {
      inject: ['slots', 'sessions', 'locale'],
      apply,
    };
  },
});