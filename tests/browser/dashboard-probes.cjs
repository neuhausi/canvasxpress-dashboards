/**
 * Page probes shared by the browser gates that drive a rendered cohort dashboard (R and Python wrappers).
 * Every probe takes a Playwright Page or Frame (anything with `evaluate`), so it works for a dashboard
 * inside an iframe too.
 */

// cohort row k (0-based) is patient P(k+1); its values are a pure function of k in every gate.
function expectedPatient(id) {
  const k = Number(id.slice(1)) - 1;
  return { os_months: 3 + (k * 7) % 40, os_event: k % 3 === 0 ? 0 : 1, age: 40 + (k * 5) % 35, arm: k % 2 ? 'Drug' : 'Placebo' };
}

/** The case card's one displayed row (what the table shows, not its data object). */
async function readCard(page) {
  const text = await page.evaluate(function () {
    const root = document.querySelector('[id$=-cX-DataTable]');
    return root ? root.innerText.replace(/\s+/g, ' ') : '';
  });
  const m = /CD274\s+1\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)/.exec(text);
  return m ? { id: m[1], arm: m[2], stage: m[3], os_months: Number(m[4]), os_event: Number(m[5]), age: Number(m[6]) } : { id: null, text: text };
}

/** Client coordinates of a coloured dot on the scatter panel titled `age vs os_months`. */
function findDot(page, fromEnd) {
  return page.evaluate(function (fromEnd) {
    const heading = Array.prototype.find.call(document.querySelectorAll('*'), function (el) {
      return el.children.length === 0 && el.textContent.trim() === 'age vs os_months';
    });
    let box = heading;
    while (box && !box.querySelector('canvas')) box = box.parentElement;
    if (!box) return null;
    box.scrollIntoView({ block: 'center' });
    const canvases = Array.prototype.slice.call(box.querySelectorAll('canvas')).filter(function (c) { return c.width > 200; });
    for (let ci = 0; ci < canvases.length; ci++) {
      const c = canvases[ci];
      const r = c.getBoundingClientRect(), sx = c.width / r.width, sy = c.height / r.height;
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      const sat = function (x, y) { const k = (y * c.width + x) * 4; return d[k + 3] > 200 && Math.max(d[k], d[k + 1], d[k + 2]) - Math.min(d[k], d[k + 1], d[k + 2]) >= 60; };
      const limitX = Math.floor(c.width * 0.8);
      let hit = null;
      for (let k = 0; k < c.width * c.height && !hit; k++) {
        const n = fromEnd ? c.width * c.height - 1 - k : k;
        const x = n % c.width, y = Math.floor(n / c.width);
        if (x < limitX && y > 30 && y < c.height - 60 && sat(x, y)) hit = { x: x, y: y };
      }
      if (!hit) continue;
      let sxs = 0, sys = 0, cnt = 0;
      for (let yy = hit.y - 8; yy <= hit.y + 8; yy++) for (let xx = hit.x - 8; xx <= hit.x + 8; xx++) {
        if (xx >= 0 && yy >= 0 && xx < c.width && yy < c.height && sat(xx, yy)) { sxs += xx; sys += yy; cnt++; }
      }
      return { x: r.left + (sxs / cnt) / sx, y: r.top + (sys / cnt) / sy };
    }
    return null;
  }, fromEnd);
}

/** Non-white pixels per canvas (a chart canvas paints an opaque white background). */
const INK = function () {
  return Array.prototype.map.call(document.querySelectorAll('canvas'), function (c) {
    const g = c.getContext('2d'); if (!g || !c.width || !c.height) return 0;
    const d = g.getImageData(0, 0, c.width, c.height).data; let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 0 && (d[i] < 245 || d[i + 1] < 245 || d[i + 2] < 245)) n++;
    return n;
  }).filter(function (n) { return n > 0; });
};


module.exports = { expectedPatient, readCard, findDot, INK };
