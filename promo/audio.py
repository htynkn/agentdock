#!/usr/bin/env python3
"""把 render/events.json 里的时间轴合成成 48 kHz 立体声配乐。

声部：
  · 无源蜂鸣器（方波 + 2.7 kHz 共振峰，模拟器件实际音色）
  · 机械按键：触感"咔"+ 低频 thock
  · EC11 棘轮：极短高通噪声
  · 底噪 pad：A2 持续音 + 慢速起伏，跟随影片段落
  · 卷积混响：指数衰减噪声 IR，给蜂鸣器一点房间感
静音（MUTE）之后蜂鸣器声部整体消失，只留机械声 —— 与固件行为一致。

用法：uv run --with numpy python audio.py
"""
import json
import math
import wave
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
SR = 48000
rng = np.random.default_rng(7)


def smoothstep(x):
    x = np.clip(x, 0.0, 1.0)
    return x * x * (3 - 2 * x)


# ---------------------------------------------------------------- 蜂鸣器
def buzzer_note(freq, dur):
    """方波族 + 共振峰：无源蜂鸣器在 2.6~2.8 kHz 有机械共振。"""
    n = max(1, int(dur * SR))
    t = np.arange(n) / SR
    out = np.zeros(n)
    for h, amp in ((1, 1.0), (2, 0.13), (3, 0.52), (5, 0.27), (7, 0.15), (9, 0.08)):
        fh = freq * h
        if fh > SR * 0.45:
            continue
        formant = 0.30 + 0.70 * math.exp(-(((fh - 2700.0) / 1500.0) ** 2))
        out += amp * formant * np.sin(2 * math.pi * fh * t + rng.uniform(0, 6.28))
    # 轻微 PWM 质感，避免纯电子音
    out *= 1.0 + 0.07 * np.sin(2 * math.pi * 90.0 * t)
    env = np.ones(n)
    a = min(int(0.003 * SR), n // 3)
    env[:a] = np.linspace(0, 1, a)
    r = min(int(0.030 * SR), n // 2)
    env[-r:] *= np.exp(-np.linspace(0, 5, r))
    env *= np.exp(-t / max(0.06, dur * 1.6))
    out *= env
    peak = np.max(np.abs(out)) or 1.0
    return out / peak


def melody_track(events, muted_from):
    buf = np.zeros(int(SR * DUR) + SR, dtype=np.float64)
    for e in events:
        if e["type"] != "melody":
            continue
        level = 0.30
        if muted_from is not None and e["t"] > muted_from + 0.05:
            continue  # 静音后蜂鸣器不出声
        for note in e["notes"]:
            seg = buzzer_note(note["f"], note["dur"] * 1.5) * level
            i = int(note["t"] * SR)
            buf[i:i + len(seg)] += seg
    return buf


# ---------------------------------------------------------------- 机械声
def key_click():
    n = int(0.055 * SR)
    t = np.arange(n) / SR
    noise = rng.normal(0, 1, n)
    click = np.diff(noise, prepend=0.0) * np.exp(-t / 0.0022)
    thock = np.sin(2 * math.pi * 96.0 * t) * np.exp(-t / 0.017)
    body = 0.55 * np.sin(2 * math.pi * 210.0 * t) * np.exp(-t / 0.008)
    sig = 0.55 * click + 0.55 * thock + body
    return sig / np.max(np.abs(sig))


def enc_tick():
    n = int(0.012 * SR)
    t = np.arange(n) / SR
    noise = rng.normal(0, 1, n)
    sig = np.diff(noise, prepend=0.0) * np.exp(-t / 0.0011)
    sig += 0.25 * np.sin(2 * math.pi * 1400.0 * t) * np.exp(-t / 0.0016)
    return sig / np.max(np.abs(sig))


def mech_tracks(events):
    L = np.zeros(int(SR * DUR) + SR)
    R = np.zeros_like(L)
    for e in events:
        if e["type"] == "click":
            sig = key_click() * 0.24
            i = int(e["t"] * SR)
            L[i:i + len(sig)] += sig * 0.94
            R[i:i + len(sig)] += sig
        elif e["type"] == "tick":
            sig = enc_tick() * 0.13
            pan = 0.5 + 0.35 * float(np.clip(e.get("v", 1) / 3.0, -1, 1))
            i = int(e["t"] * SR)
            L[i:i + len(sig)] += sig * (1 - 0.5 * pan)
            R[i:i + len(sig)] += sig * (0.5 + 0.5 * pan)
    return L, R


# ---------------------------------------------------------------- pad
PAD_GAIN = [
    (0.0, 0.00), (1.2, 0.34), (4.6, 0.5), (5.2, 0.66), (8.4, 0.62),
    (8.8, 0.74), (14.0, 0.7), (17.2, 0.62), (20.4, 0.66), (20.8, 0.86),
    (21.6, 0.6), (23.6, 0.62), (27.6, 0.72), (28.0, 0.40), (29.9, 0.38),
    (30.1, 0.56), (33.2, 0.5), (34.6, 0.34), (37.0, 0.0),
]


def pad_envelope():
    n = int(SR * DUR)
    t = np.arange(n) / SR
    ts = np.array([p[0] for p in PAD_GAIN])
    gs = np.array([p[1] for p in PAD_GAIN])
    idx = np.clip(np.searchsorted(ts, t) - 1, 0, len(ts) - 2)
    x = (t - ts[idx]) / np.maximum(1e-6, ts[idx + 1] - ts[idx])
    return gs[idx] + (gs[idx + 1] - gs[idx]) * smoothstep(x)


def pad_track():
    n = int(SR * DUR)
    t = np.arange(n) / SR
    lfo1 = 1.0 + 0.28 * np.sin(2 * math.pi * 0.055 * t - 1.2)
    lfo2 = 1.0 + 0.22 * np.sin(2 * math.pi * 0.031 * t + 2.1)

    sig = (
        0.50 * np.sin(2 * math.pi * 110.00 * t) * lfo1
        + 0.26 * np.sin(2 * math.pi * 164.81 * t + 0.7) * lfo2
        + 0.12 * np.sin(2 * math.pi * 220.00 * t + 1.9) * lfo1
        + 0.16 * np.sin(2 * math.pi * 55.00 * t) * lfo2
    )
    # 极轻的低通噪声铺底，去掉纯合成器的干净感
    nz = rng.normal(0, 1, n)
    k = 512
    nz = np.convolve(nz, np.ones(k) / k, mode="same") * 6.0
    sig = sig + 0.10 * nz

    env = pad_envelope()
    sig *= env
    sig /= np.max(np.abs(sig)) or 1.0
    # 缓慢的立体声宽度
    w = 0.12 * np.sin(2 * math.pi * 0.021 * t)
    L = sig * (0.92 + w)
    R = sig * (0.92 - w)
    return L * 0.28, R * 0.28


# ---------------------------------------------------------------- 混响
def reverb_ir(seconds=1.1, decay=0.42):
    n = int(seconds * SR)
    t = np.arange(n) / SR
    ir = rng.normal(0, 1, (2, n)) * np.exp(-t / decay)
    ir[:, : int(0.006 * SR)] = 0.0
    ir /= np.max(np.abs(ir))
    return ir


def convolve(x, ir):
    n = len(x) + len(ir) - 1
    m = 1 << (n - 1).bit_length()
    y = np.fft.irfft(np.fft.rfft(x, m) * np.fft.rfft(ir, m), m)[: len(x)]
    return y


def apply_reverb(L, R, wet, tail):
    ir = reverb_ir()
    wl = convolve(L, ir[0])
    wr = convolve(R, ir[1])
    peak = max(np.max(np.abs(wl)), np.max(np.abs(wr))) or 1.0
    return L + wet * wl / peak * tail, R + wet * wr / peak * tail


# ---------------------------------------------------------------- 主流程
def main():
    global DUR
    data = json.loads((HERE / "render" / "events.json").read_text())
    DUR = float(data["duration"])
    events = data["events"]
    muted_from = data.get("mutedFrom")

    bus_L, bus_R = pad_track()
    pad_len = len(bus_L)

    mel = melody_track(events, muted_from)
    mech_L, mech_R = mech_tracks(events)

    mel_L = mel * 0.92
    mel_R = mel
    mel_L, mel_R = apply_reverb(mel_L, mel_R, wet=0.30, tail=0.16)
    mech_L, mech_R = apply_reverb(mech_L, mech_R, wet=0.16, tail=0.10)
    bus_L = bus_L[:pad_len] + mel_L[:pad_len] + mech_L[:pad_len]
    bus_R = bus_R[:pad_len] + mel_R[:pad_len] + mech_R[:pad_len]

    # 收尾：末 0.6 s 淡出
    n = len(bus_L)
    t = np.arange(n) / SR
    fade = np.ones(n)
    f0 = int((DUR - 0.7) * SR)
    fade[f0:] = np.linspace(1, 0, n - f0) ** 1.4
    bus_L *= fade
    bus_R *= fade

    # 软限幅 + 归一
    mix = np.stack([bus_L, bus_R], axis=1)
    mix = np.tanh(mix * 1.15) / math.tanh(1.15)
    mix /= np.max(np.abs(mix)) or 1.0
    mix *= 10 ** (-1.2 / 20)

    out = HERE / "render" / "audio.wav"
    pcm = (np.clip(mix, -1, 1) * 32767).astype("<i2")
    with wave.open(str(out), "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())
    print(f"音频 → {out.relative_to(HERE)}  {pcm.shape[0] / SR:.2f}s  "
          f"peak {20 * math.log10(np.max(np.abs(mix))):.2f} dBFS")


if __name__ == "__main__":
    main()
