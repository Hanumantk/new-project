import { describe, expect, it } from 'vitest';
import seedFile from '../../../public/material-mat/materials.json';
import { domeRadius, parseKit } from './kit';

/** The seed file, loosely typed so tests can break it. */
const seedJson = () => structuredClone(seedFile) as unknown as { items: Record<string, unknown>[] };

describe('parseKit', () => {
  it('accepts the bundled materials.json: 13 items in step order, sizes in metres', () => {
    const result = parseKit(seedJson());
    if (!result.ok) throw new Error(result.errors.join('\n'));
    const { items } = result.kit;
    expect(items).toHaveLength(13);
    expect(items.map((i) => i.step)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
    const wax = items.find((i) => i.id === 'wax')!;
    expect(wax.footprint).toEqual({ shape: 'circle', width: 0.06, depth: 0.06 });
    expect(wax.visual).toMatchObject({ type: 'sphere', radius: 0.008 });
    const spatula = items.find((i) => i.id === 'spatula')!;
    expect(spatula.footprint).toEqual({ shape: 'pill', width: 0.15, depth: 0.02 });
  });

  it('sorts by step, keeping file order for equal steps', () => {
    const json = seedJson();
    json.items = [json.items[2], json.items[0], { ...json.items[1], id: 'x', step: 1 }];
    const result = parseKit(json);
    if (!result.ok) throw new Error(result.errors.join('\n'));
    expect(result.kit.items.map((i) => i.id)).toEqual(['alcohol', 'x', 'cotton']);
  });

  it('lists every problem with where it is', () => {
    const json = seedJson();
    json.items[0].footprint = { shape: 'circle' };
    json.items[1].quantity = '';
    json.items[2].id = 'alcohol';
    json.items[3].quantityVisual = { type: 'cube', size: 2 };
    const result = parseKit(json);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual([
      'items[0] (alcohol): "footprint.diameter" must be a size in cm (more than 0, at most 200).',
      'items[1] (spirit-gum): "quantity" must be a non-empty string.',
      'items[2] (alcohol): "id" "alcohol" is used twice.',
      'items[3] (wax): "quantityVisual.type" must be "sphere", "blob" or "drops".',
    ]);
  });

  it('sizes a ½ teaspoon blob of blood by its volume', () => {
    // A dome r across and r/2 tall holds (1/3)πr³: 2.5 ml → r ≈ 1.34 cm.
    expect(domeRadius(2.5)).toBeCloseTo(0.01337, 4);
  });
});
