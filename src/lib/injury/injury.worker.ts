import { generateInjury } from './generateInjury';

// Generates the injury maps off the main thread and hands the buffers back.
self.onmessage = (event: MessageEvent<{ size: number }>) => {
  const maps = generateInjury(event.data.size);
  (self as unknown as Worker).postMessage(maps, [
    maps.tint.buffer,
    maps.wound.buffer,
    maps.normal.buffer,
    maps.surface.buffer,
  ]);
};
