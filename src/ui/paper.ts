// The parchment's paper texture, drawn once. The grain is three SVG noise filters (feTurbulence),
// which the browser would re-rasterise for every panel as it paints, were each to carry them as
// its background; here the three are drawn into one small tile at start-up and every panel shares
// that bitmap (as --paper, see .parchment::after in ui.css). Until it is ready, or if the browser
// can't read the canvas back, panels show the SVGs themselves.

const SIZE = 320;

/** Long fibres, mottled foxing and fine grain, top to bottom (as the CSS layers are). */
const LAYERS = [
  "<filter id='f'><feTurbulence type='fractalNoise' baseFrequency='0.012 0.5' numOctaves='2' seed='4' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 0.42 0 0 0 0 0.3 0 0 0 0 0.16 0 0 0 0.35 -0.08'/></filter><rect width='100%' height='100%' filter='url(#f)'/>",
  "<filter id='m'><feTurbulence type='fractalNoise' baseFrequency='0.018' numOctaves='4' seed='9' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 0.55 0 0 0 0 0.38 0 0 0 0 0.18 0 0 0 0.9 -0.42'/></filter><rect width='100%' height='100%' filter='url(#m)'/>",
  "<filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='3' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 0.45 0 0 0 0 0.33 0 0 0 0 0.18 0 0 0 0.55 0'/></filter><rect width='100%' height='100%' filter='url(#n)'/>",
];

const svg = (body: string) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' width='${SIZE}' height='${SIZE}'>${body}</svg>`)}`;

function load(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

let started = false;

export function preparePaper() {
  if (started || typeof document === 'undefined') return;
  started = true;
  void (async () => {
    try {
      const imgs = await Promise.all(LAYERS.map((l) => load(svg(l))));
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = SIZE;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      // The bottom layer first, so the fibres end up on top as they were listed.
      for (const img of imgs.reverse()) ctx.drawImage(img, 0, 0, SIZE, SIZE);
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'));
      if (!blob) return;
      document.documentElement.style.setProperty('--paper', `url(${URL.createObjectURL(blob)})`);
      // The same tile at the overlay's strength (.parchment::after is drawn at 0.32), for a panel that
      // scrolls itself and so can't carry the overlay: it takes the paper as a background instead.
      const soft = document.createElement('canvas');
      soft.width = soft.height = SIZE;
      const sctx = soft.getContext('2d');
      if (!sctx) return;
      sctx.globalAlpha = 0.32;
      sctx.drawImage(canvas, 0, 0);
      const softBlob = await new Promise<Blob | null>((r) => soft.toBlob(r, 'image/png'));
      if (softBlob) document.documentElement.style.setProperty('--paper-soft', `url(${URL.createObjectURL(softBlob)})`);
    } catch {
      /* the canvas could not be read back (or an image failed): the SVG layers stay */
    }
  })();
}
