// One engraved silhouette for each event, shared by the canvas-painted cubes and the HUD. The
// tracks use the same blue, ochre and violet inks as the venture cards in the guild panels.
import type { EventFace } from '../../engine/modules/guilds/types';

export interface EventDieResult { face: EventFace; red: number; independentRed: boolean }

export const EVENT_INK: Record<EventFace, string> = {
  ship: '#29485c', learning: '#3f6f8a', commerce: '#a8743a', statecraft: '#7b4a86',
};
export const EVENT_NAME: Record<EventFace, string> = {
  ship: 'Ship', learning: 'Learning', commerce: 'Commerce', statecraft: 'Statecraft',
};
// The three ship faces occupy values 1–3; the other values name the three tracks. These are atlas
// addresses, not engine dice: the engine has already selected the face before the throw begins.
export const EVENT_VALUE: Record<EventFace, number> = { ship: 1, learning: 4, commerce: 5, statecraft: 6 };
export const VALUE_EVENT: EventFace[] = ['ship', 'ship', 'ship', 'learning', 'commerce', 'statecraft'];

/** Filled paths in a 24-unit square, with open cuts broad enough to read on a distant die. */
export const EVENT_PATH: Record<EventFace, string> = {
  ship: 'M4 16H21L18 20H8Z M11 3H13V15H11Z M9.5 5V14H3Z M14.5 6L21 14H14.5Z M4 21Q7 19.5 10 21Q13 22.5 16 21Q19 19.5 22 21V22.5Q19 21 16 22.5Q13 24 10 22.5Q7 21 4 22.5Z',
  learning: 'M2 5Q7 2 11 5V20Q7 17 2 20Z M13 5Q17 2 22 5V20Q17 17 13 20Z M4 7V8L9 7.5V6.5Z M15 6.5V7.5L20 8V7Z',
  commerce: 'M7 3H17L15 7H9Z M8 8H16Q22 13 20 19Q18 23 12 23Q6 23 4 19Q2 13 8 8Z M11 11V13H9V17H13V18H9V20H11V21H13V20H15V16H11V15H15V13H13V11Z',
  statecraft: 'M3 7L8 11L12 4L16 11L21 7L19 18H5Z M5 20H19V23H5Z M2 3H5V6H2Z M10.5 0H13.5V3H10.5Z M19 3H22V6H19Z',
};

export function paintEvent(ctx: CanvasRenderingContext2D, face: EventFace, x: number, y: number, size: number, ink = EVENT_INK[face]) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(size / 24, size / 24);
  ctx.fillStyle = ink;
  ctx.fill(new Path2D(EVENT_PATH[face]), 'evenodd');
  ctx.restore();
}

/** The production pair stays intact; a card roll adds its own red die beside the event die. */
export function throwFaces(dice: [number, number], event?: EventDieResult): number[] {
  return event ? [...dice, EVENT_VALUE[event.face], ...(event.independentRed ? [event.red] : [])] : [...dice];
}
