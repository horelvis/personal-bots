#!/usr/bin/env python3
"""Cut the character avatars out of the source artwork. Standard library only.

    python3 web/scripts/gen-avatars.py [source dir]      (default: avatars/ at the repository root)

Each source file is one character, 1024 x 1056, RGBA, on a transparent background. An avatar is a
768 px square around the head (transparent where it runs off the picture), scaled down by whole
pixel blocks so nothing is blurred twice: 256 px for the app, 64 px for the bot's home screen (that
one travels to the bot's computer inside a command, so it has to be small).

CHARACTERS lists, per file, where the eyes are (x, y): the square is centred on them, a little
low, which leaves room for hats and hair. Two files carry a leftover patch of the old background
next to the head; CLEAN names the rectangle and which pixels in it are background.
"""
import os, struct, sys, zlib

CHARACTERS = [
    ('bot-casual', '01_casual_masculino.png', 525, 335),
    ('bot-music', '02_casual_femenino.png', 573, 330),
    ('bot-suit', '03_ejecutivo_masculino.png', 525, 281),
    ('bot-executive', '04_ejecutiva_femenina.png', 507, 300),
    ('bot-scientist', '05_cientifico.png', 520, 276),
    ('bot-researcher', '06_cientifica.png', 602, 335),
    ('bot-hiker', '07_explorador.png', 531, 311),
    ('bot-explorer', '08_exploradora.png', 578, 314),
    ('bot-chef', '09_chef.png', 574, 331),
    ('bot-attendant', '10_azafata.png', 541, 314),
]

GRAY = lambda r, g, b: 168 <= r <= 202 and 174 <= g <= 207 and 184 <= b <= 224   # the old background, a narrow band
ANY = lambda r, g, b: True

# id -> rectangles (x0, y0, x1, y1, is_background(r, g, b))
CLEAN = {
    # A gray block behind the brim of the hat. The hat is tan, so anything that is not warm goes.
    'bot-explorer': [(170, 175, 345, 320, lambda r, g, b: b >= r - 8)],
    # Blocks on both sides of the head: nothing of the chef is left of x=255 at that height; closer
    # to the hat and to the right of the head only the background's own gray goes.
    'bot-chef': [(0, 195, 255, 335, ANY), (255, 195, 340, 335, GRAY), (738, 235, 1024, 340, GRAY)],
}

SIDE, ABOVE = 768, 420   # the square, and how far above the eyes it starts


def load(path):
    data = open(path, 'rb').read()
    pos, idat = 8, b''
    while pos < len(data):
        n, kind = struct.unpack('>I4s', data[pos:pos + 8])
        body = data[pos + 8:pos + 8 + n]
        pos += 12 + n
        if kind == b'IHDR':
            w, h, depth, colour, _, _, interlace = struct.unpack('>IIBBBBB', body)
        elif kind == b'IDAT':
            idat += body
    if (depth, colour, interlace) != (8, 6, 0):
        sys.exit('%s: expected an 8-bit RGBA PNG without interlacing' % path)
    raw, stride, rows, prev, p = zlib.decompress(idat), w * 4, [], bytearray(w * 4), 0
    for _ in range(h):
        f, line = raw[p], bytearray(raw[p + 1:p + 1 + stride])
        p += 1 + stride
        if f == 1:
            for i in range(4, stride): line[i] = (line[i] + line[i - 4]) & 255
        elif f == 2:
            for i in range(stride): line[i] = (line[i] + prev[i]) & 255
        elif f == 3:
            for i in range(stride): line[i] = (line[i] + (((line[i - 4] if i >= 4 else 0) + prev[i]) >> 1)) & 255
        elif f == 4:
            for i in range(stride):
                a, b, c = (line[i - 4] if i >= 4 else 0), prev[i], (prev[i - 4] if i >= 4 else 0)
                pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
                line[i] = (line[i] + (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 255
        rows.append(line)
        prev = line
    return w, h, rows


def save(path, size, pixels):
    def chunk(kind, body):
        return struct.pack('>I', len(body)) + kind + body + struct.pack('>I', zlib.crc32(kind + body) & 0xffffffff)
    raw = b''.join(b'\x00' + bytes(pixels[y * size * 4:(y + 1) * size * 4]) for y in range(size))
    with open(path, 'wb') as f:
        f.write(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b''))


def shrink(square, block):
    """Average whole blocks of pixels, weighting colour by opacity so transparent pixels do not darken edges."""
    size = SIDE // block
    out = bytearray(size * size * 4)
    for oy in range(size):
        for ox in range(size):
            r = g = b = a = 0
            for y in range(oy * block, (oy + 1) * block):
                line, i = square[y], ox * block * 4
                for _ in range(block):
                    alpha = line[i + 3]
                    r += line[i] * alpha; g += line[i + 1] * alpha; b += line[i + 2] * alpha; a += alpha
                    i += 4
            o = (oy * size + ox) * 4
            if a:
                out[o], out[o + 1], out[o + 2] = round(r / a), round(g / a), round(b / a)
            out[o + 3] = round(a / (block * block))
    return size, out


def main():
    root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    src = sys.argv[1] if len(sys.argv) > 1 else os.path.join(root, 'avatars')
    out = os.path.join(root, 'web', 'public', 'assets', 'avatars')
    os.makedirs(out, exist_ok=True)
    for name, file, ex, ey in CHARACTERS:
        w, h, rows = load(os.path.join(src, file))
        for x0, y0, x1, y1, is_background in CLEAN.get(name, []):
            for y in range(y0, min(y1, h)):
                line = rows[y]
                for x in range(x0, min(x1, w)):
                    i = x * 4
                    if line[i + 3] and is_background(line[i], line[i + 1], line[i + 2]):
                        line[i + 3] = 0
        left, top = ex - SIDE // 2, ey - ABOVE
        square = []
        for y in range(top, top + SIDE):
            line = bytearray(SIDE * 4)
            if 0 <= y < h:
                a, b = max(left, 0), min(left + SIDE, w)
                line[(a - left) * 4:(b - left) * 4] = rows[y][a * 4:b * 4]
            square.append(line)
        save(os.path.join(out, name + '.png'), *shrink(square, 3))
        save(os.path.join(out, name + '.small.png'), *shrink(square, 12))
        print('wrote', name)


if __name__ == '__main__':
    main()
