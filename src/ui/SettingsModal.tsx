// Settings, in four tabs. Loaded on demand (see Modals.tsx).

import { useState, type ReactNode } from 'react';
import { DEFAULT_SETTINGS, useUI, type Settings } from '../game/store';
import { RESOURCES, type Resource } from '../engine/types';
import { CARD_NAMES } from '../game/names';
import { session } from '../app/session';
import { LineIcon, type LineIconName } from './LineIcons';
import { Morph } from './Morph';
import { Modal, TabPanel, Tabs, closeBack } from './ModalFrame';
import { applyVolume, setMuted } from '../audio/mute';
import { applyDisplaySettings, effectiveScale, reducedMotion } from '../app/display';
import { deviceQuality, rememberedQuality } from '../app/deviceQuality';
import type { Quality } from '../render/core/stage';

type SettingsTab = 'look' | 'play' | 'sound' | 'access';

/** The settings tab last open (kept while the page is). */
let lastSettingsTab: SettingsTab = 'look';

const SKY_FIXED: [Settings['timeOfDay'], string, LineIconName][] = [
  ['morning', 'Morning', 'sunrise'],
  ['noon', 'Noon', 'noon'],
  ['golden', 'Golden hour', 'sunset'],
  ['dusk', 'Dusk', 'dusk'],
  ['night', 'Night', 'moon'],
];

const WEATHER_OPTIONS: [Settings['weather'], string, LineIconName][] = [
  ['clear', 'Clear', 'sun'],
  ['changing', 'Changing', 'changing'],
  ['cloudy', 'Cloudy', 'cloud'],
  ['rain', 'Rain', 'rain'],
  ['storm', 'Storm', 'storm'],
];

/** Depth of field: three steps rather than a slider (older saves sit on the nearest). */
const BLUR_STEPS: [number, string][] = [
  [0, 'Off'],
  [0.5, 'Soft'],
  [1, 'Strong'],
];

const WEATHER_NOTE: Record<Settings['weather'], string> = {
  changing: 'Mostly clear, with a passing shower and sometimes a rainbow.',
  clear: 'Fair weather all game.',
  cloudy: 'A soft grey sky that never rains.',
  rain: 'Steady rain, with puddles and a rough sea.',
  storm: 'Heavy rain, strong wind and lightning.',
};

const QUALITY_NAME: Record<Quality, string> = { low: 'Low', medium: 'Medium', high: 'High', ultra: 'Ultra' };

const QUALITY_NOTE: Record<Quality, string> = {
  low: 'Fastest: lighter foliage and shadows, no ambient occlusion.',
  medium: 'Balanced. Ambient occlusion and SMAA anti-aliasing.',
  high: 'Lamps, sea reflections and depth of field. Slower first load.',
  ultra: 'Everything on, at a higher resolution.',
};

export function SettingsModal() {
  const settings = useUI((s) => s.settings);
  const active = useUI((s) => s.quality);
  const inGame = useUI((s) => s.screen === 'game');
  const muted = useUI((s) => s.muted);
  const set = useUI((s) => s.set);
  const [tab, setTab] = useState<SettingsTab>(lastSettingsTab);
  const [resetting, setResetting] = useState(false);
  const showTab = (t: SettingsTab) => {
    lastSettingsTab = t;
    setTab(t);
  };
  // Only what actually changes is applied: choosing the quality already drawn (or Reset when
  // nothing differs) would otherwise pause play and rebuild every shader for nothing.
  const upd = (p: Partial<Settings>) => {
    const next = { ...settings, ...p };
    const changed = (k: keyof Settings) => p[k] !== undefined && p[k] !== settings[k];
    set({ settings: next });
    if (changed('quality')) {
      if (p.quality === 'auto')
        void (async () => {
          const q = rememberedQuality() ?? (await deviceQuality());
          if (q !== useUI.getState().quality) void session.applyQuality(q, settings.quality);
        })();
      else if (p.quality && p.quality !== active) void session.applyQuality(p.quality, settings.quality);
    }
    if (changed('sound') || changed('music')) setTimeout(applyVolume, 0);
    // (A change made here comes on in a few seconds, not at the game's own slow pace.)
    if (changed('timeOfDay')) session.world?.setTimeMode(next.timeOfDay, true);
    if (changed('blur')) session.world?.stage.setBlur(next.blur);
    if (changed('weather') && session.world) session.world.weather.setMode(next.weather, session.world.time.night.value, true);
    if (changed('uiScale') || changed('reduceMotion')) applyDisplaySettings(next);
    // (Reduced motion keeps the camera's motion blur off whatever its own switch says.)
    if (changed('motionBlur') || changed('reduceMotion')) session.world?.stage.setMotionBlur(next.motionBlur && !reducedMotion());
  };
  // A labelled choice: its icon and name, the options, and a note under them.
  const field = (icon: LineIconName, label: string, control: ReactNode, note?: ReactNode) => (
    <div className="field" role="group" aria-label={label}>
      <span className="field-label">
        <span className="field-name">
          <LineIcon name={icon} size={18} />
          {label}
        </span>
      </span>
      {control}
      {note && <p className="setting-note">{note}</p>}
    </div>
  );
  const seg = <T extends string | number>(opts: [T, string][], v: T, on: (x: T) => void, disabled = false) => (
    <div className={`seg${disabled ? ' disabled' : ''}`}>
      {opts.map(([k, l]) => (
        <button key={String(k)} type="button" className={v === k ? 'on' : ''} aria-pressed={v === k} disabled={disabled} onClick={() => on(k)}>
          {l}
        </button>
      ))}
    </div>
  );
  // Choices shown as pictures: an icon over each name.
  const tiles = <T extends string>(opts: [T, string, LineIconName][], v: T | null, on: (x: T) => void) => (
    <div className="tiles" style={{ ['--n' as string]: opts.length }}>
      {opts.map(([k, l, icon]) => (
        <button key={k} type="button" className={`tile${v === k ? ' on' : ''}`} aria-pressed={v === k} onClick={() => on(k)}>
          <LineIcon name={icon} size={24} />
          <span>{l}</span>
        </button>
      ))}
    </div>
  );
  const slider = (icon: LineIconName, label: string, value: number, on: (v: number) => void, disabled = false) => (
    <label className="slider-row">
      <LineIcon name={icon} size={20} />
      <span className="slider-label">{label}</span>
      {/* (--v: how far along, for the track's fill where the slider is drawn by ui.css, on a touch screen.) */}
      <input type="range" aria-label={`${label} volume`} min={0} max={1} step={0.05} value={value} disabled={disabled} style={{ ['--v' as string]: value }} onChange={(e) => on(Number(e.target.value))} />
      <span className="field-value">
        <Morph>{disabled ? 'Off' : `${Math.round(value * 100)}%`}</Morph>
      </span>
    </label>
  );
  const toggle = (icon: LineIconName, label: string, hint: string, checked: boolean, on: (v: boolean) => void, disabled = false) => (
    <label className={`toggle-row${disabled ? ' disabled' : ''}`}>
      <LineIcon name={icon} size={20} />
      <span className="toggle-text">
        <span className="toggle-label">{label}</span>
        <span className="toggle-hint">{hint}</span>
      </span>
      <input type="checkbox" role="switch" className="switch" checked={checked} disabled={disabled} onChange={(e) => on(e.target.checked)} />
    </label>
  );
  // The sun: moving (by day only, or through day and night), or held at a set time.
  const fixedSky = SKY_FIXED.some(([k]) => k === settings.timeOfDay);
  const skyMode = fixedSky ? 'fixed' : settings.timeOfDay;
  const effectsOn = active === 'high' || active === 'ultra';
  // (Below High neither effect is drawn, and reduced motion keeps the motion blur off: the controls
  // then show what is drawn, off, and say why, while the choice for High and Ultra is kept.)
  const blurStep = effectsOn ? BLUR_STEPS.reduce((a, b) => (Math.abs(b[0] - settings.blur) < Math.abs(a[0] - settings.blur) ? b : a))[0] : 0;
  const stillCamera = reducedMotion();
  const blurNote = !effectsOn ? 'High and Ultra quality only' : stillCamera ? 'Off while motion is reduced' : 'Fast camera sweeps streak slightly';
  return (
    <Modal onClose={closeBack} width={560}>
      <h3>Settings</h3>
      <Tabs<SettingsTab>
        label="Settings"
        idBase="settings"
        value={tab}
        onChange={showTab}
        items={[
          { id: 'look', label: 'Look', icon: 'look' },
          { id: 'play', label: 'Play', icon: 'play' },
          { id: 'sound', label: 'Sound', icon: 'sound' },
          { id: 'access', label: 'Access', icon: 'access' },
        ]}
      />
      <TabPanel page={tab} idBase="settings" tab={tab} className="settings">
        {tab === 'look' && (
          <>
            {field(
              'look',
              'Quality',
              seg<Settings['quality']>([['auto', 'Auto'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['ultra', 'Ultra']], settings.quality, (quality) => upd({ quality })),
              <>
                {settings.quality === 'auto' && `${QUALITY_NAME[active]}, chosen for this device. `}
                {QUALITY_NOTE[active]}
                {/* (Said with the rest of the note, in the same ink: a second, coloured paragraph made the
                    first tab read as a warning before anything was changed.) */}
                {inGame && ' A change pauses play for a few seconds while the island is prepared.'}
              </>,
            )}
            {field(
              'look',
              'Interface',
              tiles<Settings['look']>(
                [
                  ['glass', 'Sea Glass', 'image'],
                  ['parchment', 'Parchment', 'book'],
                ],
                settings.look,
                (look) => upd({ look }),
              ),
              settings.look === 'glass' ? 'Clear glass over the island that follows the sky: light by day, dark at night.' : 'Paper panels and wooden buttons, as the first releases looked.',
            )}
            {field(
              'sun',
              'Sky',
              <>
                {tiles<'daytime' | 'dynamic' | 'fixed'>(
                  [
                    ['daytime', 'Day only', 'sun'],
                    ['dynamic', 'Day and night', 'dayNight'],
                    ['fixed', 'Set time', 'clock'],
                  ],
                  skyMode as 'daytime' | 'dynamic' | 'fixed',
                  (m) => upd({ timeOfDay: m === 'fixed' ? (fixedSky ? settings.timeOfDay : 'golden') : m }),
                )}
                {fixedSky && <div className="tiles-sub">{tiles(SKY_FIXED, settings.timeOfDay, (timeOfDay) => upd({ timeOfDay }))}</div>}
              </>,
              settings.timeOfDay === 'dynamic' ? 'The sun moves with the turns: a full day and night about every ten rounds.' : settings.timeOfDay === 'daytime' ? 'The sun moves with the turns but never sets.' : 'The light stays as it is all game.',
            )}
            {field('changing', 'Weather', tiles(WEATHER_OPTIONS, settings.weather, (weather) => upd({ weather })), WEATHER_NOTE[settings.weather])}
            {/* (Below High, why both are off is said once, for the pair, rather than under each.) */}
            <div className={`subgroup${effectsOn ? '' : ' disabled'}`} role="group" aria-label="Camera effects" aria-describedby={effectsOn ? undefined : 'settings-effects-note'}>
              {!effectsOn && (
                <p className="subgroup-note" id="settings-effects-note">
                  <LineIcon name="lock" size={16} />
                  High and Ultra quality only
                </p>
              )}
              {field('focus', 'Depth of field', seg<number>(BLUR_STEPS, blurStep, (blur) => upd({ blur }), !effectsOn), effectsOn ? 'Softens what is far from the middle of the view.' : undefined)}
              {toggle('motion', 'Motion blur', effectsOn ? blurNote : 'Streaks the view on fast camera sweeps', settings.motionBlur && effectsOn && !stillCamera, (motionBlur) => upd({ motionBlur }), !effectsOn || stillCamera)}
            </div>
          </>
        )}
        {tab === 'play' && (
          <>
            {field('speed', 'Animation speed', seg<number>([[0.6, 'Relaxed'], [1, 'Normal'], [1.6, 'Brisk'], [2.5, 'Fast']], settings.animationSpeed, (animationSpeed) => upd({ animationSpeed })))}
            {field(
              'crew',
              'Other players',
              seg<Settings['botPace']>([['quick', 'Quick'], ['normal', 'Normal'], ['relaxed', 'Unhurried']], settings.botPace, (botPace) => upd({ botPace })),
              'How long the others take over each move.',
            )}
            {field(
              'clock',
              'Time to answer an offer',
              seg<Settings['offerTimer']>([[30, '30 seconds'], [60, '60 seconds'], [0, 'No limit']], settings.offerTimer, (offerTimer) => upd({ offerTimer })),
              settings.offerTimer ? 'Unanswered offers are declined after this long (paused while a dialog is open).' : 'Offers wait for your answer, however long you take.',
            )}
            {field('book', 'Announcements', seg<Settings['bannerTime']>([['short', 'Brief'], ['normal', 'Normal'], ['long', 'Longer']], settings.bannerTime, (bannerTime) => upd({ bannerTime })), 'How long the ribbons across the top stay up.')}
            <div className="toggle-list">
              {toggle('odds', 'Show odds', 'What tiles and building spots yield, as you point or press', settings.showProbabilities, (showProbabilities) => upd({ showProbabilities }))}
              {toggle('turn', 'Confirm ending a turn', 'End turn asks for a second press', settings.confirmEndTurn, (confirmEndTurn) => upd({ confirmEndTurn }))}
              {toggle('hand', 'Pass wagon auctions that can’t reach you', 'With Wagon Trains: when nowhere the wagon could go touches your pieces, you pass without being asked', settings.autoPassWagon, (autoPassWagon) => upd({ autoPassWagon }))}
            </div>
            {field(
              'star',
              'Bounty and Learning picks',
              seg<'ask' | Resource>([['ask', 'Ask'], ...RESOURCES.map((r): [Resource, string] => [r, CARD_NAMES[r]])], settings.pickResource ?? 'ask', (x) => upd({ pickResource: x === 'ask' ? null : x })),
              settings.pickResource ? `With Sea Lanes or the guilds: ${CARD_NAMES[settings.pickResource].toLowerCase()} is taken without asking whenever the supply has enough.` : 'With Sea Lanes or the guilds: you choose each time.',
            )}
          </>
        )}
        {tab === 'sound' && (
          <>
            {/* (Named by what it says, which says what pressing does: a fixed name, "Mute all
                sound", would be read out while the button says "Turn it on".) */}
            <button type="button" className={`mute-btn${muted ? ' on' : ''}`} aria-keyshortcuts="M" onClick={() => setMuted(!muted)}>
              <LineIcon name={muted ? 'muted' : 'sound'} size={22} />
              <Morph>{muted ? 'Sound is off. Turn it on' : 'Mute all sound'}</Morph>
              <kbd aria-hidden>M</kbd>
            </button>
            <div className="slider-list">
              {slider('sound', 'Effects', settings.sound, (sound) => upd({ sound }), muted)}
              {slider('music', 'Music and ambience', settings.music, (music) => upd({ music }), muted)}
            </div>
          </>
        )}
        {tab === 'access' && (
          <>
            {field(
              'textSize',
              'Interface size',
              <div className="seg size-seg">
                {(
                  [
                    [0.9, 'Compact'],
                    [1, 'Standard'],
                    [1.12, 'Large'],
                    [1.25, 'Largest'],
                  ] as [number, string][]
                ).map(([k, l], i) => (
                  <button key={k} type="button" className={settings.uiScale === k ? 'on' : ''} aria-pressed={settings.uiScale === k} onClick={() => upd({ uiScale: k })}>
                    <span className="size-glyph" style={{ fontSize: 13 + i * 3 }} aria-hidden>
                      A
                    </span>
                    {l}
                  </button>
                ))}
              </div>,
              effectiveScale(settings.uiScale) < settings.uiScale ? 'This window is too small for that size; it applies as far as the window allows.' : undefined,
            )}
            {field('motion', 'Reduce motion', seg<Settings['reduceMotion']>([['system', 'As my device'], ['on', 'On'], ['off', 'Off']], settings.reduceMotion, (reduceMotion) => upd({ reduceMotion })))}
            {field(
              'bright',
              'High contrast',
              seg<Settings['highContrast']>([['system', 'As my device'], ['on', 'On'], ['off', 'Off']], settings.highContrast, (highContrast) => upd({ highContrast })),
              'Solid panels, darker text and stronger outlines.',
            )}
            {field(
              'crew',
              'Player colours',
              seg<Settings['palette']>([['standard', 'Standard'], ['colorblind', 'Colour-blind safe']], settings.palette, (palette) => upd({ palette })),
              'Told apart with any colour vision, from your next game. Each player also has a mark of their own.',
            )}
            <div className="toggle-list">{toggle('bright', 'Bright pieces', 'Pieces stay fully lit at night and in shade', settings.brightPieces, (brightPieces) => upd({ brightPieces }))}</div>
          </>
        )}
      </TabPanel>
      <div className="footer">
        {/* (Every tab's settings, and perhaps a rebuild of the graphics: so it asks once more. Quiet
            until then, apart from Done; its label morphs into the question.) */}
        <button
          type="button"
          className={`btn ghost${resetting ? ' warn' : ' bare'}`}
          onClick={() => {
            if (!resetting) {
              setResetting(true);
              return;
            }
            setResetting(false);
            upd({ ...DEFAULT_SETTINGS });
          }}
          onBlur={() => setResetting(false)}
        >
          <LineIcon name="refresh" size={18} />
          <Morph>{resetting ? 'Reset every setting?' : 'Reset to defaults'}</Morph>
        </button>
        <span className="footer-gap" aria-hidden />
        <button type="button" className="btn gold" onClick={closeBack}>
          Done
        </button>
      </div>
    </Modal>
  );
}
