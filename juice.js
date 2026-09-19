// juice.js
// Small, reusable "physical feedback" primitives - the part of game feel
// that has nothing to do with sound: a button that visibly compresses under
// a click, a number that rolls instead of snapping, a screen that flinches
// on a big moment. Pure CSS class toggles + one particle-burst helper, no
// animation library. Loaded as a plain global (`Juice`) before player.js/
// host.js, same pattern as icons.js and sound.js.
(function (global) {
  // Restarting a CSS animation on an element that already has the class
  // requires removing it, forcing reflow, then re-adding it - otherwise the
  // second-and-later trigger is a no-op because the class never "changed".
  function retrigger(el, cls) {
    if (!el) return;
    el.classList.remove(cls);
    void el.offsetWidth; // eslint-disable-line no-unused-expressions
    el.classList.add(cls);
  }

  function squish(el) {
    retrigger(el, 'juice-squish');
  }
  function shake(el) {
    retrigger(el, 'juice-shake');
  }
  function flashLevelUp(el) {
    retrigger(el, 'juice-levelup');
  }

  // Rolls a number from `from` to `to` over `duration`ms instead of
  // snapping instantly - the incremental-game "number go up" feeling.
  function countUp(el, from, to, opts) {
    if (!el) return;
    opts = opts || {};
    const duration = opts.duration || 500;
    const prefix = opts.prefix || '';
    const suffix = opts.suffix || '';
    const startVal = Number(from) || 0;
    const endVal = Number(to) || 0;
    if (startVal === endVal) {
      el.textContent = prefix + endVal.toLocaleString() + suffix;
      return;
    }
    const start = performance.now();
    function frame(now) {
      const p = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - p, 3); // ease-out cubic
      const val = Math.round(startVal + (endVal - startVal) * eased);
      el.textContent = prefix + val.toLocaleString() + suffix;
      if (p < 1) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  // A small burst of DOM dots flying out from an element's center and
  // fading - a generalized version of the existing money-rain celebration,
  // sized for a single button press rather than a whole-screen moment.
  function burst(el, opts) {
    if (!el) return;
    opts = opts || {};
    const n = opts.count || 7;
    const color = opts.color || 'var(--gold)';
    const rect = el.getBoundingClientRect();
    const originX = rect.left + rect.width / 2;
    const originY = rect.top + rect.height / 2;
    for (let i = 0; i < n; i++) {
      const p = document.createElement('span');
      p.className = 'juice-particle';
      const angle = (Math.PI * 2 * i) / n + Math.random() * 0.4;
      const dist = 22 + Math.random() * 16;
      p.style.setProperty('--dx', Math.cos(angle) * dist + 'px');
      p.style.setProperty('--dy', Math.sin(angle) * dist + 'px');
      p.style.left = originX + 'px';
      p.style.top = originY + 'px';
      p.style.background = color;
      document.body.appendChild(p);
      p.addEventListener('animationend', () => p.remove());
    }
  }

  global.Juice = { squish, shake, flashLevelUp, countUp, burst };
})(window);
