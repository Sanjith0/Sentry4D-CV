"""GCC-PHAT delay between cam01 and each camera, on the full clip and sliding windows.
offset_X = tX - t1 (app convention videoTime = masterTime + offset, master = cam01)."""
import sys, numpy as np
d = sys.argv[1]; SR = 16000
def load(n):
    x = np.fromfile(f"{d}/cam{n}.raw", dtype="<i2").astype(np.float32) / 32768
    return x - np.convolve(x, np.ones(64) / 64, "same")  # crude high-pass (remove rumble/DC)
def gcc(a, b, maxlag):
    n = 1 << int(np.ceil(np.log2(len(a) + len(b))))
    A = np.fft.rfft(a, n); B = np.fft.rfft(b, n); R = B * np.conj(A)
    R /= np.abs(R) + 1e-12
    f = np.fft.rfftfreq(n, 1 / SR); R[(f < 150) | (f > 6000)] = 0  # speech/impact band
    c = np.fft.irfft(R, n); m = int(maxlag * SR)
    vals = np.r_[c[-m:], c[:m]]; lags = np.r_[np.arange(-m, 0), np.arange(0, m)]
    i = int(np.argmax(vals)); top = vals[i]
    mask = np.abs(lags - lags[i]) > SR * 0.05; second = vals[mask].max()
    return lags[i] / SR, top / second
ref = load("01")
for n in ["02", "03", "04"]:
    x = load(n)
    lag, q = gcc(ref, x, 20)
    print(f"cam{n} full: offset {lag:+.4f} s (peak/2nd {q:.2f})")
    W = 8 * SR
    for s0 in range(0, len(ref) - W, 4 * SR):
        r = np.zeros_like(ref); r[s0:s0 + W] = ref[s0:s0 + W]
        l, qq = gcc(r, x, 20)
        print(f"   cam01 window {s0/SR:5.1f}-{(s0+W)/SR:5.1f}s -> {l:+.4f} s (q {qq:.2f})")
