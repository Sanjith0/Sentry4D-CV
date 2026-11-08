import sys, numpy as np
d = sys.argv[1]; SR = 16000
off = {"01": 0, "02": 0.401, "03": 0.146, "04": 9.60}
def env(n):
    x = np.fromfile(f"{d}/cam{n}.raw", dtype="<i2").astype(np.float32) / 32768
    x = x - np.convolve(x, np.ones(64)/64, "same"); hop = 160
    m = len(x)//hop; e = 10*np.log10((x[:m*hop].reshape(m, hop)**2).mean(1) + 1e-10); return e
for n in off:
    e = env(n); base = np.median(e)
    on = np.diff(e, prepend=e[0])  # dB jump per 10 ms
    idx = [i for i in np.argsort(on)[::-1] if e[i] > base + 15][:40]
    picks = []
    for i in sorted(idx, key=lambda i: -on[i]):
        if all(abs(i - j) > 50 for j in picks): picks.append(i)
        if len(picks) == 6: break
    print(f"cam{n} (offset {off[n]:+.3f}): " + ", ".join(f"v{i/100:6.2f}s->m{i/100-off[n]:6.2f} (+{on[i]:.0f}dB, {e[i]-base:.0f}dB>med)" for i in sorted(picks)))
