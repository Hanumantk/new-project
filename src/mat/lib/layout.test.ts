import { describe, expect, it } from 'vitest';
import seedFile from '../../../public/material-mat/materials.json';
import { parseKit } from './kit';
import { LAYOUT, cellSize, layoutKit, type SlotLayout } from './layout';

const seed = parseKit(structuredClone(seedFile));
if (!seed.ok) throw new Error(seed.errors.join('\n'));
const items = seed.kit.items;

const overlaps = (a: SlotLayout, b: SlotLayout) =>
  a.left < b.left + b.width - 1e-9 &&
  b.left < a.left + a.width - 1e-9 &&
  a.back < b.back + b.depth - 1e-9 &&
  b.back < a.back + a.depth - 1e-9;

describe('layoutKit', () => {
  it('fits all 13 items on one page of an 80 × 50 cm mat, inside the margins, without overlaps', () => {
    const layout = layoutKit(items, 0.8, 0.5);
    expect(layout.pages).toBe(1);
    expect(layout.slots).toHaveLength(13);
    for (const s of layout.slots) {
      expect(s.left).toBeGreaterThanOrEqual(-0.4 + LAYOUT.margin - 1e-9);
      expect(s.left + s.width).toBeLessThanOrEqual(0.4 - LAYOUT.margin + 1e-9);
      expect(s.back).toBeGreaterThanOrEqual(-0.25 + LAYOUT.margin - 1e-9);
      expect(s.back + s.depth).toBeLessThanOrEqual(0.25 - LAYOUT.margin + 1e-9);
      expect(s.oversize).toBe(false);
    }
    for (let i = 0; i < 13; i++) for (let j = i + 1; j < 13; j++) expect(overlaps(layout.slots[i], layout.slots[j])).toBe(false);
  });

  it('keeps step order: left to right, then the next row further forward', () => {
    const { slots } = layoutKit(items, 0.8, 0.5);
    for (let i = 1; i < slots.length; i++) {
      const [a, b] = [slots[i - 1], slots[i]];
      const sameRow = Math.abs(a.back - b.back) < 1e-9;
      if (sameRow) expect(b.left).toBeGreaterThan(a.left);
      else expect(b.back).toBeGreaterThan(a.back);
    }
  });

  it('pages a small mat, every item exactly once, each page within the mat', () => {
    const layout = layoutKit(items, 0.3, 0.22);
    expect(layout.pages).toBeGreaterThan(2);
    expect(layout.slots.map((s) => s.item)).toEqual(items.map((_, i) => i));
    const pages = layout.slots.map((s) => s.page);
    expect(pages).toEqual([...pages].sort((a, b) => a - b)); // step order runs through the pages
    for (const s of layout.slots) {
      expect(s.back).toBeGreaterThanOrEqual(-0.11 + LAYOUT.margin - 1e-9);
      expect(s.back + s.depth).toBeLessThanOrEqual(0.11 - LAYOUT.margin + 1e-9);
    }
  });

  it('keeps footprints at true scale and the quantity model beside them', () => {
    const { slots } = layoutKit(items, 0.8, 0.5);
    const waxIndex = items.findIndex((i) => i.id === 'wax');
    const wax = slots[waxIndex];
    const item = items[waxIndex];
    expect(wax.footprintX).toBeCloseTo(wax.left + 0.03, 9); // 6 cm tub
    expect(wax.visualX - wax.footprintX).toBeCloseTo(0.03 + LAYOUT.visualGap + item.visual!.width / 2, 9);
    expect(wax.width).toBeCloseTo(cellSize(item).width, 9);
  });

  it('flags an item bigger than the mat', () => {
    const big = [{ footprint: { width: 0.5, depth: 0.1 }, visual: null }];
    expect(layoutKit(big, 0.3, 0.3).slots[0].oversize).toBe(true);
  });
});
