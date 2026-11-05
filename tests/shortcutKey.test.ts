import { describe, expect, it } from 'vitest';
import { shortcutKey } from '../src/app/shortcutKey';

describe('shortcut keys', () => {
  it('reads the character typed on a Latin layout', () => {
    expect(shortcutKey({ key: 'T', code: 'KeyT' })).toBe('t');
    expect(shortcutKey({ key: ' ', code: 'Space' })).toBe(' ');
    expect(shortcutKey({ key: 'Enter', code: 'Enter' })).toBe('enter');
    expect(shortcutKey({ key: '?', code: 'Slash' })).toBe('?');
    // (AZERTY's M is where QWERTY has the semicolon: the letter typed wins.)
    expect(shortcutKey({ key: 'm', code: 'Semicolon' })).toBe('m');
  });

  it('reads the number row by place, as AZERTY types &é"\' there', () => {
    expect(shortcutKey({ key: '&', code: 'Digit1' })).toBe('1');
    expect(shortcutKey({ key: 'é', code: 'Digit2' })).toBe('2');
    expect(shortcutKey({ key: '3', code: 'Numpad3' })).toBe('3');
  });

  it('reads the letters by place on a layout without Latin ones', () => {
    expect(shortcutKey({ key: 'е', code: 'KeyT' })).toBe('t');
    expect(shortcutKey({ key: 'Я', code: 'KeyZ' })).toBe('z');
    expect(shortcutKey({ key: 'β', code: 'KeyB' })).toBe('b');
  });
});
