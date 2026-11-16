/* ============================================================
 * external_services.js — "Kapcsolódó szolgáltatások" a kezdőlapon.
 * A backend /api/services/status-ból tölti fel a csempéket, és élő
 * státusz-pontot mutat:
 *   up          → zöld  · kattintható · "Megnyitás →"
 *   pending     → sárga · "Indul / épül…" (URL kész, de még nem elérhető)
 *   unconfigured→ szürke · "Beállítás alatt" (nincs tunnel-URL a configban)
 * Kétféle csempe van (NET-009): a saját felülettel bíró szolgáltatás (n8n,
 * ComfyUI) megnyitható, a BELSŐ KÉPESSÉG (ui: false — konvertáló, HTML → MP4
 * renderelő, Crawl4AI) viszont nem: ott nincs mit megnyitni, csak azt
 * mutatjuk, fut-e. Ezért az ilyen csempe nem halványul el futás közben.
 * A státuszt a backend a docker-hálózaton BELÜLRŐL méri (nincs CORS),
 * ezért a "még épül" állapot magától látszik. 12 mp-enként frissül.
 * Csak adminnak (NET-007): az n8n és a ComfyUI képesség, nem a
 * felhasználók felülete — a végpont másnak 403, ezért a szerepkört
 * előbb a /api/whoami-ból kérdezzük, és csak admin pollol.
 * ============================================================ */
(function () {
    'use strict';

    var POLL_MS = 12000;
    var STATE = {
        up:           { dot: 'var(--success)', text: 'Fut',            live: true  },
        pending:      { dot: 'var(--warning)', text: 'Indul / épül…',  live: false },
        unconfigured: { dot: 'var(--text-muted)', text: 'Beállítás alatt', live: false }
    };

    function card(svc) {
        var st = STATE[svc.state] || STATE.unconfigured;
        var clickable = st.live && svc.url;
        var belso = svc.ui === false;      // belső képesség: nincs mit megnyitni

        var el = document.createElement(clickable ? 'a' : 'div');
        if (clickable) {
            el.href = svc.url;
            el.target = '_blank';
            el.rel = 'noopener noreferrer';
        }
        el.setAttribute('data-svc', svc.key);
        el.title = clickable ? ('Megnyitás: ' + svc.url)
            : belso ? 'Belső képesség — nincs saját felülete, a stúdió használja'
            : (svc.state === 'pending' ? 'A szolgáltatás indul vagy épp épül'
                                       : 'Még nincs beállítva a nyilvános cím');
        el.style.cssText =
            'display:flex; align-items:center; gap:12px; min-width:230px;' +
            'padding:14px 16px; border-radius:14px; text-decoration:none;' +
            'border:1px solid var(--border-subtle);' +
            'background:var(--tint-2); color:var(--text-primary);' +
            'transition:all .18s;' +
            (clickable ? 'cursor:pointer;'
                       : 'cursor:default;' + (belso ? '' : ' opacity:0.72;'));
        if (clickable) {
            el.onmouseenter = function () {
                el.style.background = 'var(--accent-soft-hover)';
                el.style.borderColor = 'var(--accent-color)';
            };
            el.onmouseleave = function () {
                el.style.background = 'var(--tint-2)';
                el.style.borderColor = 'var(--border-subtle)';
            };
        }

        var icon = document.createElement('div');
        icon.textContent = svc.icon || '🔗';
        icon.style.cssText = 'font-size:1.5rem; line-height:1;';

        var mid = document.createElement('div');
        mid.style.cssText = 'flex:1; min-width:0;';
        var name = document.createElement('div');
        name.textContent = svc.label || svc.key;
        name.style.cssText = 'font-weight:600; font-size:0.95rem;';
        var sub = document.createElement('div');
        sub.textContent = svc.subtitle || '';
        sub.style.cssText = 'font-size:0.78rem; color:var(--text-secondary); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;';
        mid.appendChild(name);
        if (svc.subtitle) mid.appendChild(sub);

        var status = document.createElement('div');
        status.style.cssText = 'display:flex; align-items:center; gap:6px; font-size:0.72rem; color:var(--text-secondary); white-space:nowrap;';
        var dot = document.createElement('span');
        dot.style.cssText = 'width:9px; height:9px; border-radius:50%; background:' + st.dot +
            (svc.state === 'up' ? '; box-shadow:0 0 7px ' + st.dot : '') + ';';
        // Lüktetés a "pending" (épül/indul) állapoton, hogy szembetűnő legyen.
        if (svc.state === 'pending') dot.style.animation = 'extsvc-pulse 1.1s ease-in-out infinite';
        var stxt = document.createElement('span');
        stxt.textContent = st.text;
        status.appendChild(dot);
        status.appendChild(stxt);

        el.appendChild(icon);
        el.appendChild(mid);
        el.appendChild(status);
        return el;
    }

    function render(services) {
        var section = document.getElementById('extServices');
        var row = document.getElementById('extServicesRow');
        if (!section || !row) return;
        // A szekció láthatóságát a .hidden osztály adja (display:none !important),
        // ezért NEM elég a style.display-t üresre állítani — az osztályt kell
        // levenni, különben a rács megjelenne, de a szekció rejtve maradna.
        if (!services || !services.length) { section.classList.add('hidden'); return; }
        row.innerHTML = '';
        services.forEach(function (s) { row.appendChild(card(s)); });
        section.classList.remove('hidden');
    }

    var _timer = null;
    function stop() {
        if (_timer) { clearInterval(_timer); _timer = null; }
    }

    function poll() {
        fetch('api/services/status', { credentials: 'same-origin' })
            .then(function (r) {
                // Közben elvett admin-jog: nem kérdezünk tovább 12 mp-enként
                // egy 403-ért, és a gombok is eltűnnek. (A 401-et a shared.js
                // fetch-burka kezeli: a belépő lapra visz.)
                if (r.status === 403) { stop(); render(null); return null; }
                return r.ok ? r.json() : null;
            })
            .then(function (d) { if (d && d.services) render(d.services); })
            .catch(function () { /* hálózati hiba → megtartjuk az utolsó állapotot */ });
    }

    function start() {
        // A pulzáló @keyframes a style.css-ben él (globális névtér). (UI-13)
        // Nem-adminnál egyetlen kérés sem megy ki: a szekció rejtve marad,
        // és a lapon nincs 403-as válasz (a szerepkör-függő lapok mintája).
        var who = (typeof ensureUserInfo === 'function') ? ensureUserInfo() : Promise.resolve(null);
        who.then(function (info) {
            if (!info || info.role !== 'admin') return;
            poll();
            _timer = setInterval(poll, POLL_MS);
        });
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
})();
