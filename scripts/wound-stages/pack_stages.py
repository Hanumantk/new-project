"""Copies the wound-stage models into public/models/stages/.

Stage_5 carries three 2048 px PNG textures (~9 MB); they're re-encoded as
1024 px JPEGs (the wound is ~8.5 cm across in the headset), which keeps the
file under 1 MB. The other stages are copied as they are.

Usage: python3 scripts/wound-stages/pack_stages.py <dir with Stage_1.glb … Stage_5.glb>
"""
import io
import json
import struct
import sys
from pathlib import Path

from PIL import Image

SIZE = 1024
QUALITY = {0: 88, 1: 90, 2: 94}  # base colour, occlusion/roughness/metal, normal


def read_glb(data):
    json_len = struct.unpack('<I', data[12:16])[0]
    gltf = json.loads(data[20:20 + json_len])
    bin_start = 20 + json_len + 8
    bin_len = struct.unpack('<I', data[20 + json_len:24 + json_len])[0]
    return gltf, data[bin_start:bin_start + bin_len]


def write_glb(gltf, chunks):
    """Rebuilds the binary chunk from per-bufferView byte strings."""
    blob = bytearray()
    for view, chunk in zip(gltf['bufferViews'], chunks):
        while len(blob) % 4:
            blob.append(0)
        view['byteOffset'] = len(blob)
        view['byteLength'] = len(chunk)
        blob += chunk
    while len(blob) % 4:
        blob.append(0)
    gltf['buffers'] = [{'byteLength': len(blob)}]
    text = json.dumps(gltf, separators=(',', ':')).encode()
    text += b' ' * (-len(text) % 4)
    total = 12 + 8 + len(text) + 8 + len(blob)
    return (struct.pack('<III', 0x46546C67, 2, total) + struct.pack('<II', len(text), 0x4E4F534A) + text
            + struct.pack('<II', len(blob), 0x004E4942) + bytes(blob))


def shrink(data):
    gltf, blob = read_glb(data)
    views = gltf['bufferViews']
    chunks = [blob[v.get('byteOffset', 0):v.get('byteOffset', 0) + v['byteLength']] for v in views]
    for i, image in enumerate(gltf.get('images', [])):
        img = Image.open(io.BytesIO(chunks[image['bufferView']])).convert('RGB').resize((SIZE, SIZE), Image.LANCZOS)
        out = io.BytesIO()
        img.save(out, 'JPEG', quality=QUALITY.get(i, 90), optimize=True)
        chunks[image['bufferView']] = out.getvalue()
        image['mimeType'] = 'image/jpeg'
    return write_glb(gltf, chunks)


def main():
    src = Path(sys.argv[1])
    dest = Path(__file__).resolve().parents[2] / 'public' / 'models' / 'stages'
    dest.mkdir(parents=True, exist_ok=True)
    for n in range(1, 6):
        matches = sorted(src.glob(f'*Stage_{n}.glb'))
        data = matches[0].read_bytes()
        if n == 5:
            data = shrink(data)
        (dest / f'Stage_{n}.glb').write_bytes(data)
        print(f'Stage_{n}.glb', len(data))


if __name__ == '__main__':
    main()
