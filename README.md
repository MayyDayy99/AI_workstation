# EDTI Studio — AI Workstation (statikus portfólió-demó)

**🇭🇺** Ez az egyetemi oktatóvideó-feldolgozó platformom (**EDTI Studio**) teljes
frontendjének **statikus, bebarangolható demója**. Az igazi rendszer egy
FastAPI + GPU backendre épül (Whisper ASR, NLLB fordítás, XTTS-v2 hangklónozás,
Demucs, ffmpeg); itt **minden API-hívást egy böngészőbeli mock-motor játszik
el** — a feltöltések, a feldolgozási fázisok, a százalékok és a
szerverterhelés-grafikonok élnek és mozognak, de valódi munka nem történik.

**🇬🇧** A fully static, browsable demo of my university lecture-video processing
platform (**EDTI Studio**). The real system runs on a FastAPI + GPU backend
(Whisper ASR, NLLB translation, XTTS-v2 voice cloning, Demucs, ffmpeg); here
**every API call is played by an in-browser mock engine** — uploads, pipeline
stages, progress bars and server-load graphs all move, but no real work
happens.

## Mit tud az igazi rendszer? / What the real system does

| Modul | Leírás |
|---|---|
| 🎬 **Szinkron** | Magyar előadásvideó → angol szinkron (ASR → fordítás → hangklónozott TTS → időzítés → keverés) |
| 💬 **Felirat** | Kétnyelvű feliratfájlok (SRT/VTT) generálása |
| 📝 **Leirat** | Videóból tisztított magyar leirat |
| 🗣️ **PPT narráció** | PPTX-jegyzetek felolvasása a saját klónozott hanggal, diánkénti videó + YouTube-fejezetek |
| 📊 **PPT csere** | Videóban rögzített diák lecserélése éles PPT-exportra |
| 🎞️ **Intro/Outro** | Egységes nyitó-/záróképsorok |
| 🧩 **Flow builder** | Feldolgozási lépések vizuális láncolása |
| 📦 **Batch** | Tömeges feldolgozás sorbaállítással, prioritásokkal |

## A demó használata / Using the demo

1. Nyisd meg a GitHub Pages oldalt (vagy lokálisan: bármilyen statikus
   szerverrel a repó gyökeréből, pl. `python -m http.server`).
2. A belépő oldalon **bármilyen** felhasználónév/jelszó jó.
3. Tölts fel bármilyen fájlt bármelyik modulban — a "feldolgozás" magától
   végigfut, a letöltés-gombok kis minta-fájlokat adnak.
4. A jobb alsó sarokban lévő szalag emlékeztet: **minden adat szimulált**.

## Architektúra (demó)

- `mock_core.js` — fetch/XHR/EventSource elfogás, idő-alapú determinisztikus
  job-szimulátor, szerverterhelés-hullámok, demo-session
- `mock_routes_*.js` — az egyes modulok API-kontraktusának mockjai
- `api/…` — valódi statikus fájlok a médiának (előnézet, letöltések), mert
  a `<video>`/`<a download>` navigációkat nem lehet JS-ből elfogni

> Az éles rendszer forráskódja külön, privát repóban él. Ez a demó kizárólag
> a felhasználói felület bemutatására szolgál.
