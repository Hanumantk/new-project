import { useState, type ReactNode } from 'react';
import { GlassCluster, GlassGrid, GlassLabel, GlassSlider, GlassToggle, at, type GlassMaterial } from './Glass';

/**
 * The control-tile kit, laid out like the Figma "Component Library" frame:
 * every component in both materials and states, all interactive. Open with
 * `?kit`.
 */
export function GlassKit() {
  const materials: GlassMaterial[] = ['regular', 'clear'];
  const [toggles, setToggles] = useState([false, true, false, true]);
  const [labels, setLabels] = useState([false, true, false, true]);
  const [squares, setSquares] = useState([false, true, false, true]);
  const [sliders, setSliders] = useState([0.25, 0.5, 0.75, 1, 0.25, 0.5, 0.75, 1]);
  const [chips, setChips] = useState([false, true, true, false]);
  const flip = (list: boolean[], set: (v: boolean[]) => void, i: number) => set(list.map((v, k) => (k === i ? !v : v)));

  return (
    <main className="cc-page">
      <header className="cc-page-head">
        <h1>Liquid Glass controls</h1>
        <p>After the iOS 26 Control Center kit. Regular material over wallpapers; Clear over photos and video.</p>
        <a className="cc-page-link" href="?">
          Back to the app
        </a>
      </header>
      <div className="cc-kit">
        <div className="cc-kit-col">
          <Section title="Toggle · 1×1" note="material × state">
            {toggles.map((on, i) => (
              <GlassToggle
                key={i}
                icon="camera"
                label={`Camera, ${materials[i >> 1]}`}
                material={materials[i >> 1]}
                on={on}
                onClick={() => flip(toggles, setToggles, i)}
              />
            ))}
          </Section>
          <Section title="Label · 2×1" note="Focus-style control · material × state">
            {labels.map((on, i) => (
              <GlassLabel
                key={i}
                icon="hand"
                title="Tracking"
                detail={on ? 'On' : 'Off'}
                material={materials[i >> 1]}
                on={on}
                onClick={() => flip(labels, setLabels, i)}
              />
            ))}
          </Section>
          <Section title="Label · 2×2" note="Accessory tile · material × state">
            {squares.map((on, i) => (
              <GlassLabel
                key={i}
                size="2x2"
                icon="headset"
                title="Headset"
                detail={on ? 'Connected' : 'Off'}
                material={materials[i >> 1]}
                on={on}
                onClick={() => flip(squares, setSquares, i)}
              />
            ))}
          </Section>
          <Section title="Slider · 1×2" note="material × fill level">
            {sliders.map((value, i) => (
              <GlassSlider
                key={i}
                icon={i % 2 ? 'drop' : 'sun'}
                label={`Level ${i + 1}`}
                material={materials[i >> 2]}
                value={value}
                onChange={(v) => setSliders(sliders.map((s, k) => (k === i ? v : s)))}
              />
            ))}
          </Section>
        </div>
        <div className="cc-kit-col">
          <Section title="Cluster · 2×2" note="Connectivity-style chips · accent blue / green">
            {materials.map((material) => (
              <GlassCluster
                key={material}
                label={`Debug layers, ${material}`}
                material={material}
                items={[
                  { icon: 'points', label: 'Landmarks', on: chips[0], onClick: () => flip(chips, setChips, 0) },
                  { icon: 'surface', label: 'Palm surface', on: chips[1], onClick: () => flip(chips, setChips, 1) },
                  { icon: 'box', label: 'Wound box', on: chips[2], onClick: () => flip(chips, setChips, 2), accent: 'green' },
                  { icon: 'pulse', label: 'Jitter', on: chips[3], onClick: () => flip(chips, setChips, 3), accent: 'green' },
                ]}
              />
            ))}
          </Section>
          <Section title="Example · the app's controls" note="as a Control Center grid">
            <AppExample />
          </Section>
        </div>
      </div>
    </main>
  );
}

function Section({ title, note, children }: { title: string; note: string; children: ReactNode }) {
  return (
    <section className="cc-kit-section">
      <h2>{title}</h2>
      <p>{note}</p>
      <div className="cc-kit-row">{children}</div>
    </section>
  );
}

/** The camera view's controls, as they appear over the video. */
function AppExample() {
  const [view, setView] = useState<'camera' | 'mesh'>('camera');
  const [debug, setDebug] = useState(true);
  const [opacity, setOpacity] = useState(0.8);
  const [layers, setLayers] = useState([true, false, true, false]);
  return (
    <GlassGrid label="Example controls">
      <GlassLabel style={at(1, 1, 2)} icon="hand" title="Hand detected" detail="30 FPS · 12 ms" on role="status" />
      <GlassToggle style={at(3, 1)} icon="camera" label="Camera view" on={view === 'camera'} onClick={() => setView('camera')} />
      <GlassToggle style={at(4, 1)} icon="mesh" label="Mesh view" on={view === 'mesh'} onClick={() => setView('mesh')} />
      <GlassSlider style={at(1, 2, 1, 2)} icon="drop" label="Wound opacity" value={opacity} onChange={setOpacity} />
      <GlassToggle style={at(2, 2)} icon="bug" label="Debug" on={debug} onClick={() => setDebug(!debug)} />
      <GlassToggle style={at(2, 3)} icon="stop" label="Stop" />
      <GlassCluster
        style={at(3, 2, 2, 2)}
        label="Debug layers"
        items={[
          { icon: 'points', label: 'Landmarks', on: layers[0], onClick: () => setLayers(layers.map((v, k) => (k === 0 ? !v : v))) },
          { icon: 'surface', label: 'Palm surface', on: layers[1], onClick: () => setLayers(layers.map((v, k) => (k === 1 ? !v : v))) },
          { icon: 'box', label: 'Wound box', on: layers[2], onClick: () => setLayers(layers.map((v, k) => (k === 2 ? !v : v))), accent: 'green' },
          { icon: 'pulse', label: 'Jitter', on: layers[3], onClick: () => setLayers(layers.map((v, k) => (k === 3 ? !v : v))), accent: 'green' },
        ]}
      />
    </GlassGrid>
  );
}
