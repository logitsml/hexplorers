// One rule for every light in the world (windows and door lanterns, the cart lantern, the mine
// lantern, the kiln fire, the lighthouse): at night they all reach the same brightness, enough
// to bloom; by day each keeps only its own faint floor. Colours are given at unit luminance,
// so the level alone sets how bright a light is.

import * as THREE from 'three/webgpu';
import type { Node } from 'three/webgpu';

/** Night luminance of every light (twice the bloom threshold, before exposure). */
const NIGHT = 3.2;
/** Default daytime floor: a lamp in daylight barely glows. */
const DAY = 0.1;

/** Luminance of a light at this night level (0 = day, 1 = night). */
export const lampLevel = (night: number, day = DAY) => day + (NIGHT - day) * night;
export const lampLevelNode = (night: Node<'float'>, day = DAY) => night.mul(NIGHT - day).add(day);

/** Warm window and lantern light. */
export const WINDOW_LIGHT: readonly [number, number, number] = [1.0, 0.62, 0.25];

/** A light's colour (linear rgb) scaled to unit luminance. */
export function lampColor(r: number, g: number, b: number) {
  const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return new THREE.Color(r / l, g / l, b / l);
}
