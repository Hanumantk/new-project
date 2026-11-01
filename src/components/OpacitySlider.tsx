interface OpacitySliderProps {
  /** 0..1 */
  value: number;
  onChange: (value: number) => void;
  className?: string;
}

/** "Wound opacity" range control, 0–100%. */
export function OpacitySlider({ value, onChange, className = '' }: OpacitySliderProps) {
  const percent = Math.round(value * 100);
  return (
    <label className={`panel hud-slider ${className}`}>
      <span>Wound opacity</span>
      <input
        type="range"
        min={0}
        max={100}
        step={1}
        value={percent}
        onChange={(event) => onChange(Number(event.target.value) / 100)}
      />
      <output>{percent}%</output>
    </label>
  );
}
