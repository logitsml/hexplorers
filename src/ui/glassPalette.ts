// Sea Glass's colours: five OKLCH ramps, one hue each, a shade per role (1 lightest, 12 darkest). The
// skin reads them through role tokens (styles/glass.css); glassLight.ts blends the two appearances with the sky.

export const RAMPS = {
  frost: ['#fafafa', '#f3f3f3', '#e8eaea', '#dee0e1', '#d1d5d6', '#bfc5c7', '#a6acae', '#878d8f', '#686d6e', '#575c5d', '#4a4e4f', '#252727'],
  sea: ['#f9fafa', '#eff5f5', '#ddedef', '#c7e7ea', '#a8e0e6', '#8dd2da', '#70b9c1', '#5299a1', '#38777e', '#30646a', '#2e5459', '#1c292b'],
  amber: ['#fafaf9', '#f5f3f0', '#efe8e1', '#eaddcf', '#e6d0b7', '#e1bd92', '#cda26c', '#ad844f', '#886436', '#72542e', '#5f482c', '#2d251b'],
  kelp: ['#f9fafa', '#f0f5f2', '#deeee4', '#c8e9d4', '#ace3c2', '#97d5b0', '#7bbc96', '#5e9c79', '#43795b', '#39664d', '#345642', '#1e2a22'],
  coral: ['#fafafa', '#f5f3f3', '#ede8e7', '#e7dddb', '#e1cfcd', '#dabcb8', '#d19c95', '#c86f66', '#a15048', '#88443d', '#703c37', '#34211e'],
} as const;

/**
 * The panel's opacity by the sky's night value (0 day, 1 night), for each appearance: the lowest at which
 * secondary text holds 4.5:1 over the darkest raw board colours, the board flattened and lifted behind the
 * glass as the backdrop filter does (worked out offline against the board's own colours).
 */
export const LIGHT_ALPHA: readonly (readonly [number, number])[] = [[0.00, 0.29], [0.05, 0.31], [0.10, 0.35], [0.15, 0.38], [0.20, 0.40], [0.25, 0.43], [0.30, 0.45], [0.35, 0.48], [0.40, 0.51], [0.45, 0.52], [0.50, 0.54], [0.55, 0.56], [0.60, 0.58], [0.65, 0.59], [0.70, 0.60], [0.75, 0.61], [0.80, 0.62], [0.85, 0.63], [0.90, 0.64], [0.95, 0.65], [1.00, 0.66]];
export const DARK_ALPHA: readonly (readonly [number, number])[] = [[0.00, 0.98], [0.05, 0.98], [0.10, 0.98], [0.15, 0.97], [0.20, 0.97], [0.25, 0.97], [0.30, 0.96], [0.35, 0.83], [0.40, 0.70], [0.45, 0.58], [0.50, 0.41], [0.55, 0.29], [0.60, 0.14], [0.65, 0.12], [0.70, 0.12], [0.75, 0.12], [0.80, 0.12], [0.85, 0.12], [0.90, 0.12], [0.95, 0.12], [1.00, 0.12]];
