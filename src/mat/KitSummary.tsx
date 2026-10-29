import type { Kit, KitResult } from './lib/kit';

/**
 * The material mat's kit on the headset page: the items (so edits to
 * materials.json can be checked without a headset), or what's wrong with
 * the file.
 */
export function KitSummary({ result }: { result: KitResult | null }) {
  if (!result) return null;
  return result.ok ? <KitList kit={result.kit} /> : <KitErrors errors={result.errors} />;
}

function KitErrors({ errors }: { errors: string[] }) {
  return (
    <div className="mat-error" role="alert">
      <p className="intro-error">
        materials.json has {errors.length === 1 ? 'a problem' : `${errors.length} problems`}, so the material
        mat is off:
      </p>
      <ul className="mat-error-list">
        {errors.map((error) => (
          <li key={error}>{error}</li>
        ))}
      </ul>
    </div>
  );
}

const footprintLabel = ({ shape, width, depth }: Kit['items'][number]['footprint']) => {
  const cm = (m: number) => `${Math.round(m * 1000) / 10}`;
  return shape === 'circle' ? `⌀ ${cm(width)} cm` : `${cm(width)} × ${cm(depth)} cm`;
};

/** The kit as a list, so edits to materials.json can be checked without a headset. */
function KitList({ kit }: { kit: Kit }) {
  return (
    <details className="mat-kit">
      <summary>
        Material mat: {kit.title} · {kit.items.length} items
      </summary>
      <ol className="mat-kit-list">
        {kit.items.map((item) => (
          <li key={item.id}>
            <span className="mat-kit-step">{item.step}</span>
            <span className="mat-kit-main">
              <strong>{item.name}</strong>
              <span>{item.quantity}</span>
            </span>
            <span className="mat-kit-size">{footprintLabel(item.footprint)}</span>
          </li>
        ))}
      </ol>
    </details>
  );
}
