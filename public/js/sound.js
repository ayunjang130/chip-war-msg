// sound.js
// A tiny synthesized SFX layer - every sound is an oscillator + envelope,
// generated on the fly. No audio files, no CDN, nothing to host or load -
// exactly the "simple, online" constraint this needed to fit. Loaded as a
// plain global (`Sound`) before player.js/host.js, same pattern as icons.js.
(function (global) {
  let ctx = null;
  let enabled = true;
  const STORAGE_KEY = 'msg_sound_enabled';
  try {
    const saved = window.localStorage ? localStorage.getItem(STORAGE_KEY) : null;
    if (saved != null) enabled = saved === '1';
  } catch (e) {
    /* localStorage unavailable (private mode etc.) - default stays on */
  }

  function ensureCtx() {
    const AC = global.AudioContext || global.webkitAudioContext;
    if (!AC) return null;
    if (!ctx) ctx = new AC();
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx;
  }
  // Browsers block audio until a real user gesture - grab the first one,
  // anywhere on the page, so every Sound.x() call after that just works.
  ['pointerdown', 'keydown'].forEach((evt) => {
    document.addEventListener(evt, ensureCtx, { once: true, passive: true });
  });

  // One short tone: attack fast, decay to silence, optional pitch slide.
  // This one primitive is enough to build every effect below out of 1-4 calls.
  function tone(freq, duration, opts) {
    if (!enabled) return;
    const c = ensureCtx();
    if (!c) return;
    opts = opts || {};
    const t0 = c.currentTime + (opts.delay || 0);
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = opts.type || 'sine';
    osc.frequency.setValueAtTime(freq, t0);
    if (opts.slideTo) osc.frequency.exponentialRampToValueAtTime(opts.slideTo, t0 + duration);
    const peak = opts.gain != null ? opts.gain : 0.15;
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(peak, t0 + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
    osc.connect(gain).connect(c.destination);
    osc.start(t0);
    osc.stop(t0 + duration + 0.03);
  }

  const Sound = {
    setEnabled(v) {
      enabled = !!v;
      try {
        if (window.localStorage) localStorage.setItem(STORAGE_KEY, enabled ? '1' : '0');
      } catch (e) {
        /* ignore */
      }
    },
    isEnabled() {
      return enabled;
    },
    // light UI taps - channel tabs, generic clicks
    click() {
      tone(720, 0.045, { type: 'square', gain: 0.05 });
    },
    // sending a chat message - deliberately quiet, this happens a lot
    tick() {
      tone(880, 0.03, { type: 'sine', gain: 0.04 });
    },
    // Tech/Capacity purchase - an upward slide reads as "leveling up"
    buy() {
      tone(520, 0.09, { type: 'triangle', gain: 0.09, slideTo: 780 });
    },
    // undo - the mirror of buy(), sliding down instead of up
    undo() {
      tone(420, 0.09, { type: 'triangle', gain: 0.08, slideTo: 260 });
    },
    // blocked action (profanity filter, non-leader posting in All Teams)
    error() {
      tone(180, 0.16, { type: 'sawtooth', gain: 0.06, slideTo: 120 });
    },
    // Lock In - the single biggest commit in a round, gets a two-tone "thud"
    lockIn() {
      tone(180, 0.11, { type: 'sine', gain: 0.16 });
      tone(90, 0.22, { type: 'sine', gain: 0.14, delay: 0.05 });
    },
    // a new Market Shock just landed for the round
    shock() {
      tone(220, 0.4, { type: 'sawtooth', gain: 0.05, slideTo: 320 });
      tone(660, 0.08, { type: 'square', gain: 0.05, delay: 0.05 });
    },
    // round results just revealed (everyone hears this, win or lose)
    results() {
      tone(500, 0.16, { type: 'sine', gain: 0.08, slideTo: 340 });
    },
    // round-winner celebration / final-match winner
    victory() {
      [523, 659, 784, 1046].forEach((f, i) => tone(f, 0.18, { type: 'triangle', gain: 0.1, delay: i * 0.09 }));
    }
  };

  global.Sound = Sound;
})(window);
