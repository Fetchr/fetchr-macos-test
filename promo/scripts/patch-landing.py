"""Вставляет секцию с промо-роликом в лендинг fetchr.fun.

    python promo/scripts/patch-landing.py <index.html> <out.html> [version]

Секция встаёт между героем и «Возможностями», стили — в конец общего
<style>, переводы — во все языки таблицы i18nData, автозапуск — отдельным
скриптом в конце <body>. Повторный запуск на уже изменённой странице
ничего не ломает: он просто отказывается работать.
"""
import re
import sys

src, dst = sys.argv[1], sys.argv[2]
version = sys.argv[3] if len(sys.argv) > 3 else "1"

html = open(src, encoding="utf-8").read()
if 'id="promo"' in html:
    sys.exit("promo section is already present")

ASSET = "/assets/video"

SECTION = f"""    <section id="promo" aria-label="Промо-ролик Fetchr">
      <div class="container">
        <div class="section-head reveal">
          <div>
            <span class="label" data-i18n="section-promo-label">Видео</span>
            <h2 data-i18n="section-promo-title">Fetchr <span class="wide-accent">за минуту</span></h2>
          </div>
          <p class="section-copy" data-i18n="section-promo-desc">Очередь загрузок, запись эфиров, поиск удалённых VOD, рендер чата, блюр спонсоров, чистка мата и музыки — весь пайплайн Fetchr в одном ролике.</p>
        </div>
        <div class="promo-player reveal">
          <video class="promo-video" id="promoVideo" poster="{ASSET}/fetchr-promo-poster.jpg?v={version}" muted loop playsinline controls preload="metadata" width="1920" height="1080">
            <source src="{ASSET}/fetchr-promo.webm?v={version}" type="video/webm">
            <source src="{ASSET}/fetchr-promo.mp4?v={version}" type="video/mp4">
          </video>
        </div>
      </div>
    </section>

"""

CSS = """
    /* ── Промо-ролик ─────────────────────────────────────────────── */
    #promo {
      padding-top: 24px;
    }

    .promo-player {
      position: relative;
      overflow: hidden;
      aspect-ratio: 16 / 9;
      border: 1px solid var(--line-strong);
      border-radius: 18px;
      background: #07080a;
      box-shadow:
        0 40px 120px -40px rgba(0, 0, 0, 0.9),
        0 24px 90px -48px rgba(61, 125, 255, 0.45);
    }

    .promo-video {
      display: block;
      width: 100%;
      height: 100%;
      background: #07080a;
      object-fit: cover;
    }
  </style>"""

SCRIPT = """  <script>
    // Промо-ролик играет, только пока виден: без звука, по кругу. При
    // «уменьшить движение» сам не стартует — остаётся постер и кнопка.
    (() => {
      const video = document.getElementById("promoVideo");
      if (!video) return;
      const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (reduce || !("IntersectionObserver" in window)) return;
      const observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting) video.play().catch(() => {});
            else video.pause();
          }
        },
        { threshold: 0.35 },
      );
      observer.observe(video);
    })();
  </script>
</body>"""

T = {
    "en": ("Video", 'Fetchr <span class=\\"wide-accent\\">in one minute</span>',
           "Download queue, live recording, recovering deleted VODs, chat rendering, sponsor blur, profanity and music cleanup — the whole Fetchr pipeline in one video. On-screen text is in Russian."),
    "ru": ("Видео", 'Fetchr <span class=\\"wide-accent\\">за минуту</span>',
           "Очередь загрузок, запись эфиров, поиск удалённых VOD, рендер чата, блюр спонсоров, чистка мата и музыки — весь пайплайн Fetchr в одном ролике."),
    "es": ("Vídeo", 'Fetchr <span class=\\"wide-accent\\">en un minuto</span>',
           "Cola de descargas, grabación de directos, recuperación de VOD borrados, render del chat, desenfoque de patrocinios y limpieza de insultos y música: todo el pipeline de Fetchr en un vídeo. Textos en ruso."),
    "fr": ("Vidéo", 'Fetchr <span class=\\"wide-accent\\">en une minute</span>',
           "File de téléchargements, enregistrement des lives, récupération des VOD supprimées, rendu du chat, floutage des sponsors, nettoyage des insultes et de la musique : tout le pipeline Fetchr en une vidéo. Textes en russe."),
    "it": ("Video", 'Fetchr <span class=\\"wide-accent\\">in un minuto</span>',
           "Coda di download, registrazione delle dirette, recupero dei VOD eliminati, render della chat, sfocatura degli sponsor, pulizia di parolacce e musica: tutta la pipeline di Fetchr in un video. Testi in russo."),
    "de": ("Video", 'Fetchr <span class=\\"wide-accent\\">in einer Minute</span>',
           "Download-Warteschlange, Stream-Aufnahme, gelöschte VODs wiederherstellen, Chat-Rendering, Sponsor-Blur, Schimpfwörter und Musik entfernen – die ganze Fetchr-Pipeline in einem Video. Texte auf Russisch."),
    "tr": ("Video", '<span class=\\"wide-accent\\">Bir dakikada</span> Fetchr',
           "İndirme kuyruğu, yayın kaydı, silinen VOD'ları kurtarma, sohbet render'ı, sponsor bulanıklaştırma, küfür ve müzik temizliği — Fetchr'ın tüm akışı tek videoda. Metinler Rusça."),
    "pt": ("Vídeo", 'Fetchr <span class=\\"wide-accent\\">em um minuto</span>',
           "Fila de downloads, gravação de lives, recuperação de VODs apagados, render do chat, desfoque de patrocínios e limpeza de palavrões e música — todo o pipeline do Fetchr em um vídeo. Textos em russo."),
    "ja": ("動画", '<span class=\\"wide-accent\\">1分でわかる</span> Fetchr',
           "ダウンロードキュー、配信録画、削除されたVODの復元、チャットのレンダリング、スポンサーのぼかし、放送禁止用語と音楽の除去 — Fetchrのパイプライン全体を1本の動画で。画面の文字はロシア語です。"),
    "zh": ("视频", '<span class=\\"wide-accent\\">一分钟</span>了解 Fetchr',
           "下载队列、直播录制、找回已删除的 VOD、聊天渲染、赞助模糊、脏话与音乐清理——一段视频看完 Fetchr 的完整流程。画面文字为俄语。"),
    "tw": ("影片", '<span class=\\"wide-accent\\">一分鐘</span>認識 Fetchr',
           "下載佇列、直播錄影、找回已刪除的 VOD、聊天渲染、贊助模糊、髒話與音樂清理——一支影片看完 Fetchr 的完整流程。畫面文字為俄語。"),
}

# 1. Секция перед «Возможностями»
anchor = '    <section id="projects">'
if html.count(anchor) != 1:
    sys.exit("features section anchor not found exactly once")
html = html.replace(anchor, SECTION + anchor)

# 2. Стили в конец общего <style>
if html.count("</style>") != 1:
    sys.exit("expected exactly one </style>")
html = html.replace("\n  </style>", CSS, 1) if "\n  </style>" in html else html.replace("</style>", CSS.strip() + "\n", 1)

# 3. Переводы: после section-features-desc в каждом языке
start = html.index("const i18nData = {")
stop = html.index("const i18nPhrases")
table = html[start:stop]
langs = list(re.finditer(r'\n  "([a-zA-Z-]+)": \{', table))
patched = table
for index in reversed(range(len(langs))):
    lang = langs[index].group(1)
    begin = langs[index].end()
    finish = langs[index + 1].start() if index + 1 < len(langs) else len(table)
    part = table[begin:finish]
    match = re.search(r'\n    "section-features-desc": "(?:[^"\\]|\\.)*",', part)
    if not match or lang not in T:
        sys.exit(f"cannot place translations for {lang}")
    label, title, desc = T[lang]
    addition = (
        f'\n    "section-promo-label": "{label}",'
        f'\n    "section-promo-title": "{title}",'
        f'\n    "section-promo-desc": "{desc}",'
    )
    insert_at = begin + match.end()
    patched = patched[:insert_at] + addition + patched[insert_at:]
html = html[:start] + patched + html[stop:]

# 4. Автозапуск по видимости
if html.count("</body>") != 1:
    sys.exit("expected exactly one </body>")
html = html.replace("</body>", SCRIPT, 1)

open(dst, "w", encoding="utf-8", newline="").write(html)
print(f"patched: {dst} ({len(html)} bytes)")
