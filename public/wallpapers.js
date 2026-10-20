/* Wallpapers drawn as SVG so they work offline. Swap for photos any time via Settings > Appearance > custom. */
(() => {
  const rng = (s) => () => (s = (s * 16807) % 2147483647) / 2147483647;
  const wrap = (inner) =>
    "data:image/svg+xml;utf8," +
    encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 900" preserveAspectRatio="xMidYMid slice">${inner}</svg>`);
  const lin = (id, stops) =>
    `<linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">${stops.map(([o, c, a = 1]) => `<stop offset="${o}" stop-color="${c}" stop-opacity="${a}"/>`).join("")}</linearGradient>`;

  function forest() {
    const r = rng(7);
    const layers = [
      { y: 560, h: 260, n: 34, c: "#0f241a", o: 0.6 },
      { y: 650, h: 300, n: 30, c: "#0b1b14", o: 0.78 },
      { y: 740, h: 360, n: 24, c: "#07110d", o: 0.92 },
      { y: 850, h: 430, n: 18, c: "#030806", o: 1 },
    ];
    let g = "";
    for (const L of layers) {
      for (let i = 0; i < L.n; i++) {
        const x = (i / L.n) * 1700 - 50 + r() * 40;
        const h = L.h * (0.7 + r() * 0.6), w = h * 0.34, base = L.y + r() * 30;
        let p = "";
        for (let k = 0; k < 3; k++) {
          const t = base - h * k * 0.28, ww = w * (1 - k * 0.25);
          p += `M${x.toFixed(0)},${t.toFixed(0)} m${(-ww / 2).toFixed(0)},0 l${(ww / 2).toFixed(0)},${(-h * 0.42).toFixed(0)} l${(ww / 2).toFixed(0)},${(h * 0.42).toFixed(0)} Z `;
        }
        g += `<path d="${p}" fill="${L.c}" opacity="${L.o}"/>`;
      }
      g += `<rect x="0" y="${L.y - 130}" width="1600" height="220" fill="url(#f)" opacity=".4"/>`;
    }
    return wrap(
      `<defs>${lin("b", [[0, "#0a1913"], [1, "#1c3d2d"]])}${lin("f", [[0, "#a9c4b5", 0], [0.5, "#a9c4b5", 0.5], [1, "#a9c4b5", 0]])}` +
        `<radialGradient id="m" cx=".72" cy=".18" r=".45"><stop offset="0" stop-color="#d4ebdd" stop-opacity=".4"/><stop offset="1" stop-color="#d4ebdd" stop-opacity="0"/></radialGradient></defs>` +
        `<rect width="1600" height="900" fill="url(#b)"/><rect width="1600" height="900" fill="url(#m)"/>${g}`
    );
  }

  function ocean() {
    let w = "";
    for (let j = 0; j < 7; j++) {
      const y0 = 430 + j * 72, amp = 6 + j * 4, f = 90 + j * 28;
      let d = `M0,900 L0,${y0}`;
      for (let x = 0; x <= 1600; x += 20) d += ` L${x},${(y0 + amp * Math.sin(x / f + j * 1.7)).toFixed(1)}`;
      w += `<path d="${d} L1600,900 Z" fill="url(#w${j % 2})" opacity="${(0.28 + j * 0.09).toFixed(2)}"/>`;
    }
    return wrap(
      `<defs>${lin("s", [[0, "#07233d"], [0.55, "#1f6a8f"], [1, "#8fd0e0"]])}${lin("w0", [[0, "#5fb7cf"], [1, "#0d4766"]])}${lin("w1", [[0, "#3f98b8"], [1, "#082f49"]])}` +
        `<radialGradient id="g" cx=".5" cy=".48" r=".5"><stop offset="0" stop-color="#ffe9b0" stop-opacity=".75"/><stop offset="1" stop-color="#ffe9b0" stop-opacity="0"/></radialGradient></defs>` +
        `<rect width="1600" height="900" fill="url(#s)"/><circle cx="800" cy="430" r="320" fill="url(#g)"/>${w}`
    );
  }

  function sky() {
    const r = rng(5);
    let c = "";
    for (let i = 0; i < 16; i++) {
      const cx = r() * 1600, cy = 80 + r() * 520, s = 0.6 + r() * 1.1;
      for (let k = 0; k < 4; k++)
        c += `<ellipse cx="${(cx + k * 70 * s - 100 * s).toFixed(0)}" cy="${(cy + (k % 2 ? -14 : 10) * s).toFixed(0)}" rx="${(90 * s).toFixed(0)}" ry="${(34 * s).toFixed(0)}" fill="#fff" opacity="${(0.5 + r() * 0.35).toFixed(2)}"/>`;
    }
    return wrap(
      `<defs>${lin("s", [[0, "#4f9be8"], [0.6, "#9ccdf5"], [1, "#e4f2ff"]])}<filter id="b" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="16"/></filter></defs>` +
        `<rect width="1600" height="900" fill="url(#s)"/><g filter="url(#b)">${c}</g>`
    );
  }

  window.NVWalls = { forest, ocean, sky };
})();
