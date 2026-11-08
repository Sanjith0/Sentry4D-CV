"""Detect camera motion / electronic stabilization: phase-correlate a static
background band (top 30% = ceiling) of each frame against frame 0."""
import sys, numpy as np
W, H = 480, 270
def shift(a, b):
    F = np.fft.fft2(a) * np.conj(np.fft.fft2(b)); F /= np.abs(F) + 1e-9
    c = np.abs(np.fft.ifft2(F)); y, x = np.unravel_index(np.argmax(c), c.shape)
    y = y - c.shape[0] if y > c.shape[0] // 2 else y; x = x - c.shape[1] if x > c.shape[1] // 2 else x
    return x, y
for n in ["01", "02", "03", "04"]:
    v = np.fromfile(f"{sys.argv[1]}/cam{n}.gray", np.uint8).reshape(-1, H, W).astype(np.float32)
    band = v[:, : int(H * 0.3), :]
    win = np.hanning(band.shape[1])[:, None] * np.hanning(W)[None]
    s = np.array([shift(band[0] * win, f * win) for f in band])
    print(f"cam{n}: {len(v)} frames @2fps  max |dx|,|dy| vs frame0 = {np.abs(s).max(0)} px (at 480px wide; x4 for 1920)  nonzero frames: {(np.abs(s).sum(1) > 0).sum()}")
