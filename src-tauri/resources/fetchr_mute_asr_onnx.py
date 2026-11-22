"""Fetchr Mute bridge for GigaAM v3 INT8 models (Russian-only).

The runner delegates the model-specific preprocessor and decoding to
onnx-asr 0.12.0, then groups its token timestamps into word intervals.
stdout is reserved for the final JSON protocol; diagnostics go to stderr.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
import tempfile
import wave
from pathlib import Path
from types import SimpleNamespace


if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")
if hasattr(sys.stdin, "reconfigure"):
    # Rust sends the serve protocol as UTF-8 JSON. On Windows, redirected
    # stdin otherwise follows the active ANSI code page, corrupting Cyrillic
    # paths such as C:\Users\<name>\AppData\Local\Fetchr\...
    sys.stdin.reconfigure(encoding="utf-8")


SAMPLE_RATE = 16_000
ASR_BATCH_SIZE = 8
# Бустинг словаря по умолчанию выключен: выигрыш в полноте на реальном
# материале не подтверждён, а modified_beam_search стоит +30% времени (замер
# ниже в hotwords_score). FETCHR_ASR_BEAM=on|4 включает его обратно.
BEAM_DEFAULT_PATHS = 1
BEAM_ENABLED_PATHS = 4
HOTWORDS_DEFAULT_SCORE = 1.2
HOTWORDS_MAX_SCORE = 2.5
PAUSE_WORD_BOUNDARY_S = 0.20
WORD_LEAD_S = 0.06
# Запас после последнего кадра слова. Полный хвост — FRAME_STEP_S + это
# значение, то есть прежние 0.10 с.
WORD_TAIL_S = 0.06

MODELS = {
    "gigaam-v3-rnnt": {
        "model_type": "nemo_transducer",
        "encoder": "encoder.int8.onnx",
        "decoder": "decoder.onnx",
        "joiner": "joiner.onnx",
        "tokens": "tokens.txt",
    },
}

MODEL_FILE_KEYS = ("encoder", "decoder", "joiner", "tokens")

# Один кадр энкодера GigaAM: окно 10 мс, subsampling 4. Границы слов приходят
# в кадрах, поэтому конец слова — это конец его последнего кадра, а не точка
# эмиссии токена.
FRAME_STEP_S = 0.04


def prepare_model(model_dir: Path, backend: str) -> dict:
    spec = MODELS[backend]
    missing = [
        spec[key] for key in MODEL_FILE_KEYS if not (model_dir / spec[key]).is_file()
    ]
    if missing:
        raise RuntimeError(f"{backend} ONNX model is incomplete: " + ", ".join(missing))
    return spec


def pcm_data_offset(path: Path) -> int:
    """Byte offset of the samples in a RIFF/WAVE file (after fmt, LIST, ...)."""
    with open(path, "rb") as handle:
        header = handle.read(12)
        if header[:4] != b"RIFF" or header[8:12] != b"WAVE":
            raise ValueError("ASR input is not a RIFF/WAVE file")
        while True:
            chunk = handle.read(8)
            if len(chunk) < 8:
                raise ValueError("ASR input has no data chunk")
            size = int.from_bytes(chunk[4:], "little")
            if chunk[:4] == b"data":
                return handle.tell()
            handle.seek(size + (size & 1), 1)


class Pcm16Samples:
    """Mono 16-bit PCM mapped from disk; each slice is converted to float32
    on access, with the same arithmetic as converting the whole file.

    Reading the file whole held it three times (raw bytes, the float32 copy,
    the scaled result): ~1.7 GB for a 3 h stream, only to cut <=12 s
    segments out of it."""

    def __init__(self, path: Path, frames: int):
        import numpy as np

        self._np = np
        if frames:
            self._pcm = np.memmap(
                str(path), dtype="<i2", mode="r", offset=pcm_data_offset(path), shape=(frames,)
            )
        else:
            self._pcm = np.zeros(0, dtype="<i2")

    def __len__(self) -> int:
        return len(self._pcm)

    def __getitem__(self, key):
        if not isinstance(key, slice):
            raise TypeError("Pcm16Samples supports slices only")
        return self._np.asarray(self._pcm[key]).astype(self._np.float32) / 32768.0


def read_pcm16_mono(path: Path):
    with wave.open(str(path), "rb") as wav:
        if wav.getnchannels() != 1 or wav.getsampwidth() != 2:
            raise ValueError("ASR input must be mono 16-bit PCM WAV")
        sample_rate = wav.getframerate()
        frames = wav.getnframes()
    if sample_rate != SAMPLE_RATE:
        raise ValueError(f"ASR input must be {SAMPLE_RATE} Hz, got {sample_rate}")
    return Pcm16Samples(path, frames)


def token_confidence(logprob: float) -> float:
    if not math.isfinite(logprob):
        return 0.0
    # Натуральный логарифм вероятности. Положительных значений тут быть не
    # должно: они означают, что к лог-вероятности что-то прибавили (бустинг
    # словаря), и вычитать это обязан вызывающий.
    return min(1.0, max(0.0, math.exp(min(0.0, logprob))))


def build_hotword_prefixes(words) -> tuple[frozenset[str], int]:
    """Все префиксы слов из словаря бустинга плюс длина самого длинного.

    ContextGraph поднимает токен, если тот продолжает совпадение с любым словом
    списка, и совпадение может начаться в середине слова («картинКУРВЕт»).
    Поэтому проверяются суффиксы уже набранного слова, а не только его начало."""
    prefixes = set()
    longest = 0
    for word in words:
        longest = max(longest, len(word))
        for end in range(1, len(word) + 1):
            prefixes.add(word[:end])
    return frozenset(prefixes), longest


def token_was_boosted(chars: list[str], prefixes: frozenset[str], longest: int) -> bool:
    """Был ли последний символ поднят бустингом: заканчивается ли на нём хоть
    одно совпадение с началом слова из словаря.

    Это модель состояния ContextGraph, а не сам ContextGraph: на чужом слове с
    похожим началом («трепетом» против «требуя») можно вычесть бустинг там, где
    sherpa его не давала. Ошибка ограничена одним score на токен и всегда
    занижает уверенность — то есть в сторону меньшего числа мутов."""
    if not prefixes or not chars:
        return False
    tail = "".join(chars[-longest:])
    return any(tail[start:] in prefixes for start in range(len(tail)))


def timestamped_result_to_words(
    result,
    base_time: float,
    duration: float,
    boost: float = 0.0,
    prefixes: frozenset[str] = frozenset(),
    longest_hotword: int = 0,
) -> list[dict]:
    tokens = list(result.tokens or [])
    timestamps = list(result.timestamps or [])
    logprobs = list(result.logprobs or [])
    if not (len(tokens) == len(timestamps) == len(logprobs)):
        raise RuntimeError(
            "onnx-asr returned mismatched token/timestamp/logprob lengths: "
            f"{len(tokens)}/{len(timestamps)}/{len(logprobs)}"
        )

    words: list[dict] = []
    chars: list[str] = []
    char_times: list[float] = []
    char_logprobs: list[float] = []
    previous_time: float | None = None

    def flush(boundary_time: float | None = None) -> None:
        nonlocal chars, char_times, char_logprobs
        raw = "".join(chars).strip(" '-")
        if not raw or not char_times:
            chars, char_times, char_logprobs = [], [], []
            return

        # Границы слова считаются по кадрам энкодера, как в референсной
        # реализации GigaAM (gigaam/timestamps_utils.py, frames_to_words):
        # слово кончается вместе с кадром своего последнего символа, а не в
        # точке эмиссии токена. WORD_LEAD_S/WORD_TAIL_S — запас на задержку
        # эмиссии RNN-T.
        start = max(0.0, char_times[0] - WORD_LEAD_S)
        end = min(duration, char_times[-1] + FRAME_STEP_S + WORD_TAIL_S)
        if boundary_time is not None:
            end = min(end, max(char_times[-1] + FRAME_STEP_S, boundary_time))
        if end <= start:
            end = min(duration, start + 0.08)

        confidence = math.exp(
            sum(math.log(max(token_confidence(value), 1e-9)) for value in char_logprobs)
            / len(char_logprobs)
        )
        words.append(
            {
                "raw": raw,
                "start": base_time + start,
                "end": base_time + end,
                "confidence": min(1.0, max(0.0, confidence)),
            }
        )
        chars, char_times, char_logprobs = [], [], []

    for token, timestamp, logprob in zip(tokens, timestamps, logprobs):
        time_s = min(duration, max(0.0, float(timestamp)))
        text = str(token).replace("▁", " ")
        for character in text:
            if character.isspace():
                flush(time_s)
                previous_time = time_s
                continue

            if (
                chars
                and previous_time is not None
                and time_s - previous_time >= PAUSE_WORD_BOUNDARY_S
            ):
                # CTC occasionally drops a space token. A clear acoustic pause
                # still provides a reliable boundary (e.g. "хуйван" ->
                # "хуй", "ван") without dictionary-driven splitting.
                flush(previous_time + FRAME_STEP_S + WORD_TAIL_S)

            chars.append(character)
            char_times.append(time_s)
            # sherpa прибавляет бустинг прямо к лог-вероятности токена
            # (offline-transducer-modified-beam-search-nemo-decoder.cc:269) и
            # её же кладёт в ys_log_probs. Без вычитания всё, что похоже на
            # начало слова из словаря, приходит с уверенностью около единицы:
            # пороги фильтрации слепнут и под мут уезжают «курсе» и «стать».
            value = float(logprob)
            if boost and token_was_boosted(chars, prefixes, longest_hotword):
                value -= boost
            char_logprobs.append(value)
            previous_time = time_s

    flush(duration)

    if words or not result.text:
        return words

    # Defensive fallback. Current GigaAM CTC models always expose token
    # timestamps, but a future onnx-asr regression should not crash processing.
    raw_words = str(result.text).split()
    width = duration / max(1, len(raw_words))
    return [
        {
            "raw": raw,
            "start": base_time + index * width,
            "end": base_time + min(duration, (index + 1) * width),
            "confidence": 0.5,
        }
        for index, raw in enumerate(raw_words)
    ]


def adapt_result(result):
    """Результат sherpa к виду, который ждёт `timestamped_result_to_words`.
    `ys_log_probs` заполняют оба декодера NeMo, но пустой список тут не должен
    ронять задачу — тогда уверенность просто максимальная."""
    tokens = list(result.tokens or [])
    logprobs = list(result.ys_log_probs or [])
    if len(logprobs) != len(tokens):
        logprobs = [0.0] * len(tokens)
    return SimpleNamespace(
        text=result.text,
        tokens=tokens,
        timestamps=list(result.timestamps or []),
        logprobs=logprobs,
    )


def recognize_batch(recognizer, waveforms, hotwords: str):
    """Батч распознаётся одним вызовом энкодера. Бустинг словаря задаётся на
    поток: он меняется от задачи к задаче (свои слова, белый список), а
    перезагружать ради этого модель незачем."""
    streams = []
    for waveform in waveforms:
        stream = recognizer.create_stream(hotwords) if hotwords else recognizer.create_stream()
        stream.accept_waveform(SAMPLE_RATE, waveform)
        streams.append(stream)
    recognizer.decode_streams(streams)
    return [adapt_result(stream.result) for stream in streams]


def select_provider() -> str:
    """Execution provider для sherpa-onnx: FETCHR_ORT_PROVIDERS="cuda,cpu"
    задаёт порядок предпочтения, берётся первое известное имя. sherpa
    принимает ровно один провайдер, а не список."""
    aliases = {
        "cuda": "cuda",
        "dml": "directml",
        "directml": "directml",
        "coreml": "coreml",
        "cpu": "cpu",
    }
    requested = os.environ.get("FETCHR_ORT_PROVIDERS", "cpu")
    for name in requested.split(","):
        provider = aliases.get(name.strip().lower())
        if provider:
            return provider
    return "cpu"


def provider_argument() -> str:
    """sherpa задаёт свои SessionOptions сама и не даёт выключить busy-wait
    пулов ONNX Runtime напрямую. Единственный доступный путь — файл конфига
    провайдера: ключи `SessionConfig.*` уходят в
    `Ort::SessionOptions::AddConfigEntry` как есть."""
    provider = select_provider()
    if spinning_enabled():
        return provider
    # Каталог рантайма тут не известен, а рядом с самим скриптом файл плодить
    # незачем: конфиг одинаковый для всех запусков и переживает перезапись.
    config_path = Path(tempfile.gettempdir()) / "fetchr-ort-session.config"
    try:
        config_path.write_text(
            "SessionConfig.session.intra_op.allow_spinning=0\n"
            "SessionConfig.session.inter_op.allow_spinning=0\n",
            encoding="utf-8",
        )
    except OSError:
        # Без конфига распознавание работает, просто медленнее.
        return provider
    return f"{provider}:{config_path}"


def hotwords_score() -> float:
    """Бустинг задаётся на токен, а токены здесь посимвольные: слово из шести
    букв получает шестикратный буст. Отсюда осторожный дефолт и жёсткий потолок.

    Замер на чистой речи (11 с, словарь из 10 слов): 1.2 и 2.0 не меняют
    расшифровку вообще, на 3.0 «похвал» превращается в «похуй», на 4.0 текст
    рассыпается в «нахуй нахуй чьих не требуя похуй». Ложное срабатывание тут
    стоит дороже пропуска: оно глушит чистое слово."""
    raw = os.environ.get("FETCHR_ASR_HOTWORDS_SCORE", "").strip()
    try:
        value = float(raw) if raw else HOTWORDS_DEFAULT_SCORE
    except ValueError:
        value = HOTWORDS_DEFAULT_SCORE
    return min(HOTWORDS_MAX_SCORE, max(0.0, value))


def beam_paths() -> int:
    """Число путей modified_beam_search. 1 — greedy, то есть без бустинга
    словаря: он живёт только в лучевом поиске."""
    raw = os.environ.get("FETCHR_ASR_BEAM", "").strip().lower()
    if raw in ("off", "no"):
        return 1
    if raw in ("on", "yes"):
        return BEAM_ENABLED_PATHS
    try:
        value = int(raw) if raw else BEAM_DEFAULT_PATHS
    except ValueError:
        value = BEAM_DEFAULT_PATHS
    return max(1, value)


def read_hotwords(path: Path | None) -> list[str]:
    """Файл со списком слов, по одному на строку. Токенизацией занимается сама
    sherpa (modeling_unit=cjkchar разбивает строку на UTF-8 символы — ровно
    посимвольный словарь GigaAM), ей список отдаётся через "/"."""
    if path is None or not path.is_file():
        return []
    words = []
    for line in path.read_text(encoding="utf-8").splitlines():
        word = line.strip()
        if word and not word.startswith("#"):
            words.append(word)
    return words


# --- Silero VAD: отсев неречевых сегментов до ASR -----------------------------
# Энергетическая предсегментация в Rust намеренно широкая и пропускает музыку
# и шум в распознавание. Silero VAD (2.3 МБ, ~4 с на час аудио) отбрасывает
# сегменты без речи: на стримах с музыкой это минус 20-60% работы ASR.
# Порог намеренно низкий — пропуск речи хуже, чем лишний сегмент в ASR.
VAD_WINDOW = 512
VAD_CONTEXT = 64
VAD_DEFAULT_THRESHOLD = 0.35

_RECOGNIZERS: dict = {}


class VadFilter:
    def __init__(self, model_path: Path):
        import numpy as np
        import onnxruntime

        self.np = np
        self.session = onnxruntime.InferenceSession(
            str(model_path), providers=["CPUExecutionProvider"]
        )
        self.sr = np.array(SAMPLE_RATE, dtype=np.int64)
        raw = os.environ.get("FETCHR_ASR_VAD_THRESHOLD", "")
        try:
            self.threshold = float(raw) if raw else VAD_DEFAULT_THRESHOLD
        except ValueError:
            self.threshold = VAD_DEFAULT_THRESHOLD

    def has_speech(self, audio) -> bool:
        # Silero v5 ждёт перед каждым окном 64 сэмпла контекста (так делает
        # официальный OnnxWrapper). Без него вероятности занижены, и тихая
        # речь под музыкой проваливалась ниже порога.
        np = self.np
        state = np.zeros((2, 1, 128), dtype=np.float32)
        context = np.zeros(VAD_CONTEXT, dtype=np.float32)
        limit = len(audio) - VAD_WINDOW + 1
        for offset in range(0, limit, VAD_WINDOW):
            chunk = np.asarray(audio[offset : offset + VAD_WINDOW], dtype=np.float32)
            output, state = self.session.run(
                None,
                {
                    "input": np.concatenate([context, chunk])[None, :],
                    "state": state,
                    "sr": self.sr,
                },
            )
            context = chunk[-VAD_CONTEXT:]
            if float(output[0, 0]) >= self.threshold:
                return True
        return False


def spinning_enabled() -> bool:
    """Busy-wait пулов ONNX Runtime. По умолчанию выключен: с ним три сессии
    RNN-T дерутся за одни и те же ядра. FETCHR_ASR_SPINNING=on возвращает
    прежнее поведение."""
    return os.environ.get("FETCHR_ASR_SPINNING", "").strip().lower() in ("on", "1", "yes")


def vad_filter_enabled() -> bool:
    """Silero VAD включён по умолчанию.

    На стримах с музыкой и звуком игры карта тишины не отсекает ничего: фон
    громкий, и в распознавание уходят куски без речи. На них модель выдаёт
    мусорные токены, часть которых совпадает с корнями мата, и мут ложится на
    пустой фон. Порог низкий (0.35): сегмент с речью VAD почти не теряет.
    FETCHR_ASR_VAD=off выключает фильтр."""
    return os.environ.get("FETCHR_ASR_VAD", "").strip().lower() not in ("off", "0", "no")


# --- Морфология: начальные формы слов (pymorphy3) ----------------------------
# Корневая эвристика мата ищет подстроки и цепляет чистые слова («психуешь»,
# «гребли»). Лемма из словаря отличает их: «психовать», «гребля». Отдаётся
# только для слов, которые словарь знает, — догадки по суффиксу для мата
# ненадёжны («отъебись» → «отъестись»).
_MORPH = None
_MORPH_FAILED = False


def morph_analyzer():
    global _MORPH, _MORPH_FAILED
    if _MORPH is None and not _MORPH_FAILED:
        try:
            import pymorphy3

            _MORPH = pymorphy3.MorphAnalyzer()
        except Exception as error:
            _MORPH_FAILED = True
            print(f"pymorphy3 unavailable, lemmas disabled: {error}", file=sys.stderr, flush=True)
    return _MORPH


def add_lemmas(words: list[dict]) -> None:
    morph = morph_analyzer()
    if morph is None:
        return
    cache: dict[str, str | None] = {}
    for word in words:
        key = word["raw"].lower()
        if key not in cache:
            try:
                parse = morph.parse(key)[0]
                cache[key] = parse.normal_form if parse.is_known else None
            except Exception:
                cache[key] = None
        if cache[key]:
            word["lemma"] = cache[key]


SEAM_MARGIN_S = 0.30


def keep_words_in_range(words: list[dict], keep_from: float, keep_to: float) -> list[dict]:
    """Соседние куски длинной речи нарезаются с нахлёстом, чтобы слово на
    стыке целиком попало хотя бы в один. Слово остаётся за тем куском, в чьей
    зоне ответственности лежит его середина. У стыка таймкоды одного слова в
    двух кусках расходятся на десятки миллисекунд, и строгая граница могла
    отбросить его в обоих. Поэтому зона расширена на SEAM_MARGIN_S, слова из
    расширения помечаются, а дубли снимает `resolve_seam_duplicates`."""
    kept = []
    for word in words:
        center = (word["start"] + word["end"]) * 0.5
        if keep_from - SEAM_MARGIN_S <= center < keep_to + SEAM_MARGIN_S:
            word = dict(word)
            word["_seam"] = not (keep_from <= center < keep_to)
            kept.append(word)
    return kept


def resolve_seam_duplicates(words: list[dict]) -> list[dict]:
    """Слово у стыка могло прийти из обоих кусков. Пара пересекающихся
    больше чем на половину более короткого слова, где хотя бы одно взято из
    расширения зоны, — дубль: остаётся слово из своей зоны (а при равенстве —
    более уверенное)."""
    words = sorted(words, key=lambda word: word["start"])
    result: list[dict] = []
    for word in words:
        duplicate_of = None
        for index in range(len(result) - 1, max(-1, len(result) - 6), -1):
            other = result[index]
            if not (word.get("_seam") or other.get("_seam")):
                continue
            overlap = min(word["end"], other["end"]) - max(word["start"], other["start"])
            shorter = min(word["end"] - word["start"], other["end"] - other["start"])
            if shorter > 0 and overlap > 0.5 * shorter:
                duplicate_of = index
                break
        if duplicate_of is None:
            result.append(word)
            continue
        other = result[duplicate_of]
        word_rank = (not word.get("_seam"), word.get("confidence", 0.0))
        other_rank = (not other.get("_seam"), other.get("confidence", 0.0))
        if word_rank > other_rank:
            result[duplicate_of] = word
    for word in result:
        word.pop("_seam", None)
    return result


# --- CTC-перепроверка кандидатов ----------------------------------------------
# Вторая модель (GigaAM v3 CTC) распознаёт окно ~2–3 с вокруг слова, которое
# RNN-T счёл матом с невысокой уверенностью. Rust решает по её словам: мат
# подтверждён — мутится даже тихий, не подтверждён — сомнительный токен
# отбрасывается. Признаки — те же, что у GigaAM: лог-мел 64, окно 320, шаг 160.
CTC_FRAME_S = 0.04
CTC_VOCAB = [" "] + list("абвгдежзийклмнопрстуфхцчшщъыьэюя")
CTC_BLANK = len(CTC_VOCAB)
_CTC_SESSIONS: dict = {}
_MEL = None


def mel_filterbank():
    global _MEL
    if _MEL is None:
        import numpy as np

        def hz_to_mel(freq):
            return 2595.0 * np.log10(1.0 + freq / 700.0)

        def mel_to_hz(mel):
            return 700.0 * (10.0 ** (mel / 2595.0) - 1.0)

        freqs = np.linspace(0, SAMPLE_RATE / 2, 320 // 2 + 1)
        edges = mel_to_hz(np.linspace(hz_to_mel(0.0), hz_to_mel(8000.0), 64 + 2))
        widths = np.diff(edges)
        slopes = edges[None, :] - freqs[:, None]
        down = -slopes[:, :-2] / widths[:-1]
        up = slopes[:, 2:] / widths[1:]
        bank = np.maximum(0, np.minimum(down, up)).astype(np.float32)
        window = (0.5 - 0.5 * np.cos(2 * np.pi * np.arange(320) / 320)).astype(np.float32)
        _MEL = (bank, window)
    return _MEL


def ctc_features(audio):
    import numpy as np

    bank, window = mel_filterbank()
    frames = 1 + (len(audio) - 320) // 160
    index = np.arange(320)[None, :] + 160 * np.arange(frames)[:, None]
    power = np.abs(np.fft.rfft(audio[index] * window, n=320)) ** 2
    return np.log(np.clip(power @ bank, 1e-9, 1e9)).astype(np.float32)


def ctc_session(model_dir: Path, threads: int):
    key = (str(model_dir), threads)
    if key not in _CTC_SESSIONS:
        import onnxruntime

        options = onnxruntime.SessionOptions()
        if threads:
            options.intra_op_num_threads = threads
        _CTC_SESSIONS[key] = onnxruntime.InferenceSession(
            str(model_dir / "model.int8.onnx"), options, providers=["CPUExecutionProvider"]
        )
    return _CTC_SESSIONS[key]


def ctc_words(session, audio, base_time: float) -> list[dict]:
    """Жадное декодирование CTC и слова с границами по кадрам."""
    import numpy as np

    if len(audio) < 3200:
        return []
    features = ctc_features(audio).T[None]
    names = [node.name for node in session.get_inputs()]
    logprobs = session.run(
        None, {names[0]: features, names[1]: np.array([features.shape[2]], np.int64)}
    )[0][0]
    ids = logprobs.argmax(1)
    words: list[dict] = []
    chars: list[str] = []
    frames: list[int] = []
    previous = -1

    def flush():
        if chars:
            words.append(
                {
                    "raw": "".join(chars),
                    "start": base_time + frames[0] * CTC_FRAME_S,
                    "end": base_time + (frames[-1] + 1) * CTC_FRAME_S,
                }
            )
        chars.clear()
        frames.clear()

    for frame, token in enumerate(ids):
        token = int(token)
        if token != CTC_BLANK and token != previous:
            if token == 0:
                flush()
            else:
                chars.append(CTC_VOCAB[token])
                frames.append(frame)
        previous = token
    flush()
    return words


def verify_windows(model_dir: Path, windows_path: Path, threads: int, progress) -> dict:
    windows = json.loads(windows_path.read_text(encoding="utf-8"))
    session = ctc_session(model_dir, threads)
    opened: dict[str, Pcm16Samples] = {}
    results = []
    for index, window in enumerate(windows):
        wav = window["wav"]
        if wav not in opened:
            opened[wav] = read_pcm16_mono(Path(wav))
        samples = opened[wav]
        start = max(0, min(len(samples), int(window["start_sample"])))
        end = max(start, min(len(samples), int(window["end_sample"])))
        base = float(window.get("base_time", start / SAMPLE_RATE))
        results.append(
            {"id": window["id"], "words": ctc_words(session, samples[start:end], base)}
        )
        progress(f"FETCHR_PROGRESS|{index + 1}|{len(windows)}")
    return {"backend": "gigaam-v3-ctc", "windows": results}


def get_recognizer(model_dir: Path, backend: str, threads: int):
    """Кэш загруженных моделей: в serve-режиме модель не перезагружается
    между задачами (экономия 3-5 с на каждом файле очереди).

    Метод декодирования фиксируется при создании сессий, поэтому входит в ключ
    кэша: бустинг словаря живёт только в modified_beam_search."""
    import sherpa_onnx

    paths = beam_paths()
    method = "greedy_search" if paths <= 1 else "modified_beam_search"
    key = (str(model_dir), backend, threads, method)
    if key in _RECOGNIZERS:
        return _RECOGNIZERS[key], method

    spec = prepare_model(model_dir, backend)
    provider = provider_argument()
    recognizer = sherpa_onnx.OfflineRecognizer.from_transducer(
        encoder=str(model_dir / spec["encoder"]),
        decoder=str(model_dir / spec["decoder"]),
        joiner=str(model_dir / spec["joiner"]),
        tokens=str(model_dir / spec["tokens"]),
        # Гибридные CPU (P+E ядра): пул на ВСЕ логические потоки в 3-4 раза
        # медленнее, чем пул по P-ядрам (замерено на i5-13500H).
        num_threads=threads,
        model_type=spec["model_type"],
        decoding_method=method,
        max_active_paths=paths,
        # Посимвольный словарь GigaAM: "cjkchar" режет фразу на UTF-8 символы
        # без всякой BPE — это ровно те токены, что лежат в tokens.txt.
        modeling_unit="cjkchar",
        hotwords_score=hotwords_score(),
        provider=provider,
    )
    _RECOGNIZERS[key] = recognizer
    return recognizer, method


def transcribe(
    model_dir: Path,
    wav_path: Path,
    segments_path: Path,
    backend: str,
    threads: int,
    vad: VadFilter | None = None,
    progress=None,
    batch_size: int = ASR_BATCH_SIZE,
    hotwords_path: Path | None = None,
) -> dict:
    if progress is None:
        def progress(message: str) -> None:
            print(message, file=sys.stderr, flush=True)

    samples = read_pcm16_mono(wav_path)
    segments = json.loads(segments_path.read_text(encoding="utf-8"))
    recognizer, method = get_recognizer(model_dir, backend, threads)
    hotword_list = read_hotwords(hotwords_path) if method != "greedy_search" else []
    hotwords = "/".join(hotword_list)
    prefixes, longest_hotword = build_hotword_prefixes(hotword_list)
    boosted = len(hotword_list)
    boost = hotwords_score() if boosted else 0.0
    progress(f"FETCHR_HOTWORDS|{boosted}|score={boost:.2f}|{method}")

    # VAD-отсев: сегменты без речи не попадают в ASR вообще.
    kept_segments = []
    dropped = 0
    for segment in segments:
        start_sample = max(0, min(len(samples), int(segment["start_sample"])))
        end_sample = max(start_sample, min(len(samples), int(segment["end_sample"])))
        if (
            vad is not None
            and end_sample - start_sample >= VAD_WINDOW
            and not vad.has_speech(samples[start_sample:end_sample])
        ):
            dropped += 1
            continue
        keep_from = int(segment.get("keep_start_sample", start_sample))
        keep_to = int(segment.get("keep_end_sample", end_sample))
        kept_segments.append((start_sample, end_sample, keep_from, keep_to))
    # Итог VAD пишется и в постоянный лог сервера: раньше он уходил только в
    # per-task файл, который удаляется сразу после задачи, и проверить, что
    # фильтр вообще что-то отбрасывает, было негде.
    fed = sum(segment[1] - segment[0] for segment in kept_segments) / SAMPLE_RATE
    summary = (
        f"FETCHR_VAD|dropped={dropped}|kept={len(kept_segments)}"
        f"|asr_audio_s={fed:.1f}|wav_s={len(samples) / SAMPLE_RATE:.1f}"
    )
    progress(summary)
    print(summary, file=sys.stderr, flush=True)

    # Батч паддится до самого длинного сегмента в нём, а длина сегментов гуляет
    # от долей секунды до 12 с: в случайном батче половина вычислений уходит в
    # паддинг. Сортировка по длине собирает батчи из близких по длине сегментов.
    # Порядок восстанавливать не нужно: время каждого слова абсолютное
    # (base_time сегмента), а Rust всё равно сортирует слова по start
    # (deduplicate_words).
    kept_segments.sort(key=lambda segment: segment[1] - segment[0])

    words: list[dict] = []
    total_segments = len(kept_segments)
    batch_size = max(1, batch_size)
    for batch_start in range(0, total_segments, batch_size):
        batch_segments = kept_segments[batch_start : batch_start + batch_size]
        waveforms = []
        timings = []
        for start_sample, end_sample, keep_from, keep_to in batch_segments:
            if end_sample - start_sample >= 320:
                waveforms.append(samples[start_sample:end_sample])
                timings.append(
                    (
                        start_sample / SAMPLE_RATE,
                        (end_sample - start_sample) / SAMPLE_RATE,
                        keep_from / SAMPLE_RATE,
                        keep_to / SAMPLE_RATE,
                    )
                )

        if waveforms:
            results = recognize_batch(recognizer, waveforms, hotwords)
            for result, (base_time, duration, keep_from, keep_to) in zip(
                results, timings, strict=True
            ):
                words.extend(
                    keep_words_in_range(
                        timestamped_result_to_words(
                            result, base_time, duration, boost, prefixes, longest_hotword
                        ),
                        keep_from,
                        keep_to,
                    )
                )

        completed = min(batch_start + len(batch_segments), total_segments)
        progress(f"FETCHR_PROGRESS|{completed}|{total_segments}")

    words = resolve_seam_duplicates(words)
    add_lemmas(words)
    return {
        "backend": f"sherpa-onnx:{backend}:{method}:hotwords={boosted}",
        "words": words,
    }


def pin_to_performance_cores(threads: int, requested_mask: str = "") -> str:
    """Гибридные CPU Intel (P+E): opt-out из EcoQoS запрещает троттлинг, но не
    запрещает планировщику разложить потоки ONNX по E-ядрам. Маска фиксирует
    процесс на первых `threads` логических процессорах — на Alder/Raptor Lake
    Windows нумерует P-ядра раньше E-ядер.

    `requested_mask` приходит от калибровки (`--affinity`): "off" отключает пин,
    шестнадцатеричное значение задаёт маску явно. `FETCHR_ASR_AFFINITY`
    перекрывает и то и другое — это ручной аварийный рычаг."""
    setting = os.environ.get("FETCHR_ASR_AFFINITY", "").strip().lower()
    if not setting:
        setting = (requested_mask or "").strip().lower()
    if setting in ("off", "0", "no"):
        return "off"
    if sys.platform != "win32" or threads <= 0:
        return "skip"
    logical = os.cpu_count() or 0
    if logical <= threads and not setting:
        # Однородный CPU или потоков ровно по числу ядер: пин ничего не даёт.
        return "skip"
    try:
        import ctypes

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.GetCurrentProcess.restype = ctypes.c_void_p
        kernel32.GetProcessAffinityMask.argtypes = [
            ctypes.c_void_p,
            ctypes.POINTER(ctypes.c_size_t),
            ctypes.POINTER(ctypes.c_size_t),
        ]
        kernel32.SetProcessAffinityMask.argtypes = [ctypes.c_void_p, ctypes.c_size_t]
        handle = kernel32.GetCurrentProcess()
        allowed = ctypes.c_size_t(0)
        system = ctypes.c_size_t(0)
        if not kernel32.GetProcessAffinityMask(
            handle, ctypes.byref(allowed), ctypes.byref(system)
        ):
            return "unavailable"
        requested = int(setting, 16) if setting.startswith("0x") else (1 << threads) - 1
        mask = requested & allowed.value
        if mask == 0 or mask == allowed.value:
            # Пустое пересечение или маска шире текущей — оставляем как есть.
            return "skip"
        if not kernel32.SetProcessAffinityMask(handle, mask):
            return "unavailable"
        return hex(mask)
    except Exception:
        return "unavailable"


def load_vad(vad_model: Path | None) -> VadFilter | None:
    if vad_model is None or not vad_filter_enabled() or not vad_model.is_file():
        return None
    return VadFilter(vad_model)


def benchmark(
    model_dir: Path,
    wav_path: Path,
    backend: str,
    threads: int,
    affinity: str,
    batch_size: int,
    seconds: float,
    segment_seconds: float,
) -> None:
    """Один замер одной конфигурации. Отдельный процесс на конфигурацию —
    обязателен: и `intra_op_num_threads`, и маска аффинности фиксируются в
    момент создания сессии, менять их потом бессмысленно."""
    import numpy as np

    applied = pin_to_performance_cores(threads, affinity)
    samples = read_pcm16_mono(wav_path)
    limit = int(seconds * SAMPLE_RATE)
    if limit and len(samples) > limit:
        samples = samples[:limit]
    recognizer, _ = get_recognizer(model_dir, backend, threads)

    step = max(1, int(segment_seconds * SAMPLE_RATE))
    chunks = [samples[start : start + step] for start in range(0, len(samples), step)]
    chunks = [chunk for chunk in chunks if len(chunk) >= 320]
    if not chunks:
        raise RuntimeError("benchmark needs at least 0.02s of audio")
    chunks.sort(key=len)

    recognize_batch(recognizer, chunks[:1], "")  # прогрев
    import time

    started = time.perf_counter()
    for index in range(0, len(chunks), max(1, batch_size)):
        recognize_batch(recognizer, chunks[index : index + batch_size], "")
    elapsed = time.perf_counter() - started
    audio_s = sum(len(chunk) for chunk in chunks) / SAMPLE_RATE
    print(
        f"FETCHR_BENCH|threads={threads}|affinity={applied}|batch={batch_size}"
        f"|audio_s={audio_s:.2f}|rtf={elapsed / max(audio_s, 1e-6):.5f}",
        flush=True,
    )


def serve(threads: int, vad_model: Path | None, affinity: str, batch_size: int) -> None:
    """Постоянный ASR-процесс: задачи приходят JSON-строками в stdin
    {"id","model_dir","backend","wav","segments","result","log","hotwords"};
    модель загружается один раз и переиспользуется между файлами очереди."""
    applied_affinity = pin_to_performance_cores(threads, affinity)
    vad = load_vad(vad_model)
    print(
        f"FETCHR_SERVER_READY threads={threads or 'default'} "
        f"vad={'on' if vad else 'off'} affinity={applied_affinity} batch={batch_size}",
        file=sys.stderr,
        flush=True,
    )
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            task = json.loads(line)
        except json.JSONDecodeError:
            continue
        log_path = Path(task["log"])

        def logp(message: str) -> None:
            with open(log_path, "a", encoding="utf-8") as handle:
                handle.write(message + "\n")

        try:
            if task.get("kind") == "verify":
                output = verify_windows(
                    Path(task["model_dir"]), Path(task["windows"]), threads, logp
                )
                Path(task["result"]).write_text(
                    json.dumps(output, ensure_ascii=False, separators=(",", ":")),
                    encoding="utf-8",
                )
                logp(f"FETCHR_DONE|{task['id']}")
                continue
            output = transcribe(
                Path(task["model_dir"]),
                Path(task["wav"]),
                Path(task["segments"]),
                task["backend"],
                threads,
                vad=vad,
                progress=logp,
                batch_size=int(task.get("batch") or batch_size),
                hotwords_path=Path(task["hotwords"]) if task.get("hotwords") else None,
            )
            Path(task["result"]).write_text(
                json.dumps(output, ensure_ascii=False, separators=(",", ":")),
                encoding="utf-8",
            )
            logp(f"FETCHR_DONE|{task['id']}")
        except Exception as error:
            try:
                logp(f"FETCHR_ERROR|{task['id']}|{error}")
            except Exception:
                pass


def self_test() -> None:
    assert (sys.stdin.encoding or "").lower().replace("-", "") == "utf8"

    # The missing-space recovery is important for profanity matching. This
    # mirrors an observed Standard-model output for "хуй вон".
    result = SimpleNamespace(
        text="хуйван",
        tokens=list("хуйван"),
        timestamps=[0.52, 0.56, 0.60, 0.84, 0.88, 0.92],
        logprobs=[-0.01] * 6,
    )
    words = timestamped_result_to_words(result, 10.0, 1.2)
    assert [word["raw"] for word in words] == ["хуй", "ван"], words
    assert words[0]["end"] < words[1]["start"]

    spaced = SimpleNamespace(
        text="fuck this",
        tokens=list("fuck this"),
        timestamps=[index * 0.04 for index in range(9)],
        logprobs=[-0.05] * 9,
    )
    words = timestamped_result_to_words(spaced, 0.0, 0.6)
    assert [word["raw"] for word in words] == ["fuck", "this"], words

    # Список бустинга: комментарии и пустые строки не должны попасть в граф
    # контекста, разделитель фраз у sherpa — "/".
    with tempfile.TemporaryDirectory() as directory:
        hotwords_file = Path(directory) / "hotwords.txt"
        hotwords_file.write_text("хуй\n\n# комментарий\nпизда\n", encoding="utf-8")
        assert read_hotwords(hotwords_file) == ["хуй", "пизда"]
        assert read_hotwords(Path(directory) / "missing.txt") == []
    assert read_hotwords(None) == []

    # Бустинг sherpa прибавляет к лог-вероятности токена и кладёт результат в
    # ys_log_probs. Без вычитания слово из словаря всегда приходит уверенным на
    # единицу, пороги фильтрации слепнут и мут ловит чистую речь.
    prefixes, longest = build_hotword_prefixes(["хуй", "пизда"])
    assert {"х", "ху", "хуй", "п", "пизда"} <= prefixes
    assert longest == 5
    # Совпадение начинается где угодно, в том числе в середине слова.
    assert token_was_boosted(list("картинкух"), prefixes, longest)
    assert not token_was_boosted(list("картинк"), prefixes, longest)

    boosted_word = SimpleNamespace(
        text="хуй",
        tokens=list("хуй"),
        timestamps=[0.40, 0.44, 0.48],
        logprobs=[1.0, 1.0, 1.0],
    )
    assert timestamped_result_to_words(boosted_word, 0.0, 1.0)[0]["confidence"] == 1.0
    corrected = timestamped_result_to_words(
        boosted_word, 0.0, 1.0, 1.2, prefixes, longest
    )
    assert abs(corrected[0]["confidence"] - math.exp(-0.2)) < 1e-6
    # Слова вне словаря не бустились — вычитать из них нечего.
    untouched = timestamped_result_to_words(
        boosted_word, 0.0, 1.0, 1.2, *build_hotword_prefixes(["мат"])
    )
    assert untouched[0]["confidence"] == 1.0

    # Бустинг живёт только в modified_beam_search, поэтому его отключение —
    # это возврат к greedy.
    os.environ.pop("FETCHR_ASR_BEAM", None)
    assert beam_paths() == 1
    os.environ["FETCHR_ASR_BEAM"] = "on"
    assert beam_paths() == BEAM_ENABLED_PATHS
    os.environ["FETCHR_ASR_BEAM"] = "off"
    assert beam_paths() == 1
    os.environ["FETCHR_ASR_BEAM"] = "8"
    assert beam_paths() == 8
    os.environ.pop("FETCHR_ASR_BEAM")
    os.environ["FETCHR_ASR_HOTWORDS_SCORE"] = "2.0"
    assert hotwords_score() == 2.0
    # Потолок обязателен: на 4.0 замер дал «нахуй нахуй чьих не требуя похуй»
    # вместо чистой речи, то есть глушение всего подряд.
    os.environ["FETCHR_ASR_HOTWORDS_SCORE"] = "9"
    assert hotwords_score() == HOTWORDS_MAX_SCORE
    os.environ["FETCHR_ASR_HOTWORDS_SCORE"] = "мусор"
    assert hotwords_score() == HOTWORDS_DEFAULT_SCORE
    os.environ.pop("FETCHR_ASR_HOTWORDS_SCORE")

    # Пустой ys_log_probs не должен ронять задачу: без него уверенность просто
    # максимальная, а слова и их границы остаются на месте.
    adapted = adapt_result(
        SimpleNamespace(text="мат", tokens=list("мат"), timestamps=[0.1, 0.2, 0.3], ys_log_probs=[])
    )
    assert adapted.logprobs == [0.0, 0.0, 0.0]
    assert [word["raw"] for word in timestamped_result_to_words(adapted, 0.0, 1.0)] == ["мат"]

    # Нахлёст кусков: слово остаётся за тем куском, где лежит его середина.
    overlap_words = [
        {"raw": "а", "start": 9.0, "end": 9.4},
        {"raw": "б", "start": 9.9, "end": 10.3},
    ]
    first = keep_words_in_range(overlap_words, 0.0, 10.0)
    second = keep_words_in_range(overlap_words, 10.0, 20.0)
    merged = resolve_seam_duplicates(first + second)
    assert [w["raw"] for w in merged] == ["а", "б"], merged
    assert all("_seam" not in w for w in merged)
    # Одно слово у стыка: в куске A центр чуть после стыка, в B — чуть до.
    # Строгая граница выбросила бы его в обоих; теперь остаётся ровно одно.
    seam_a = keep_words_in_range([{"raw": "мат", "start": 9.82, "end": 10.22, "confidence": 0.9}], 0.0, 10.0)
    seam_b = keep_words_in_range([{"raw": "мат", "start": 9.75, "end": 10.19, "confidence": 0.8}], 10.0, 20.0)
    assert [w["raw"] for w in resolve_seam_duplicates(seam_a + seam_b)] == ["мат"]

    # Признаки CTC: 20 мс окно, 10 мс шаг, 64 мел-полосы.
    import numpy as np

    assert ctc_features(np.zeros(16000, np.float32)).shape == (99, 64)

    # Пин на P-ядра не обязан сработать, но обязан не бросить исключение:
    # он выполняется до загрузки модели и уронил бы весь ASR-сервер.
    assert isinstance(pin_to_performance_cores(8), str)
    assert pin_to_performance_cores(0) == "skip"
    # Маска из калибровки и аварийное переопределение через окружение.
    assert pin_to_performance_cores(8, "off") == "off"
    os.environ["FETCHR_ASR_AFFINITY"] = "off"
    assert pin_to_performance_cores(8, "0xff") == "off"
    os.environ.pop("FETCHR_ASR_AFFINITY")

    # Silero VAD включён, пока его не выключили явно.
    os.environ.pop("FETCHR_ASR_VAD", None)
    assert vad_filter_enabled()
    os.environ["FETCHR_ASR_VAD"] = "on"
    assert vad_filter_enabled()
    os.environ["FETCHR_ASR_VAD"] = "off"
    assert not vad_filter_enabled()
    os.environ.pop("FETCHR_ASR_VAD")

    # Busy-wait пулов выключен по умолчанию: со включённым RTF втрое хуже.
    os.environ.pop("FETCHR_ASR_SPINNING", None)
    assert not spinning_enabled()
    os.environ["FETCHR_ASR_SPINNING"] = "on"
    assert spinning_enabled()
    os.environ.pop("FETCHR_ASR_SPINNING")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-dir", type=Path)
    parser.add_argument("--wav", type=Path)
    parser.add_argument("--segments", type=Path)
    parser.add_argument("--language", choices=("ru-RU", "en-US"), default="ru-RU")
    parser.add_argument("--backend", choices=tuple(MODELS))
    parser.add_argument(
        "--threads",
        type=int,
        default=0,
        help="ONNX intra-op threads (0 = library default)",
    )
    parser.add_argument(
        "--vad-model",
        type=Path,
        default=None,
        help="Silero VAD ONNX path; missing file disables the VAD filter",
    )
    parser.add_argument(
        "--serve",
        action="store_true",
        help="Persistent server mode: JSON tasks via stdin, model stays loaded",
    )
    parser.add_argument(
        "--affinity",
        default="",
        help='Process affinity: "off" or a hex mask; empty = legacy auto-pin',
    )
    parser.add_argument(
        "--batch",
        type=int,
        default=ASR_BATCH_SIZE,
        help="Segments per recognizer call",
    )
    parser.add_argument(
        "--benchmark",
        action="store_true",
        help="Measure RTF for this configuration and exit (one process per config)",
    )
    parser.add_argument(
        "--seconds",
        type=float,
        default=10.0,
        help="Benchmark: how much leading audio to measure",
    )
    parser.add_argument(
        "--segment-seconds",
        type=float,
        default=12.0,
        help="Benchmark: chunk length fed to the recognizer",
    )
    parser.add_argument(
        "--hotwords",
        type=Path,
        default=None,
        help="Word list (one per line) boosted during decoding",
    )
    parser.add_argument("--self-test", action="store_true")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if args.self_test:
        self_test()
        return
    if args.benchmark:
        if not all((args.model_dir, args.wav, args.backend)):
            raise SystemExit("--model-dir, --wav and --backend are required")
        benchmark(
            args.model_dir,
            args.wav,
            args.backend,
            args.threads,
            args.affinity,
            args.batch,
            args.seconds,
            args.segment_seconds,
        )
        return
    if args.serve:
        serve(args.threads, args.vad_model, args.affinity, args.batch)
        return
    if not all((args.model_dir, args.wav, args.segments, args.backend)):
        raise SystemExit("--model-dir, --wav, --segments and --backend are required")
    print(
        f"Starting {args.backend}; selected language={args.language}, threads={args.threads or 'default'}",
        file=sys.stderr,
    )
    output = transcribe(
        args.model_dir,
        args.wav,
        args.segments,
        args.backend,
        args.threads,
        vad=load_vad(args.vad_model),
        batch_size=args.batch,
        hotwords_path=args.hotwords,
    )
    json.dump(output, sys.stdout, ensure_ascii=False, separators=(",", ":"))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"GigaAM v3 ONNX runner failed: {error}", file=sys.stderr)
        raise
