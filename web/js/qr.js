// qr rendering on top of the vendored qrcode-generator (mit) library.
// it is loaded as a classic script in the page and exposes window.qrcode.

function lib() {
  if (typeof window.qrcode !== 'function') throw new Error('qr encoder not loaded');
  return window.qrcode;
}

// picks the smallest version that fits; throws if the payload is too large
// for a single symbol (caller then chunks).
export function renderQr(canvas, text, { size = 280, ecl = 'M', quiet = 2 } = {}) {
  const qrcode = lib();
  let qr = null;
  for (let v = 1; v <= 40; v++) {
    try {
      const q = qrcode(v, ecl);
      q.addData(text, 'Byte');
      q.make();
      qr = q;
      break;
    } catch (e) {
      if (v === 40) throw new Error('payload too large for one qr code');
    }
  }
  const n = qr.getModuleCount();
  const modules = n + quiet * 2;
  const scale = Math.max(1, Math.floor(size / modules));
  const px = modules * scale;
  const ratio = window.devicePixelRatio || 1;
  canvas.width = px * ratio;
  canvas.height = px * ratio;
  canvas.style.width = `${px}px`;
  canvas.style.height = `${px}px`;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  // codes render light-on-dark to sit inside the page; scanners handle inverted
  // symbols poorly, so we keep them dark-on-light and frame them in the css.
  ctx.fillStyle = '#f4f6f8';
  ctx.fillRect(0, 0, px, px);
  ctx.fillStyle = '#0b0d10';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.isDark(r, c)) ctx.fillRect((c + quiet) * scale, (r + quiet) * scale, scale, scale);
    }
  }
  return { version: qr.typeNumber, modules: n };
}
