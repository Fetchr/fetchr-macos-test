"""Саундтрек промо-ролика: музыка и звуки интерфейса, синтезированные с нуля.

    python promo/scripts/soundtrack.py [promo/out/cues.json] [promo/out/soundtrack.wav]

Музыка написана под сетку ролика — 120 BPM, такт 2 с, смены сцен на сильных
долях. Звуки интерфейса ставятся по событиям из cues.json, которые выгружает
сам таймлайн (cues.mjs), поэтому они совпадают с картинкой до кадра.
Никаких сэмплов и чужой музыки: всё — осцилляторы, шум, фильтры и реверб.
"""
import json
import os
import sys
import wave

import numpy as np
from scipy import signal

SR = 48000
BEAT = 0.5
BAR = 2.0
RNG = np.random.default_rng(20260923)

CUES_PATH = sys.argv[1] if len(sys.argv) > 1 else "promo/out/cues.json"
OUT_PATH = sys.argv[2] if len(sys.argv) > 2 else "promo/out/soundtrack.wav"
# Готовый трек вместо синтезированной музыки: звуки интерфейса ложатся поверх
MUSIC_PATH = sys.argv[3] if len(sys.argv) > 3 else None

with open(CUES_PATH, encoding="utf-8") as handle:
    DATA = json.load(handle)
DURATION = float(DATA["duration"])
CUES = DATA["cues"]
N = int(round(DURATION * SR))


# ─────────────────────────── базовые кирпичи ───────────────────────────

def samples(seconds):
    return max(1, int(round(seconds * SR)))


def timeline(seconds):
    return np.arange(samples(seconds)) / SR


def midi_hz(note):
    return 440.0 * 2.0 ** ((note - 69) / 12.0)


def phase_of(freq, n):
    """Фаза для постоянной или меняющейся частоты (глиссандо без щелчков)."""
    freq = np.broadcast_to(np.asarray(freq, dtype=float), (n,))
    return 2 * np.pi * np.cumsum(freq) / SR


def sine(freq, seconds):
    n = samples(seconds)
    return np.sin(phase_of(freq, n))


def poly_blep(t, dt):
    out = np.zeros_like(t)
    lo = t < dt
    x = t[lo] / dt[lo]
    out[lo] = x + x - x * x - 1.0
    hi = t > 1.0 - dt
    x = (t[hi] - 1.0) / dt[hi]
    out[hi] = x * x + x + x + 1.0
    return out


def saw(freq, seconds, phase0=0.0):
    """Пила без алиасинга (polyBLEP)."""
    n = samples(seconds)
    freq = np.broadcast_to(np.asarray(freq, dtype=float), (n,)).copy()
    dt = freq / SR
    t = (phase0 + np.cumsum(dt)) % 1.0
    return 2.0 * t - 1.0 - poly_blep(t, dt)


def triangle(freq, seconds):
    return (2.0 / np.pi) * np.arcsin(np.sin(phase_of(freq, samples(seconds))))


def noise(seconds):
    return RNG.standard_normal(samples(seconds))


def env_ar(seconds, attack, release, curve=1.0):
    """Атака и экспоненциальный спад до конца отрезка."""
    t = timeline(seconds)
    a = np.clip(t / max(attack, 1e-4), 0, 1) ** curve
    r = np.exp(-np.clip(t - attack, 0, None) / max(release, 1e-4))
    return a * r


def env_adsr(seconds, attack, decay, sustain, release):
    t = timeline(seconds)
    hold = max(0.0, seconds - release)
    a = np.clip(t / max(attack, 1e-4), 0, 1)
    d = sustain + (1 - sustain) * np.exp(-np.clip(t - attack, 0, None) / max(decay, 1e-4))
    e = np.where(t < attack, a, d)
    r = np.where(t > hold, np.clip(1 - (t - hold) / max(release, 1e-4), 0, 1), 1.0)
    return e * r


def hump(seconds, peak=0.5, power=2.0):
    """Плавный колокол: 0 → 1 в доле peak → 0."""
    t = timeline(seconds) / seconds
    rise = np.clip(t / peak, 0, 1)
    fall = np.clip((1 - t) / (1 - peak), 0, 1)
    shape = np.where(t < peak, np.sin(np.pi / 2 * rise), np.sin(np.pi / 2 * fall))
    return shape**power


def layer(*parts):
    """Складывает сигналы разной длины: короткие дополняются тишиной."""
    length = max(len(part) for part in parts)
    out = np.zeros(length)
    for part in parts:
        out[: len(part)] += part
    return out


def fade_edges(x, fade=0.004):
    n = min(len(x) // 2, samples(fade))
    if n > 0:
        ramp = np.linspace(0, 1, n)
        x[:n] *= ramp
        x[-n:] *= ramp[::-1]
    return x


# ─────────────────────────── фильтры ───────────────────────────

def _sos(kind, freq, order=2, q=None):
    nyq = SR / 2
    if kind == "band":
        low, high = freq
        return signal.butter(order, [max(20, low) / nyq, min(high, nyq * 0.95) / nyq], btype="band", output="sos")
    return signal.butter(order, min(freq, nyq * 0.95) / nyq, btype=kind, output="sos")


def lowpass(x, freq, order=2):
    return signal.sosfilt(_sos("low", freq, order), x, axis=-1)


def highpass(x, freq, order=2):
    return signal.sosfilt(_sos("high", freq, order), x, axis=-1)


def bandpass(x, low, high, order=2):
    return signal.sosfilt(_sos("band", (low, high), order), x, axis=-1)


def swept(x, freqs, kind="low", width=0.6, block=256):
    """Фильтр с плавающей частотой: пересчёт коэффициентов каждые block сэмплов."""
    out = np.zeros_like(x)
    zi = None
    for start in range(0, len(x), block):
        stop = min(len(x), start + block)
        f = float(freqs[min(len(freqs) - 1, start)])
        if kind == "band":
            sos = _sos("band", (f * (1 - width / 2), f * (1 + width / 2)), 1)
        else:
            sos = _sos(kind, f, 2)
        if zi is None or zi.shape[0] != sos.shape[0]:
            zi = np.zeros((sos.shape[0], 2))
        out[start:stop], zi = signal.sosfilt(sos, x[start:stop], zi=zi)
    return out


def geo(a, b, n):
    return np.geomspace(a, b, n)


# ─────────────────────────── шины и размещение ───────────────────────────

MUSIC = np.zeros((2, N))
SFX = np.zeros((2, N))
SEND = np.zeros((2, N))  # в реверб


def place(bus, x, t0, gain=1.0, pan=0.0, send=0.0):
    """Кладёт моно или стерео сигнал в шину со сдвигом t0 и равномощной панорамой."""
    x = np.asarray(x, dtype=float)
    if x.ndim == 1:
        angle = (pan + 1) * np.pi / 4
        x = np.vstack([x * np.cos(angle), x * np.sin(angle)])
    start = int(round(t0 * SR))
    if start >= N:
        return
    if start < 0:
        x = x[:, -start:]
        start = 0
    stop = min(N, start + x.shape[1])
    bus[:, start:stop] += x[:, : stop - start] * gain
    if send > 0:
        SEND[:, start:stop] += x[:, : stop - start] * gain * send


def db(value):
    return 10 ** (value / 20)


# ─────────────────────────── гармония ───────────────────────────
# Фа-диез минор: F#m9 → Dmaj9 → A(add9) → E6, по такту на два аккорда… по два такта на аккорд.

CHORDS = {
    "F#m9": {"root": 42, "pad": [54, 57, 61, 64, 68]},
    "Dmaj9": {"root": 38, "pad": [50, 54, 57, 61, 64]},
    "Aadd9": {"root": 45, "pad": [52, 57, 59, 61, 64]},
    "E6": {"root": 40, "pad": [52, 56, 59, 61, 64]},
}
PROGRESSION = ["F#m9", "Dmaj9", "Aadd9", "E6"]


def chord_at(t):
    if t < 8:
        return "F#m9"
    if t >= 60:
        return ["F#m9", "Dmaj9", "Aadd9"][min(2, int((t - 60) // 2))]
    return PROGRESSION[int((t - 8) // 4) % 4]


# ─────────────────────────── инструменты ───────────────────────────

def kick(gain=1.0):
    """Бочка, которую слышно и на ноутбуке: саб 46 Гц, «панч» 150 Гц и щелчок колотушки."""
    d = 0.42
    t = timeline(d)
    sub = np.sin(phase_of(46 + 115 * np.exp(-t / 0.028), len(t))) * np.exp(-t / 0.32)
    punch = np.sin(phase_of(110 + 90 * np.exp(-t / 0.012), len(t))) * np.exp(-t / 0.045) * 0.55
    beater = highpass(noise(d), 2500) * np.exp(-t / 0.004) * 0.25
    return np.tanh((sub + punch + beater) * 1.3) * gain


def clap():
    d = 0.35
    x = np.zeros(samples(d))
    for offset in (0.0, 0.011, 0.023):
        burst = bandpass(noise(0.3), 900, 3200) * env_ar(0.3, 0.001, 0.028 if offset < 0.02 else 0.13)
        s = samples(offset)
        part = burst[: len(x) - s]
        x[s : s + len(part)] += part
    return x * 0.8


def hat(open_=False):
    d = 0.3 if open_ else 0.08
    x = highpass(noise(d), 7000, 2) * env_ar(d, 0.0008, 0.13 if open_ else 0.022)
    return x


def pluck(note, d=0.32, bright=2600):
    f = midi_hz(note)
    x = triangle(f, d) * 0.7 + saw(f, d) * 0.3
    x = lowpass(x, bright) * env_ar(d, 0.002, 0.11)
    return fade_edges(x)


def pad_chord(names_times, t0, t1, gain):
    """Пэд: пять расстроенных пил на ноту, мягкий фильтр, широкая стереобаза."""
    length = t1 - t0
    left = np.zeros(samples(length))
    right = np.zeros(samples(length))
    t = timeline(length)
    for name, start, stop in names_times:
        notes = CHORDS[name]["pad"]
        # хвост аккорда перекрывает начало следующего — без провалов на сменах
        seg = min(stop - start + 1.2, t1 - start)
        e = env_adsr(seg, 0.6, 1.5, 0.85, 1.2)
        a = samples(start - t0)
        for note in notes:
            for voice, cents in enumerate((-9, -4, 0, 4, 9)):
                f = midi_hz(note) * 2 ** (cents / 1200)
                wave_ = saw(f, seg, phase0=RNG.random()) * e
                pan = (voice - 2) / 2.2
                angle = (pan + 1) * np.pi / 4
                stop_i = min(len(left), a + len(wave_))
                left[a:stop_i] += wave_[: stop_i - a] * np.cos(angle)
                right[a:stop_i] += wave_[: stop_i - a] * np.sin(angle)
    # медленное «дыхание» фильтра; два каскада — 24 дБ/окт, без жужжания пил
    cutoff = 1000 + 300 * np.sin(2 * np.pi * t / 7.5)
    left = swept(swept(left, cutoff, "low"), cutoff, "low")
    right = swept(swept(right, cutoff, "low"), cutoff, "low")
    stereo = np.vstack([left, right]) * gain / 25
    return stereo


def bell(note, d=2.2, gain=1.0):
    f = midi_hz(note)
    t = timeline(d)
    x = np.zeros_like(t)
    for ratio, amp, tau in ((1.0, 1.0, 0.9), (2.0, 0.45, 0.6), (2.76, 0.35, 0.4), (5.4, 0.18, 0.25), (8.9, 0.08, 0.12)):
        x += amp * np.sin(2 * np.pi * f * ratio * t) * np.exp(-t / tau)
    x *= np.clip(t / 0.003, 0, 1)
    return x * gain / 2


def riser(d, f0=300, f1=6000, gain=1.0):
    n = samples(d)
    x = swept(noise(d), geo(f0, f1, n), "band", width=0.9)
    tone = np.sin(phase_of(geo(midi_hz(54), midi_hz(78), n), n)) * 0.15
    shape = np.linspace(0, 1, n) ** 2.2
    return (x * 0.9 + tone) * shape * gain


def reverse_swell(d, gain=1.0):
    n = samples(d)
    x = swept(noise(d), geo(800, 9000, n), "band", width=1.2)
    return x * np.linspace(0, 1, n) ** 3 * gain


def impact(gain=1.0):
    d = 2.6
    t = timeline(d)
    sub = np.sin(phase_of(62 * np.exp(-t / 1.4) + 28, len(t))) * np.exp(-t / 0.9)
    thump = lowpass(noise(d), 900) * np.exp(-t / 0.08) * 0.9
    air = highpass(noise(d), 3000) * np.exp(-t / 0.35) * 0.25
    return np.tanh((sub * 1.1 + thump + air) * 1.2) * gain


def whoosh(d, f0=400, f1=3000, width=1.0, peak=0.55, gain=1.0):
    n = samples(d)
    x = swept(noise(d), geo(f0, f1, n), "band", width=width)
    return x * hump(d, peak, 1.6) * gain


# ─────────────────────────── музыка ───────────────────────────
# Каждая партия собирается в свой стем, стем выравнивается по RMS своих
# звучащих участков, и только потом партии сводятся. Так баланс задаётся
# числами в STEM_LEVELS, а не подбором громкости отдельных нот на слух.

# Ударные и эффекты — по пику (редкие удары занижают RMS и перегружают пики),
# тональные партии — по RMS звучащих участков.
STEM_LEVELS = {
    "kick": ("peak", -6.0),
    "bass": ("rms", -20.0),
    "drums": ("peak", -12.0),
    "pad": ("rms", -29.0),
    "arp": ("rms", -32.0),
    "fx": ("peak", -12.0),
}


def peak_norm(x):
    peak = np.max(np.abs(x))
    return x / peak if peak > 0 else x


def active_rms_db(bus, floor_db=-40.0):
    """RMS только там, где стем звучит: паузы не занижают уровень."""
    mono = np.mean(bus, axis=0) if bus.ndim == 2 else bus
    window = samples(0.05)
    power = np.convolve(mono**2, np.ones(window) / window, mode="same")
    if power.max() <= 0:
        return -120.0
    active = power > power.max() * db(floor_db) ** 2
    return 10 * np.log10(np.mean(power[active]) + 1e-20)


def new_bus():
    return np.zeros((2, N))


def kick_times():
    """Четыре четверти от раскрытия окна до блока «И ещё»."""
    return [i * BEAT for i in range(int(8 / BEAT), int(54 / BEAT))]


def stem_kick():
    bus = new_bus()
    k = peak_norm(kick())
    for t in kick_times():
        # на раскрытии окна бочка вступает мягче
        place(bus, k, t, gain=0.65 if t < 12 else 1.0)
    return bus


def stem_drums():
    bus = new_bus()
    closed, opened, hand = peak_norm(hat()), peak_norm(hat(open_=True)), peak_norm(clap())
    for i in range(int(12 / BEAT), int(60 / BEAT)):
        t = i * BEAT
        in_break = 54 <= t < 58
        place(bus, opened if i % 4 == 3 else closed, t + BEAT / 2, gain=(0.22 if in_break else 0.3), pan=0.2)
        if not in_break and i % 2 == 0:
            place(bus, closed, t + BEAT * 0.75, gain=0.12, pan=-0.25)
        if t < 54 and i % 2 == 1:
            place(bus, hand, t, gain=1.0, send=0.25)
    # подводка хлопками к каждой следующей фиче
    for start in range(18, 54, 6):
        for j in range(4):
            place(bus, hand, start - BEAT * (4 - j) / 2, gain=0.35 + 0.15 * j, pan=(-1) ** j * 0.3, send=0.2)
    # дробь перед финалом
    for j in range(8):
        place(bus, hand, 59.0 + j * BEAT / 4, gain=0.3 + 0.08 * j, send=0.2)
    return bus


def stem_bass():
    bus = new_bus()
    for i in range(int(8 / (BEAT / 2)), int(54 / (BEAT / 2))):
        t = i * BEAT / 2
        root = CHORDS[chord_at(t)]["root"]
        note = root + (12 if i % 4 == 3 else 0)
        f = midi_hz(note)
        d = BEAT / 2 * 0.95
        tone = np.sin(phase_of(f, samples(d))) + 0.3 * lowpass(saw(f, d), 320)
        tone = peak_norm(tone) * env_adsr(d, 0.004, 0.08, 0.65, 0.05)
        place(bus, tone, t, gain=1.0)
    # длинная суб-нота под логотипом
    sub = np.sin(phase_of(midi_hz(30), samples(3.0))) * env_adsr(3.0, 0.05, 1.0, 0.7, 1.2)
    place(bus, sub, 5.0, gain=0.9)
    return bus


def stem_pad():
    bus = new_bus()
    intro = pad_chord([("F#m9", 0.0, 3.3)], 0.0, 4.0, gain=1.0)
    place(bus, lowpass(intro, 700) * 0.45, 0.0, send=0.4)
    segments = [("F#m9", 5.0, 8.0)]
    t = 8.0
    while t < 60:
        segments.append((chord_at(t), t, min(60.0, t + 4)))
        t += 4
    segments += [("F#m9", 60.0, 62.0), ("Dmaj9", 62.0, 64.0), ("Aadd9", 64.0, DURATION)]
    place(bus, pad_chord(segments, 5.0, DURATION, gain=1.0), 5.0, send=0.5)
    return bus


def stem_arp():
    bus = new_bus()
    pattern = [0, 2, 1, 3, 4, 3, 1, 2]
    for i in range(int(24 / (BEAT / 4)), int(60 / (BEAT / 4))):
        t = i * BEAT / 4
        notes = CHORDS[chord_at(t)]["pad"]
        note = notes[pattern[i % len(pattern)] % len(notes)] + (12 if 36 <= t < 54 and i % 16 >= 8 else 0)
        vel = 0.55 + 0.45 * ((i % 4) == 0)
        place(bus, peak_norm(pluck(note, 0.22, 2200 if t < 36 else 3000)), t, gain=vel)
    # пинг-понг дилей на пунктирную восьмую
    delay = samples(BEAT * 0.75)
    echo = np.zeros_like(bus)
    src = bus.mean(axis=0)
    for tap in range(1, 6):
        shift = delay * tap
        echo[tap % 2, shift:] += src[: N - shift] * 0.42**tap
    return bus + lowpass(echo, 2800)


def stem_fx():
    bus = new_bus()
    place(bus, peak_norm(riser(1.0)), 4.0, gain=0.9, send=0.4)
    place(bus, peak_norm(riser(1.0, 400, 7000)), 7.0, gain=0.8, send=0.3)
    place(bus, peak_norm(riser(2.0, 250, 8000)), 58.0, gain=1.0, send=0.3)
    for start in range(18, 54, 6):
        place(bus, peak_norm(reverse_swell(1.0)), start - 1.0, gain=0.5, send=0.3)
    return bus


def sidechain(depth):
    duck = np.ones(N)
    for t in kick_times():
        s = int(t * SR)
        span = samples(0.28)
        seg = np.arange(span) / SR
        duck[s : s + span] = np.minimum(duck[s : s + span], 1 - depth * np.exp(-seg / 0.09))
    return duck


def build_music(report=True):
    global SEND
    stems = {}
    sends = {}
    for name, build in (
        ("kick", stem_kick),
        ("drums", stem_drums),
        ("bass", stem_bass),
        ("pad", stem_pad),
        ("arp", stem_arp),
        ("fx", stem_fx),
    ):
        before = SEND.copy()
        raw = build()
        mode, target = STEM_LEVELS[name]
        measured = 20 * np.log10(np.max(np.abs(raw)) + 1e-12) if mode == "peak" else active_rms_db(raw)
        gain = db(target - measured)
        stems[name] = raw * gain
        # посыл в реверб выравнивается тем же множителем, что и сам стем
        sends[name] = (SEND - before) * gain
        SEND = before
    for part in sends.values():
        SEND = SEND + part

    MUSIC[:] = (
        stems["kick"]
        + stems["drums"]
        + stems["bass"] * sidechain(0.5)
        + (stems["pad"] + stems["arp"]) * sidechain(0.3)
        + stems["fx"]
    )
    if report:
        for name, bus in stems.items():
            peak = 20 * np.log10(np.max(np.abs(bus)) + 1e-12)
            print(f"  stem {name:5s} active RMS {active_rms_db(bus):6.1f} dBFS · peak {peak:6.1f} dBFS")


# ─────────────────────────── звуки интерфейса ───────────────────────────

def ui_click():
    d = 0.06
    t = timeline(d)
    x = highpass(noise(d), 2500) * np.exp(-t / 0.004) * 0.6
    x += np.sin(2 * np.pi * 2200 * t) * np.exp(-t / 0.012) * 0.5
    x += np.sin(2 * np.pi * 180 * t) * np.exp(-t / 0.02) * 0.4
    return x


def ui_tock(freq=720):
    d = 0.12
    t = timeline(d)
    return (np.sin(2 * np.pi * freq * t) * np.exp(-t / 0.03) + 0.5 * np.sin(2 * np.pi * freq / 4 * t) * np.exp(-t / 0.04)) * 0.6


def ui_blip(freq, d=0.09, tau=0.035):
    t = timeline(d)
    x = triangle(freq, d) * np.exp(-t / tau) * np.clip(t / 0.002, 0, 1)
    return x


def chime(notes, spacing=0.07, gain=1.0):
    out = np.zeros(samples(spacing * len(notes) + 1.2))
    for i, note in enumerate(notes):
        b = bell(note, 1.1)
        s = samples(i * spacing)
        out[s : s + len(b)] += b[: len(out) - s]
    return out * gain


def typing(dur, count):
    count = max(4, min(26, count // 2))
    out = np.zeros(samples(dur + 0.1))
    for i in range(count):
        at = (i + RNG.uniform(-0.3, 0.3)) * dur / count
        click = highpass(noise(0.018), 2200 + RNG.uniform(-400, 600)) * env_ar(0.018, 0.0005, 0.004)
        click += np.sin(2 * np.pi * RNG.uniform(900, 1300) * timeline(0.018)) * env_ar(0.018, 0.0005, 0.006) * 0.25
        s = samples(max(0, at))
        out[s : s + len(click)] += click[: len(out) - s] * RNG.uniform(0.6, 1.0)
    return out


def scanner(dur):
    """Перебор кандидатов: частый счётчик поверх тихого цифрового шелеста."""
    out = np.zeros(samples(dur + 0.1))
    rate = 28
    for i in range(int(dur * rate)):
        f = 1800 + 500 * ((i * 7) % 5) / 5
        b = ui_blip(f, 0.03, 0.008) * (0.5 + 0.5 * i / (dur * rate))
        s = samples(i / rate)
        out[s : s + len(b)] += b[: len(out) - s]
    bed = bandpass(noise(dur + 0.1), 2000, 6000) * 0.08
    bed *= 0.6 + 0.4 * np.sin(2 * np.pi * 9 * timeline(dur + 0.1))
    return out * 0.5 + bed


def censor_beep():
    d = 0.16
    t = timeline(d)
    e = np.clip(t / 0.005, 0, 1) * np.clip((d - t) / 0.008, 0, 1)
    return np.sin(2 * np.pi * 1000 * t) * e


def glitch():
    d = 0.09
    x = noise(d)
    x = np.round(x * 3) / 3
    x = bandpass(x, 600, 5000) * env_ar(d, 0.001, 0.03)
    step = samples(0.004)
    x = np.repeat(x[::step], step)[: samples(d)]
    return x * 0.5


def muffle_whoosh(d=0.8):
    n = samples(d)
    return swept(noise(d), geo(6000, 300, n), "low") * hump(d, 0.25, 1.5) * 0.9


SFX_LEVELS = {
    "click": -11, "tab": -14, "type": -15, "word": -8, "question": -14, "impact": -4,
    "draw": -13, "drawBar": -15, "glow": -12, "unfold": -16, "sheen": -14, "rise": -10,
    "sweep": -16, "cam": -22, "title": -22, "modalOpen": -14, "modalClose": -16, "preview": -16,
    "check": -13, "insert": -12, "success": -11, "start": -16, "countdown": -13, "live": -9,
    "toast": -16, "toggle": -13, "fill": -17, "scan": -15, "found": -10, "fly": -13, "land": -12,
    "message": -18, "render": -20, "press": -15, "drag": -16, "track": -17, "glitch": -14,
    "blur": -12, "muteCut": -14, "beep": -11, "split": -11, "detect": -13, "alert": -11,
    "recede": -10, "card": -14, "log": -20, "filter": -14, "select": -15, "cta": -10, "sparkle": -13,
}

# Ноты «слов» манифеста: восходящая гамма фа-диез минора
WORD_NOTES = [66, 68, 69, 71, 73, 76, 78]


def build_sfx():
    missing = set()
    for item in CUES:
        kind = item["kind"]
        t = float(item["t"])
        dur = float(item.get("dur", 0.4) or 0.4)
        n = int(item.get("n", 0) or 0)
        gain = db(SFX_LEVELS.get(kind, -20)) * float(item.get("gain", 1) or 1)
        pan = 0.0
        send = 0.15

        if kind == "click":
            x = ui_click()
        elif kind == "tab":
            x = ui_tock(760)
        elif kind == "type":
            x = typing(dur, n)
        elif kind == "word":
            d = 0.35
            tt = timeline(d)
            thump = np.sin(phase_of(95 * np.exp(-tt / 0.04) + 45, len(tt))) * np.exp(-tt / 0.12)
            x = thump * 0.8 + ui_blip(midi_hz(WORD_NOTES[n % len(WORD_NOTES)]), d, 0.07) * 0.55
            send = 0.3
        elif kind == "question":
            x = layer(reverse_swell(0.9) * 0.4, ui_blip(midi_hz(61), 0.5, 0.2) * 0.3)
            send = 0.5
        elif kind == "impact":
            x = impact()
            send = 0.45
        elif kind in ("draw", "drawBar"):
            x = whoosh(dur + 0.1, 900, 4200, 0.8, 0.6)
            x += sine(geo(midi_hz(66), midi_hz(78), samples(dur + 0.1)), dur + 0.1) * hump(dur + 0.1, 0.7) * 0.12
            send = 0.35
        elif kind == "glow":
            x = chime([78, 85], 0.05, 0.9)
            send = 0.6
        elif kind == "unfold":
            x = whoosh(dur, 2500, 600, 1.0, 0.4)
            pan = 0.2
        elif kind in ("sheen", "sparkle"):
            n_ = samples(dur)
            x = swept(noise(dur), geo(5000, 12000, n_), "band", 0.5) * hump(dur, 0.5, 1.4) * 0.8
            x += sine(geo(2400, 4800, n_), dur) * hump(dur, 0.5, 2.0) * 0.08
            send = 0.5
        elif kind == "rise":
            x = whoosh(dur, 120, 1600, 1.4, 0.65) * 1.2
            x += sine(geo(55, 110, samples(dur)), dur) * hump(dur, 0.6, 1.5) * 0.5
            send = 0.35
        elif kind == "sweep":
            x = np.zeros(samples(dur + 0.2))
            for i in range(max(1, n)):
                b = ui_blip(midi_hz(72 + [0, 2, 3, 5, 7, 9, 10][i % 7]), 0.08, 0.02)
                s = samples(i * dur / max(1, n))
                x[s : s + len(b)] += b[: len(x) - s]
            send = 0.25
        elif kind == "cam":
            x = whoosh(dur, 300, 1200, 1.2, 0.5) * 0.8
        elif kind == "title":
            x = whoosh(0.5, 1800, 5000, 1.0, 0.3) * 0.6
            pan = -0.3
        elif kind == "modalOpen":
            x = layer(whoosh(0.3, 500, 2600, 1.0, 0.7) * 0.7, ui_blip(880, 0.1, 0.03) * 0.4)
        elif kind == "modalClose":
            x = whoosh(0.3, 2600, 500, 1.0, 0.3) * 0.7
        elif kind == "preview":
            x = ui_blip(1320, 0.12, 0.05)
        elif kind == "check":
            x = layer(ui_click() * 0.8, ui_blip(1760, 0.08, 0.025) * 0.5)
        elif kind == "insert":
            x = layer(ui_tock(330), chime([73], 0.0, 0.35))
            send = 0.3
        elif kind == "success":
            x = chime([73, 78, 81], 0.075)
            send = 0.35
        elif kind == "start":
            x = ui_blip(990, 0.1, 0.03)
        elif kind == "countdown":
            x = ui_blip(1100, 0.12, 0.05) * 0.8
        elif kind == "live":
            x = ui_blip(988, 0.14, 0.06) * 0.8
            s = samples(0.09)
            second = ui_blip(1480, 0.3, 0.12)
            x = np.concatenate([x, np.zeros(samples(0.35))])
            x[s : s + len(second)] += second
            send = 0.3
        elif kind == "toast":
            x = whoosh(0.35, 800, 2400, 1.0, 0.6) * 0.6
        elif kind == "toggle":
            a = ui_click() * 0.7
            x = np.concatenate([a, np.zeros(samples(0.02))])
            x[samples(0.028) : samples(0.028) + len(a)] += a[: len(x) - samples(0.028)] * 0.6
        elif kind == "fill":
            x = typing(0.3, 8) * 0.6
        elif kind == "scan":
            x = scanner(dur)
        elif kind == "found":
            x = chime([76, 80, 83, 88], 0.06)
            send = 0.4
        elif kind == "fly":
            x = whoosh(dur, 700, 3400, 1.0, 0.6)
            pan = 0.0
        elif kind == "land":
            x = layer(ui_tock(560), ui_blip(1760, 0.08, 0.02) * 0.4)
        elif kind == "message":
            x = ui_blip(1500 + 90 * (n % 4), 0.07, 0.018)
            pan = 0.35
        elif kind == "render":
            n_ = samples(dur)
            x = sine(geo(220, 440, n_), dur) * 0.5 + bandpass(noise(dur), 1500, 4000) * 0.1
            x *= hump(dur, 0.85, 1.2) * (0.7 + 0.3 * np.sin(2 * np.pi * 12 * timeline(dur)))
        elif kind == "press":
            x = ui_click() * 0.7
        elif kind == "drag":
            x = lowpass(noise(dur), 1800) * hump(dur, 0.5, 1.2) * 0.8
        elif kind == "track":
            n_ = samples(dur)
            x = bandpass(noise(dur), 1800, 7000) * (0.5 + 0.5 * np.sin(2 * np.pi * 8 * timeline(dur)) ** 2) * 0.3
            x += sine(geo(700, 1400, n_), dur) * 0.12
            x *= hump(dur, 0.9, 1.0)
        elif kind == "glitch":
            x = glitch()
        elif kind == "blur":
            x = muffle_whoosh(0.9)
            send = 0.4
        elif kind == "muteCut":
            x = ui_tock(180) * 0.8
        elif kind == "beep":
            x = censor_beep()
            send = 0.05
        elif kind == "split":
            left = whoosh(0.7, 2500, 500, 1.0, 0.3)
            right = whoosh(0.7, 500, 2500, 1.0, 0.3)
            x = np.vstack([left, right])
        elif kind == "detect":
            x = np.zeros(samples(0.22))
            for offset in (0.0, 0.09):
                b = ui_blip(660, 0.1, 0.04)
                x[samples(offset) : samples(offset) + len(b)] += b
        elif kind == "alert":
            a = ui_blip(740, 0.16, 0.07)
            x = np.concatenate([a, np.zeros(samples(0.2))])
            b = ui_blip(622, 0.2, 0.08)
            x[samples(0.12) : samples(0.12) + len(b)] += b
        elif kind == "recede":
            x = whoosh(dur, 1600, 120, 1.4, 0.3) * 1.2
            x += sine(geo(110, 45, samples(dur)), dur) * hump(dur, 0.3, 1.5) * 0.5
            send = 0.35
        elif kind == "card":
            x = layer(whoosh(0.55, 400, 2200, 1.0, 0.55) * 0.8, ui_blip(midi_hz(78 + 3 * n), 0.1, 0.03) * 0.25)
            pan = [-0.5, 0.0, 0.5][n % 3]
        elif kind == "log":
            x = ui_blip(2100 + 60 * (n % 3), 0.05, 0.012)
            pan = 0.45
        elif kind == "filter":
            x = ui_tock(900) * 0.7
        elif kind == "select":
            x = ui_blip(1320, 0.1, 0.035)
        elif kind == "cta":
            x = layer(ui_tock(440) * 0.8, chime([81, 85], 0.06, 0.8))
            send = 0.45
        else:
            missing.add(kind)
            continue

        # каждый звук сначала к пику 1: уровни в SFX_LEVELS — пиковые dBFS
        x = peak_norm(np.asarray(x, dtype=float))
        if x.ndim == 1:
            x = fade_edges(x.copy(), 0.002)
        place(SFX, x, t, gain=gain, pan=pan, send=send)
    if missing:
        print("no sound for:", ", ".join(sorted(missing)))


# ─────────────────────────── пространство и мастеринг ───────────────────────────

def reverb(bus, seconds=2.8, predelay=0.022):
    n = samples(seconds)
    t = timeline(seconds)
    irs = []
    for channel in range(2):
        tail = RNG.standard_normal(n) * np.exp(-t / (seconds / 6.2))
        tail = lowpass(tail, 5200 - channel * 400)
        early = np.zeros(n)
        for tap in RNG.uniform(0.005, 0.07, 10):
            early[samples(tap)] += RNG.uniform(0.3, 0.7) * RNG.choice([-1, 1])
        ir = np.concatenate([np.zeros(samples(predelay)), early * 0.6 + tail])[:n]
        irs.append(ir / np.sqrt(np.sum(ir**2)))
    wet = np.vstack([signal.fftconvolve(bus[c], irs[c])[:N] for c in range(2)])
    return highpass(wet, 180)


def k_weighted(x):
    b1 = [1.53512485958697, -2.69169618940638, 1.19839281085285]
    a1 = [1.0, -1.69065929318241, 0.73248077421585]
    b2 = [1.0, -2.0, 1.0]
    a2 = [1.0, -1.99004745483398, 0.99007225036621]
    return signal.lfilter(b2, a2, signal.lfilter(b1, a1, x, axis=-1), axis=-1)


def loudness(x):
    """Интегральная громкость по ITU-R BS.1770 (стробирование −70 LUFS и −10 LU)."""
    k = k_weighted(x)
    block = samples(0.4)
    hop = samples(0.1)
    powers = []
    for start in range(0, x.shape[1] - block, hop):
        powers.append(np.sum(np.mean(k[:, start : start + block] ** 2, axis=1)))
    powers = np.array(powers)
    lufs = -0.691 + 10 * np.log10(powers + 1e-12)
    gated = powers[lufs > -70]
    relative = -0.691 + 10 * np.log10(np.mean(gated)) - 10
    final = powers[lufs > max(-70, relative)]
    return -0.691 + 10 * np.log10(np.mean(final))


def limiter(x, ceiling_db=-1.0, lookahead=0.004, release=0.08):
    ceiling = db(ceiling_db)
    peak = np.max(np.abs(x), axis=0)
    need = np.minimum(1.0, ceiling / np.maximum(peak, 1e-9))
    window = samples(lookahead)
    # минимум по окну вперёд — атака успевает до пика
    padded = np.concatenate([need, np.ones(window)])
    ahead = np.lib.stride_tricks.sliding_window_view(padded, window + 1).min(axis=1)[: len(need)]
    gain = np.empty_like(ahead)
    coeff = np.exp(-1.0 / (release * SR))
    level = 1.0
    for i, target in enumerate(ahead):
        level = target if target < level else target + (level - target) * coeff
        gain[i] = level
    return x * gain


def load_music(path):
    """Трек через ffmpeg в 48 кГц стерео, обрезанный или дополненный тишиной до длины ролика."""
    import subprocess

    raw = subprocess.run(
        [os.path.abspath("ffmpeg.exe"), "-v", "error", "-i", path, "-ac", "2", "-ar", str(SR), "-f", "f32le", "-"],
        check=True,
        capture_output=True,
    ).stdout
    x = np.frombuffer(raw, dtype=np.float32).astype(float).reshape(-1, 2).T
    out = np.zeros((2, N))
    out[:, : min(N, x.shape[1])] = x[:, :N]
    return out


# Громкость готового трека в миксе и насколько тише него звуки интерфейса
TRACK_LUFS = -16.0
SFX_BELOW_TRACK_LU = 9.0


def main():
    if MUSIC_PATH:
        music = load_music(MUSIC_PATH)
        music *= db(TRACK_LUFS - loudness(music))
        build_sfx()
        sfx = SFX + reverb(SEND) * 0.55
        sfx_level = loudness(sfx)
        sfx *= db(TRACK_LUFS - SFX_BELOW_TRACK_LU - sfx_level)
        print(f"track {TRACK_LUFS:.1f} LUFS · sfx {TRACK_LUFS - SFX_BELOW_TRACK_LU:.1f} LUFS (было {sfx_level:.1f})")
        mix = music + sfx
    else:
        build_music()
        build_sfx()
        music = MUSIC.copy()
        # музыка чуть уступает звукам интерфейса там, где их много
        activity = np.abs(SFX).max(axis=0)
        activity = signal.filtfilt(*signal.butter(1, 3 / (SR / 2)), activity)
        music *= 1 - 0.2 * np.clip(activity / 0.1, 0, 1)
        mix = music + SFX + reverb(SEND) * 0.55
    mix = highpass(mix, 28)

    # финальное затухание вместе с картинкой
    fade = np.ones(N)
    tail = samples(3.0 if MUSIC_PATH else 1.2)
    fade[-tail:] = np.linspace(1, 0, tail) ** 1.5
    fade[: samples(0.02)] = np.linspace(0, 1, samples(0.02))
    mix *= fade

    target = -14.0 if MUSIC_PATH else -15.0
    current = loudness(mix)
    mix *= db(target - current)
    mix = limiter(mix, -1.0)
    final = loudness(mix)
    print(f"loudness {current:.1f} → {final:.1f} LUFS, peak {20 * np.log10(np.max(np.abs(mix))):.2f} dBFS")

    pcm = np.clip(mix.T, -1, 1)
    data = np.ascontiguousarray((pcm * (2**23 - 1)).astype("<i4"))
    # 24 бита: младшие три байта каждого int32
    raw = data.view(np.uint8).reshape(-1, 4)[:, :3].tobytes()
    with wave.open(OUT_PATH, "wb") as out:
        out.setnchannels(2)
        out.setsampwidth(3)
        out.setframerate(SR)
        out.writeframes(raw)
    print(f"soundtrack: {OUT_PATH} · {DURATION:.2f} s")


if __name__ == "__main__":
    main()
