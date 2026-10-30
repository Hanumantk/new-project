import { useRef, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { GlassIcon, type GlassIconName } from './icons';

/**
 * Liquid Glass control tiles, after the "Apple Liquid Glass — iOS 26 Control
 * Center" Figma kit. Every tile is three layers, as the kit requires: an
 * empty glass layer behind (blur, rim light), the fill (Over Dark: #242424
 * plus-lighter when off; a bright white stack when on), then the symbol and
 * labels above the glass, undistorted.
 *
 * Sizes follow the kit's grid: a 68 px unit with a 15 px gutter, so a 2×1 or
 * 2×2 tile is 151 px. Material: 'regular' over wallpapers and busy content,
 * 'clear' over photos and video.
 */

export type GlassMaterial = 'regular' | 'clear';

interface TileBaseProps {
  material?: GlassMaterial;
  /** Grid placement (CSS grid-area or column / row spans), when in a GlassGrid. */
  style?: CSSProperties;
  className?: string;
}

function Layers({ on }: { on: boolean }) {
  return (
    <>
      <span className="cc-glass" aria-hidden />
      <span className={on ? 'cc-fill cc-fill--on' : 'cc-fill'} aria-hidden />
    </>
  );
}

function tileClass(kind: string, material: GlassMaterial, on: boolean, extra = '') {
  return `cc-tile cc-${kind} cc-${material}${on ? ' is-on' : ''}${extra ? ` ${extra}` : ''}`;
}

/** Toggle · 1×1: a round control with a symbol. */
export function GlassToggle({
  icon,
  label,
  on = false,
  onClick,
  material = 'regular',
  style,
  className,
}: TileBaseProps & { icon: GlassIconName; label: string; on?: boolean; onClick?: () => void }) {
  return (
    <button
      type="button"
      className={tileClass('toggle', material, on, className)}
      aria-pressed={on}
      aria-label={label}
      title={label}
      onClick={onClick}
      style={style}
    >
      <Layers on={on} />
      <span className="cc-content">
        <GlassIcon name={icon} size={26} />
      </span>
    </button>
  );
}

/** Label · 2×1 (a Focus-style pill) and Label · 2×2 (an accessory tile): a symbol well, a title and a detail line. */
export function GlassLabel({
  icon,
  title,
  detail,
  on = false,
  onClick,
  size = '2x1',
  material = 'regular',
  role,
  tooltip,
  style,
  className,
}: TileBaseProps & {
  icon: GlassIconName;
  /** Shown on hover. */
  tooltip?: string;
  title: ReactNode;
  detail?: ReactNode;
  on?: boolean;
  onClick?: () => void;
  size?: '2x1' | '2x2';
  role?: string;
}) {
  const body = (
    <>
      <Layers on={on} />
      <span className="cc-content">
        <span className="cc-well">
          <GlassIcon name={icon} size={22} />
        </span>
        <span className="cc-text">
          <span className="cc-title">{title}</span>
          {detail != null && <span className="cc-detail">{detail}</span>}
        </span>
      </span>
    </>
  );
  const cls = tileClass(size === '2x2' ? 'square' : 'label', material, on, className);
  return onClick ? (
    <button type="button" className={cls} aria-pressed={on} onClick={onClick} style={style} title={tooltip}>
      {body}
    </button>
  ) : (
    <div className={cls} role={role} style={style} title={tooltip}>
      {body}
    </div>
  );
}

/** Slider · 1×2: a vertical pill that fills from the bottom, with its symbol at the foot. */
export function GlassSlider({
  icon,
  label,
  value,
  onChange,
  material = 'regular',
  style,
  className,
}: TileBaseProps & { icon: GlassIconName; label: string; value: number; onChange: (value: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef(false);
  const setFrom = (event: PointerEvent) => {
    const box = ref.current!.getBoundingClientRect();
    onChange(Math.min(Math.max(1 - (event.clientY - box.top) / box.height, 0), 1));
  };
  const onKey = (event: KeyboardEvent) => {
    const step = event.shiftKey ? 0.1 : 0.01;
    if (event.key === 'ArrowUp' || event.key === 'ArrowRight') onChange(Math.min(value + step, 1));
    else if (event.key === 'ArrowDown' || event.key === 'ArrowLeft') onChange(Math.max(value - step, 0));
    else if (event.key === 'Home') onChange(0);
    else if (event.key === 'End') onChange(1);
    else return;
    event.preventDefault();
  };
  const percent = Math.round(value * 100);
  return (
    <div
      ref={ref}
      className={tileClass('slider', material, false, className)}
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      aria-valuetext={`${percent}%`}
      title={`${label}: ${percent}%`}
      style={style}
      onPointerDown={(event) => {
        drag.current = true;
        (event.target as Element).setPointerCapture?.(event.pointerId);
        setFrom(event);
      }}
      onPointerMove={(event) => drag.current && setFrom(event)}
      onPointerUp={() => (drag.current = false)}
      onPointerCancel={() => (drag.current = false)}
      onKeyDown={onKey}
    >
      <Layers on={false} />
      <span className="cc-slider-fill" style={{ height: `${percent}%` }} aria-hidden />
      <span className={percent > 22 ? 'cc-content cc-slider-icon is-covered' : 'cc-content cc-slider-icon'}>
        <GlassIcon name={icon} size={24} />
      </span>
    </div>
  );
}

export interface ClusterItem {
  icon: GlassIconName;
  label: string;
  on: boolean;
  onClick: () => void;
  /** Colour when on (the kit binds these to accent/blue and accent/green). */
  accent?: 'blue' | 'green' | 'white';
}

/** Connectivity · 2×2: four round toggles in one tile. */
export function GlassCluster({ items, material = 'regular', style, className, label }: TileBaseProps & { items: ClusterItem[]; label: string }) {
  return (
    <div className={tileClass('cluster', material, false, className)} role="group" aria-label={label} style={style}>
      <Layers on={false} />
      <span className="cc-content cc-cluster-grid">
        {items.map((item) => (
          <button
            key={item.label}
            type="button"
            className={`cc-chip${item.on ? ` is-on cc-accent-${item.accent ?? 'blue'}` : ''}`}
            aria-pressed={item.on}
            aria-label={item.label}
            title={item.label}
            onClick={item.onClick}
          >
            <GlassIcon name={item.icon} size={22} />
          </button>
        ))}
      </span>
    </div>
  );
}

/** A Control Center grid: 68 px columns, 15 px gutter. Children place themselves with grid-column / grid-row. */
export function GlassGrid({ columns = 4, children, className = '', label }: { columns?: number; children: ReactNode; className?: string; label?: string }) {
  return (
    <div className={`cc-grid ${className}`} style={{ gridTemplateColumns: `repeat(${columns}, 68px)` }} aria-label={label}>
      {children}
    </div>
  );
}

/** Grid placement helper: column, row (1-based), column span, row span. */
export const at = (column: number, row: number, columns = 1, rows = 1): CSSProperties => ({
  gridColumn: `${column} / span ${columns}`,
  gridRow: `${row} / span ${rows}`,
});
