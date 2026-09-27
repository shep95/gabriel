// camera scanning. prefers the platform BarcodeDetector when it exists
// (hardware assisted, no js decoding), falls back to the vendored jsQR
// (apache-2.0) decoding frames drawn onto a canvas.
//
// usage: const s = startScanner(videoEl, onText); ... s.stop()

export function cameraAvailable() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
}

async function makeDetector() {
  if ('BarcodeDetector' in window) {
    try {
      const formats = await window.BarcodeDetector.getSupportedFormats();
      if (formats.includes('qr_code')) {
        const det = new window.BarcodeDetector({ formats: ['qr_code'] });
        return async (video) => {
          const codes = await det.detect(video);
          return codes.length ? codes[0].rawValue : null;
        };
      }
    } catch { /* fall through to jsQR */ }
  }
  if (typeof window.jsQR !== 'function') throw new Error('no qr decoder available');
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  return async (video) => {
    const w = video.videoWidth, h = video.videoHeight;
    if (!w || !h) return null;
    // downscale wide frames; jsQR is happiest around 640px and it saves battery
    const scale = Math.min(1, 720 / Math.max(w, h));
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const res = window.jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
    return res ? res.data : null;
  };
}

export function startScanner(video, onText, { interval = 120 } = {}) {
  let stream = null;
  let timer = null;
  let stopped = false;
  let busy = false;
  let lastText = null;
  let lastAt = 0;

  const stop = () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    if (stream) for (const t of stream.getTracks()) t.stop();
    stream = null;
    video.srcObject = null;
  };

  (async () => {
    try {
      const detect = await makeDetector();
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      if (stopped) { for (const t of stream.getTracks()) t.stop(); return; }
      video.srcObject = stream;
      video.setAttribute('playsinline', 'true');
      await video.play();
      const tick = async () => {
        if (stopped) return;
        if (!busy && video.readyState >= 2) {
          busy = true;
          try {
            const text = await detect(video);
            const now = performance.now();
            // the same frame keeps being visible for a while; report it once per
            // 1.5 s so multi-frame transfers can cycle without flooding the handler
            if (text && (text !== lastText || now - lastAt > 1500)) {
              lastText = text; lastAt = now;
              onText(text);
            }
          } catch (e) {
            // a single bad frame is not an error worth surfacing
          } finally {
            busy = false;
          }
        }
        timer = setTimeout(tick, interval);
      };
      tick();
    } catch (e) {
      stop();
      onText(null, e);
    }
  })();

  return { stop };
}
