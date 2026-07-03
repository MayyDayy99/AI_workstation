/* ============================================================
 * info_cards.js — ℹ️ gomb minden eszköz-kártya jobb felső sarkában.
 * Kattintásra popup magyarázza el, milyen modell-pipeline dolgozik
 * az adott funkcióban. Önálló modul: saját CSS-t injektál, csak a
 * .tool-card[data-tile-id] elemekre épül (index.html).
 * ============================================================ */
(function () {
    'use strict';

    // ─── Pipeline-leírások kártyánként ──────────────────────────
    // step: [emoji, modell/eszköz, mit csinál — egyszerűen]
    const INFO = {
        dub: {
            icon: '🎙️', title: 'Szinkron — modell-pipeline',
            intro: 'A magyar előadásból angol hangsáv készül, az előadó saját (klónozott) hangján.',
            steps: [
                ['🎞️', 'ffmpeg', 'kiszedi a hangot a videóból'],
                ['🥁', 'Demucs (htdemucs_ft)', 'szétválasztja a beszédet és a háttérzajt/zenét'],
                ['🎧', 'Whisper large-v3', 'a magyar beszédet írott szöveggé alakítja'],
                ['🌍', 'NLLB-200', 'lefordítja angolra — a nevek külön védelmet kapnak'],
                ['🗣️', 'XTTS-v2 hangklón', 'az előadó hangján mondja fel az angol szöveget'],
                ['⏱️', 'Rubberband időillesztés', 'a szinkront a videó tempójához igazítja'],
                ['🎚️', 'ffmpeg keverés', 'visszakeveri az eredeti háttérrel, összerakja a videót'],
            ],
        },
        subtitle: {
            icon: '💬', title: 'Felirat — modell-pipeline',
            intro: 'Kétnyelvű feliratfájlok készülnek a videóból.',
            steps: [
                ['🎧', 'Whisper large-v3', 'beszédfelismerés, szó-szintű időbélyegekkel'],
                ['✂️', 'Mondat-szegmentáló', 'természetes, olvasható felirat-blokkokra bont'],
                ['🌍', 'NLLB-200', 'magyar → angol fordítás'],
                ['📄', 'Cue-építő', 'SRT/VTT export, olvasási sebesség (CPS) korlátokkal'],
            ],
        },
        transcribe: {
            icon: '📝', title: 'Leirat — modell-pipeline',
            intro: 'A videóból tisztított, olvasható magyar leirat készül.',
            steps: [
                ['🎧', 'Whisper large-v3', 'a beszédet írott szöveggé alakítja'],
                ['🪶', 'Racka-4B (magyar LLM)', 'kijavítja az elgépelés-szerű felismerési hibákat'],
                ['📄', 'Export', 'letölthető TXT, SRT és JSON formátumban'],
            ],
        },
        intro_outro: {
            icon: '🎞️', title: 'Intro–Outro — pipeline',
            intro: 'Egységes nyitó- és záróképsor kerül a videókra, magyar és angol változatban.',
            steps: [
                ['🔍', 'ffmpeg elemzés', 'felbontás, képkocka-sebesség, hangerő felmérése'],
                ['🧩', 'Illesztés', 'az intro/outro a videó formátumához igazodik'],
                ['🎬', 'ffmpeg render', 'áttűnés + hangerő-normalizálás, veszteségmentes illesztés'],
            ],
        },
        ppt_replace: {
            icon: '📊', title: 'PPT csere — pipeline',
            intro: 'A videóban rögzített (gyakran homályos) diák lecserélődnek az éles PPT-exportra.',
            steps: [
                ['🖨️', 'LibreOffice + Poppler', 'a PPT diáit éles képekké rendereli'],
                ['👁️', 'Képi dia-felismerés', 'megtalálja, mikor melyik dia látszik a videóban'],
                ['🔗', 'Dia-illesztés', 'összepárosítja a videó-szakaszokat a diákkal'],
                ['🎬', 'ffmpeg composite', 'a videóra éles diaképet illeszt, export'],
            ],
        },
        ppt_narrate: {
            icon: '🗣️', title: 'PPT narráció — modell-pipeline',
            intro: 'A PowerPoint jegyzeteiből narrált videó készül, az előadó klónozott hangján.',
            steps: [
                ['📑', 'python-pptx', 'kinyeri a diánkénti előadói jegyzeteket'],
                ['🪶', 'Racka-4B (magyar LLM)', 'felolvasóbarát beszélt szöveggé írja át (számok, dátumok szóban)'],
                ['🔤', 'Fonetikus átíró', 'betűszók és idegen szavak kiejtés szerint ("USB" → "ú es bé")'],
                ['🗣️', 'XTTS-v2 hangklón', 'diánként felmondja a szöveget'],
                ['🎬', 'ffmpeg', 'dia-képek + narráció → videó, YouTube-stílusú fejezetekkel'],
            ],
        },
        course: {
            icon: '📚', title: 'Kurzus — pipeline',
            intro: 'Egy teljes kurzus (ZIP-ben feltöltött videó-sorozat) egy menetben dolgozódik fel.',
            steps: [
                ['📦', 'Kicsomagolás', 'a ZIP-ből videó-lista készül'],
                ['🔁', 'Kötegelt sor', 'minden videó végigmegy a teljes szinkron-pipeline-on'],
                ['🗂️', 'Csomagolás', 'az eredmények kurzus-szerkezetben, egyben letölthetők'],
            ],
        },
        flow: {
            icon: '🧩', title: 'Flow builder — mi ez?',
            intro: 'Vizuális folyamat-szerkesztő: a fenti modulok tetszőleges sorrendben láncolhatók.',
            steps: [
                ['🧱', 'Csomópontok', 'minden lépés egy modul (szinkron, felirat, intro…)'],
                ['➡️', 'Élek', 'az egyik kimenete a másik bemenete'],
                ['⚙️', 'Futtató', 'a lánc lépésenként, állapotkövetéssel fut le'],
            ],
        },
        profile: {
            icon: '👤', title: 'Profil',
            intro: 'Itt nincs AI — fiókbeállítások, jelszó és munkaterületek kezelése.',
            steps: [],
        },
        admin: {
            icon: '🛠️', title: 'Admin',
            intro: 'Itt nincs AI — felhasználók, tárhely, kuka és audit-napló kezelése.',
            steps: [],
        },
    };

    // ─── CSS ────────────────────────────────────────────────────
    const css = document.createElement('style');
    css.textContent = [
        '.tool-card{position:relative;}',
        '.card-info-btn{position:absolute;top:10px;right:10px;width:26px;height:26px;',
        ' border-radius:50%;border:1px solid rgba(255,255,255,0.18);',
        ' background:rgba(255,255,255,0.06);color:#a5b4fc;font:700 0.8rem/1 system-ui;',
        ' cursor:pointer;opacity:0.55;transition:all .18s;z-index:2;}',
        '.card-info-btn:hover{opacity:1;background:rgba(99,102,241,0.35);color:#fff;',
        ' transform:scale(1.15);border-color:#6366f1;box-shadow:0 0 12px rgba(99,102,241,0.5);}',
        '#_infoOverlay{position:fixed;inset:0;background:rgba(0,0,0,0.65);',
        ' backdrop-filter:blur(5px);z-index:9998;display:flex;align-items:center;',
        ' justify-content:center;padding:16px;}',
        '#_infoBox{background:#11141b;border:1px solid rgba(255,255,255,0.1);',
        ' border-radius:20px;padding:26px 28px;max-width:520px;width:100%;color:#e5e7eb;',
        ' box-shadow:0 20px 60px rgba(0,0,0,0.6);font-family:inherit;position:relative;',
        ' max-height:86vh;overflow-y:auto;}',
        '#_infoBox h3{margin:0 0 6px;font-size:1.05rem;color:#fff;}',
        '#_infoBox .intro{color:#9ca3af;font-size:0.9rem;margin:0 0 16px;}',
        '#_infoBox .step{display:flex;gap:10px;align-items:flex-start;padding:8px 10px;',
        ' border:1px solid rgba(255,255,255,0.07);border-radius:12px;margin-bottom:8px;',
        ' background:rgba(255,255,255,0.025);}',
        '#_infoBox .step .em{font-size:1.05rem;line-height:1.4;}',
        '#_infoBox .step b{color:#a5b4fc;font-size:0.88rem;display:block;}',
        '#_infoBox .step span{color:#cbd5e1;font-size:0.84rem;}',
        '#_infoBox .arrow{ text-align:center;color:#6366f1;font-size:0.8rem;margin:-4px 0 4px;}',
        '#_infoClose{position:absolute;top:12px;right:14px;background:none;border:none;',
        ' color:#9ca3af;font-size:1.3rem;cursor:pointer;line-height:1;}',
        '#_infoClose:hover{color:#fff;}',
    ].join('');
    document.head.appendChild(css);

    // ─── Popup ──────────────────────────────────────────────────
    function openInfo(key) {
        const meta = INFO[key];
        if (!meta) return;
        closeInfo();
        const overlay = document.createElement('div');
        overlay.id = '_infoOverlay';
        // 300ms nyitás-védelem: a megnyitó kattintás duplán érkező click-je
        // (vagy egy véletlen duplaklikk) ne zárja be azonnal az ablakot.
        const openedAt = Date.now();
        overlay.addEventListener('click', e => {
            if (e.target === overlay && Date.now() - openedAt > 300) closeInfo();
        });
        const box = document.createElement('div');
        box.id = '_infoBox';
        const h = document.createElement('h3');
        h.textContent = meta.icon + ' ' + meta.title;
        const intro = document.createElement('p');
        intro.className = 'intro';
        intro.textContent = meta.intro;
        const close = document.createElement('button');
        close.id = '_infoClose';
        close.setAttribute('aria-label', 'Bezárás');
        close.textContent = '×';
        close.addEventListener('click', closeInfo);
        box.appendChild(close); box.appendChild(h); box.appendChild(intro);
        meta.steps.forEach((s, i) => {
            if (i > 0) {
                const a = document.createElement('div');
                a.className = 'arrow'; a.textContent = '▼';
                box.appendChild(a);
            }
            const row = document.createElement('div');
            row.className = 'step';
            const em = document.createElement('div'); em.className = 'em'; em.textContent = s[0];
            const txt = document.createElement('div');
            const b = document.createElement('b'); b.textContent = s[1];
            const sp = document.createElement('span'); sp.textContent = s[2];
            txt.appendChild(b); txt.appendChild(sp);
            row.appendChild(em); row.appendChild(txt);
            box.appendChild(row);
        });
        overlay.appendChild(box);
        document.body.appendChild(overlay);
        document.addEventListener('keydown', escHandler);
    }
    function closeInfo() {
        const o = document.getElementById('_infoOverlay');
        if (o) o.remove();
        document.removeEventListener('keydown', escHandler);
    }
    function escHandler(e) { if (e.key === 'Escape') closeInfo(); }

    // ─── Gombok felrakása a kártyákra ───────────────────────────
    function attach() {
        document.querySelectorAll('.tool-card[data-tile-id]').forEach(card => {
            const key = card.getAttribute('data-tile-id');
            if (!INFO[key] || card.querySelector('.card-info-btn')) return;
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'card-info-btn';
            btn.textContent = 'i';
            btn.title = 'Milyen modellek dolgoznak itt?';
            btn.setAttribute('aria-label', 'Pipeline-információ');
            btn.addEventListener('click', e => {
                // A kártya <a> — az info-gomb NEM navigálhat.
                e.preventDefault();
                e.stopPropagation();
                openInfo(key);
            });
            card.appendChild(btn);
        });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', attach);
    else attach();
})();
