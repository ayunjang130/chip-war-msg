// wafer.js
// The entry-screen hero: a silicon wafer map (the grid-of-dies view every
// fab uses to show yield), repurposed as a live market tape. Dies flicker
// red (price up) and blue (price down) the way quotes tick on a trading
// board, and a gold inspection line sweeps across now and then.
// Pure canvas, no dependencies. Draws one static frame when the user
// prefers reduced motion.
(function (global) {
  function WaferMap(canvas) {
    const ctx = canvas.getContext('2d');
    const reduce = global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let dies = [];
    let w = 0, h = 0, dpr = 1, cx = 0, cy = 0, R = 0, cell = 0;
    let sweep = -1;
    let raf = null;

    function layout() {
      dpr = Math.min(global.devicePixelRatio || 1, 2);
      w = canvas.clientWidth;
      h = canvas.clientHeight;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      R = Math.min(w, h) * 0.46;
      cx = w * 0.56;
      cy = h * 0.42;
      cell = Math.max(10, Math.round(R / 13));
      dies = [];
      const n = Math.ceil(R / cell);
      for (let i = -n; i < n; i++) {
        for (let j = -n; j < n; j++) {
          const x = cx + i * cell, y = cy + j * cell;
          // a die is on the wafer only if all four corners are inside the circle
          const corners = [[x, y], [x + cell, y], [x, y + cell], [x + cell, y + cell]];
          if (corners.every(([px, py]) => Math.hypot(px - cx, py - cy) < R - 4)) {
            dies.push({ x, y, heat: 0, dir: 0, base: Math.random() * 0.06 });
          }
        }
      }
    }

    function draw() {
      ctx.clearRect(0, 0, w, h);
      // wafer disc + flat
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0.12 * Math.PI, 2.38 * Math.PI);
      ctx.closePath();
      const g = ctx.createRadialGradient(cx - R * 0.3, cy - R * 0.35, R * 0.1, cx, cy, R);
      g.addColorStop(0, '#1d2a3d');
      g.addColorStop(1, '#111a26');
      ctx.fillStyle = g;
      ctx.fill();
      ctx.strokeStyle = '#2c3b52';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.restore();

      const gap = Math.max(1.5, cell * 0.12);
      dies.forEach((d) => {
        let fill;
        if (d.heat > 0.02) {
          const a = 0.25 + d.heat * 0.75;
          fill = d.dir > 0 ? `rgba(240,70,77,${a})` : `rgba(61,139,253,${a})`;
        } else {
          fill = `rgba(150,170,200,${0.07 + d.base})`;
        }
        ctx.fillStyle = fill;
        ctx.fillRect(d.x + gap / 2, d.y + gap / 2, cell - gap, cell - gap);
      });

      if (sweep >= 0) {
        const y = cy - R + sweep * 2 * R;
        const grad = ctx.createLinearGradient(0, y - 30, 0, y);
        grad.addColorStop(0, 'rgba(227,179,65,0)');
        grad.addColorStop(1, 'rgba(227,179,65,0.22)');
        ctx.save();
        ctx.beginPath();
        ctx.arc(cx, cy, R, 0, Math.PI * 2);
        ctx.clip();
        ctx.fillStyle = grad;
        ctx.fillRect(cx - R, y - 30, 2 * R, 30);
        ctx.fillStyle = 'rgba(227,179,65,0.85)';
        ctx.fillRect(cx - R, y, 2 * R, 1.2);
        ctx.restore();
      }
    }

    let last = 0;
    function tick(t) {
      const dt = Math.min(64, t - (last || t));
      last = t;
      // a few new quotes per frame
      for (let k = 0; k < 2; k++) {
        if (Math.random() < 0.55 && dies.length) {
          const d = dies[(Math.random() * dies.length) | 0];
          d.heat = 1;
          d.dir = Math.random() < 0.5 ? 1 : -1;
        }
      }
      dies.forEach((d) => {
        if (d.heat > 0) d.heat = Math.max(0, d.heat - dt / 1400);
      });
      if (sweep < 0 && Math.random() < dt / 6000) sweep = 0;
      if (sweep >= 0) {
        sweep += dt / 2600;
        if (sweep > 1) sweep = -1;
      }
      draw();
      raf = global.requestAnimationFrame(tick);
    }

    let wanted = false;
    function start() {
      wanted = true;
      layout();
      if (reduce) {
        dies.forEach((d) => {
          if (Math.random() < 0.12) {
            d.heat = 0.6;
            d.dir = Math.random() < 0.5 ? 1 : -1;
          }
        });
        draw();
        return;
      }
      if (!raf) raf = global.requestAnimationFrame(tick);
    }
    function halt() {
      if (raf) global.cancelAnimationFrame(raf);
      raf = null;
    }
    function stop() {
      wanted = false;
      halt();
    }
    global.addEventListener('resize', () => {
      if (!wanted) return;
      layout();
      if (reduce) draw();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) halt();
      else if (wanted) start();
    });
    return { start, stop };
  }
  global.WaferMap = WaferMap;
})(window);
