/* ============================================================
 * EDTI STUDIO — DEMÓ MOCK ROUTE-OK: FLOW BUILDER (flow.html)
 * ------------------------------------------------------------
 * A mock_core.js UTÁN töltődik be. Az /api/flow/* végpontokat
 * szolgálja ki: node-típus paletta, sablonok (CRUD), flow-futások
 * (indítás / 3s-os poll / cancel / retry / klón-forrás / assets),
 * valamint a quick-combo gyors-folytatást.
 *
 * A futások előrehaladását NEM a MOCK.sim hajtja, hanem egy saját,
 * gráf-tudatos állapotgép: a node-okat topológiai szintekre bontjuk
 * (leghosszabb-út mélység), minden szint a futásidő súlyarányos
 * szeletét kapja, és a node-státusz (waiting/running/done) a valós
 * eltelt időből SZÁMÍTOTT érték — nincs háttér-timer.
 *
 * FONTOS FÜGGŐSÉG: a feltöltés-trió (POST /api/batch/upload/init +
 * /chunk + /finalize) a core/batch modul tulajdona — itt NEM
 * regisztráljuk újra. A finalize-nak nem-null `path` stringet KELL
 * adnia, különben a flow-indítás "path nem érkezett vissza" hibát dob.
 * ============================================================ */
(function () {
    'use strict';

    if (!window.MOCK) {
        console.error('[MOCK/flow] mock_core.js nincs betöltve — a flow route-ok kimaradnak.');
        return;
    }
    const M = window.MOCK;

    // ─── Csoport-állapot (perzisztens, localStorage-ben él) ─────
    const FS = M.state.extra.flow = M.state.extra.flow || {};
    FS.templates = FS.templates || [];
    FS.runs = FS.runs || {};

    // Fix fixture-azonosítók (32 hex — a UI .slice(0,8)-at mutat belőlük)
    const RUN_DONE_ID = 'c9a1f2d34b5e46789a0b1c2d3e4f5061';
    const RUN_LIVE_ID = '7b3e9d1c5a2f48069e8d7c6b5a493827';

    // Letöltési asset-pool: MINDEN flow-eredmény a demo-dub-1 fixture
    // statikus fájljaira mutat (a <a href> letöltéseket a mock nem tudja
    // elfogni → ezeknek valódi fájlként kell létezniük a repóban):
    //   api/download/demo-dub-1/dubbed.mp4
    //   api/download/demo-dub-1/hu.srt
    //   api/download/demo-dub-1/transcript.txt
    const DL_BASE = 'api/download/demo-dub-1';

    function hexId() {
        let s = '';
        while (s.length < 32) s += Math.floor(Math.random() * 16).toString(16);
        return s;
    }

    // ─── Node-típus katalógus (backend/flow/asset_types.py tükre) ──
    // NT(): a frontend által olvasott shape-re alakít — inputs_full
    // {slot: assetType}, outputs_full {out: {asset_type, filename}}.
    function NT(name, label, description, jobType, inputs, outputs) {
        const outputsFull = {};
        for (const k in outputs) {
            outputsFull[k] = { asset_type: outputs[k][0], filename: outputs[k][1] };
        }
        return {
            name: name, label: label, description: description, job_type: jobType,
            inputs: Object.keys(inputs), outputs: Object.keys(outputs),
            inputs_full: inputs, outputs_full: outputsFull,
        };
    }

    const NODE_TYPES = [
        NT('upload', '📁 Feltöltés', 'A flow első csomópontja: a user által feltöltött fájl.', null,
            {},
            {
                raw_video: ['raw_video', 'input.mp4'],
                pptx_input: ['pptx_input', 'input.pptx'],
                voice_ref: ['voice_ref', 'voice_ref.wav'],
            }),
        NT('dub', '🎙️ Szinkron', 'Magyar videó → angol szinkron + felirat.', 'pipeline_stage_1',
            { input_video: 'raw_video' },
            {
                dubbed_video: ['dubbed_video_voice_only', 'dubbed.mp4'],
                dubbed_with_bg: ['dubbed_video_with_bg', 'dubbed_with_bg.mp4'],
                segments_json: ['translated_segments', 'segments.json'],
                subtitle_srt: ['subtitle_srt', 'hu.srt'],
                voice_only_audio: ['voice_only_audio', 'voice_only.wav'],
            }),
        NT('subtitle', '💬 Felirat', 'Felirat-generálás SRT/VTT formátumban.', 'pipeline_stage_1',
            { input_video: 'raw_video' },
            {
                subtitle_srt: ['subtitle_srt', 'hu.srt'],
                subtitle_vtt: ['subtitle_vtt', 'dubbed.vtt'],
                segments_json: ['segments_json', 'segments.json'],
            }),
        NT('transcribe', '📄 Leirat', 'Szöveges leirat ASR-rel.', 'pipeline_stage_1',
            { input_video: 'raw_video' },
            {
                transcript_txt: ['transcript_txt', 'transcript.txt'],
                segments_json: ['segments_json', 'segments.json'],
                subtitle_srt: ['subtitle_srt', 'hu.srt'],
            }),
        NT('intro_outro', '🎬 Intro/Outro', 'Brand intro/outro keret hozzáfűzése a videóhoz.', 'intro_outro',
            { input_video: 'raw_video' },
            { branded_video: ['branded_video', 'output.mp4'] }),
        NT('ppt_narrate', '🗣️ PPT Narráció', 'PPTX speaker-notes → XTTS → narrált videó.', 'ppt_narrate',
            { input_pptx: 'pptx_input', voice_ref: 'voice_ref' },
            {
                narrated_video: ['narrated_video', 'output.mp4'],
                speaker_notes: ['speaker_notes', 'notes.json'],
            }),
        NT('ppt_replace', '🖼️ PPT-csere', 'Régi slide-háttér cseréje új PPTX-ből.', 'ppt_replace',
            { input_video: 'raw_video', input_pptx: 'pptx_input' },
            { composite_video: ['ppt_replace_composite_video', 'output.mp4'] }),
        NT('download', '📥 Letöltés', 'Terminál node: a flow eredményeit gyűjti össze letöltésre.', null,
            {
                input_video: 'raw_video',
                input_subtitle: 'subtitle_srt',
                input_transcript: 'transcript_txt',
                input_notes: 'speaker_notes',
                input_subtitle_vtt: 'subtitle_vtt',
                input_voice_only: 'voice_only_audio',
            },
            {}),
    ];

    const VIDEO_LIKE = [
        'raw_video', 'branded_video', 'narrated_video',
        'ppt_replace_composite_video', 'dubbed_video_voice_only',
        'dubbed_video_with_bg',
    ];

    function specFor(typeName) {
        for (const t of NODE_TYPES) if (t.name === typeName) return t;
        return null;
    }

    // asset_type → statikus demó-fájl (FIX POOL — csak 3 valódi fájl kell)
    function assetFile(assetType) {
        if (VIDEO_LIKE.indexOf(assetType) !== -1) {
            return { url: DL_BASE + '/dubbed.mp4', size: 34865152 };
        }
        if (assetType === 'subtitle_srt' || assetType === 'subtitle_vtt') {
            return { url: DL_BASE + '/hu.srt', size: 18432 };
        }
        // Minden egyéb (transcript, segments, notes, audio) → szöveges minta
        return { url: DL_BASE + '/transcript.txt', size: 9216 };
    }

    // ─── Futás-állapotgép: szintek + időszeletek ────────────────
    const NODE_WEIGHTS = {
        upload: 1, download: 1, dub: 10, subtitle: 5, transcribe: 4,
        intro_outro: 3, ppt_narrate: 8, ppt_replace: 9,
    };
    function nodeWeight(type) {
        return NODE_WEIGHTS[type] != null ? NODE_WEIGHTS[type] : 5;
    }

    // Leghosszabb-út mélység node-onként (Bellman-Ford-szerű relaxáció,
    // kör-védelemmel: legfeljebb |nodes| iteráció).
    function nodeLevels(graph) {
        const nodes = (graph && graph.nodes) || [];
        const edges = (graph && graph.edges) || [];
        const lvl = {};
        nodes.forEach(n => { lvl[n.id] = 0; });
        for (let i = 0; i < nodes.length; i++) {
            let changed = false;
            for (const e of edges) {
                if (lvl[e.from] == null || lvl[e.to] == null) continue;
                if (lvl[e.to] < lvl[e.from] + 1) { lvl[e.to] = lvl[e.from] + 1; changed = true; }
            }
            if (!changed) break;
        }
        return lvl;
    }

    // Szint-ütemterv: minden szint [start, end) másodperc-sávot kap a
    // teljes futásidőből, a szint legsúlyosabb node-jának súlya szerint.
    function schedule(run) {
        const nodes = (run.graph && run.graph.nodes) || [];
        const dur = run.durationSec || 60;
        const lvl = nodeLevels(run.graph);
        let maxLvl = 0;
        nodes.forEach(n => { maxLvl = Math.max(maxLvl, lvl[n.id] || 0); });
        const weights = [];
        for (let L = 0; L <= maxLvl; L++) {
            const inLevel = nodes.filter(n => (lvl[n.id] || 0) === L);
            weights.push(inLevel.length ? Math.max.apply(null, inLevel.map(n => nodeWeight(n.type))) : 1);
        }
        const total = weights.reduce((a, b) => a + b, 0) || 1;
        const bounds = [];
        let acc = 0;
        for (const w of weights) {
            const s = acc / total * dur;
            acc += w;
            bounds.push([s, acc / total * dur]);
        }
        return { lvl: lvl, bounds: bounds };
    }

    // node_runs[] a poll-válaszhoz — a node_id-k a beküldött gráf id-jai,
    // így a canvas status-festése (status-<st> class + pill) passzol.
    function nodeRuns(run, elapsedSec, isCancelled, allDone) {
        const nodes = (run.graph && run.graph.nodes) || [];
        const sch = schedule(run);
        return nodes.map(n => {
            if (allDone) return { node_id: n.id, status: 'done' };
            const b = sch.bounds[sch.lvl[n.id] || 0] || [0, 0];
            let st;
            if (elapsedSec >= b[1] - 1e-6) st = 'done';
            else if (elapsedSec >= b[0]) st = isCancelled ? 'cancelled' : 'running';
            else st = isCancelled ? 'cancelled' : 'waiting';
            return { node_id: n.id, status: st };
        });
    }

    // Örökmozgó fixture: ha végzett (vagy cancelt) és eltelt 1 perc,
    // újraindul — a runs-panel mindig mutasson életet.
    function tickPerpetual(run) {
        if (!run || !run.perpetual) return;
        const now = Date.now();
        const durMs = (run.durationSec || 60) * 1000;
        if (run.cancelledAt) {
            if (now - run.cancelledAt > 60000) {
                run.cancelledAt = null;
                run.startTs = now;
                run.durationSec = 300 + Math.floor(Math.random() * 120);
                M.save();
            }
            return;
        }
        if (now > run.startTs + durMs + 60000) {
            run.startTs = now;
            run.durationSec = 300 + Math.floor(Math.random() * 120);
            M.save();
        }
    }

    // A lista-/detail-nézet által olvasott mezők: id, name, status,
    // progress_pct (szám!), node_runs[]. Az id-k STRINGEK (.slice(0,8)!).
    function runView(run) {
        tickPerpetual(run);
        const dur = run.durationSec || 60;
        const now = Date.now();
        const effNow = run.cancelledAt ? Math.min(run.cancelledAt, now) : now;
        const elapsed = Math.max(0, (effNow - run.startTs) / 1000);
        const finished = elapsed >= dur;
        const isCancelled = !!run.cancelledAt && !finished;
        const pct = Math.max(0, Math.min(100, Math.round(100 * elapsed / dur)));
        return {
            id: run.id,
            name: run.name || 'Flow',
            status: finished ? 'done' : (isCancelled ? 'cancelled' : 'running'),
            progress_pct: finished ? 100 : pct,
            node_runs: nodeRuns(run, Math.min(elapsed, dur), isCancelled, finished),
            created_at: run.created_at,
            updated_at: M.ts(),
            owner: run.owner || 'demo',
        };
    }

    // ─── Asset-lista összeállítása egy futáshoz ─────────────────
    // Download-node-ok bemenő élei alapján — így a download-node props-
    // panel node_id-szűrése is működik. Ha nincs download node, a levél-
    // funkcionális node-ok kimenetei adják a listát.
    function buildAssets(run) {
        const nodes = (run.graph && run.graph.nodes) || [];
        const edges = (run.graph && run.graph.edges) || [];
        const out = [];
        const seen = {};
        function push(nodeId, outputName, assetType) {
            const key = nodeId + '|' + outputName;
            if (seen[key]) return;
            seen[key] = 1;
            const f = assetFile(assetType);
            out.push({
                node_id: nodeId,
                output_name: outputName,
                asset_type: assetType,
                download_url: f.url,
                size_bytes: f.size,
            });
        }
        const dlNodes = nodes.filter(n => n.type === 'download');
        for (const d of dlNodes) {
            for (const e of edges) {
                if (e.to !== d.id) continue;
                const producer = nodes.find(n => n.id === e.from);
                const spec = producer && specFor(producer.type);
                const o = spec && spec.outputs_full[e.from_asset];
                push(d.id, e.from_asset || 'eredmeny', o ? o.asset_type : 'raw_video');
            }
        }
        if (!out.length) {
            // Nincs (bekötött) download node → a levél-node-ok kimenetei
            const hasOutgoing = {};
            edges.forEach(e => { hasOutgoing[e.from] = 1; });
            for (const n of nodes) {
                if (n.type === 'upload' || n.type === 'download' || hasOutgoing[n.id]) continue;
                const spec = specFor(n.type);
                if (!spec) continue;
                for (const oname in spec.outputs_full) {
                    push(n.id, oname, spec.outputs_full[oname].asset_type);
                }
            }
        }
        return out;
    }

    // Adott node-típus "elsődleges" videó-kimenete (quick-combo lánc-élekhez)
    function primaryVideoOutput(typeName) {
        const spec = specFor(typeName);
        if (!spec) return 'raw_video';
        for (const oname in spec.outputs_full) {
            if (VIDEO_LIKE.indexOf(spec.outputs_full[oname].asset_type) !== -1) return oname;
        }
        const names = Object.keys(spec.outputs_full);
        return names.length ? names[0] : 'raw_video';
    }

    // Régi user-futások nyesése — a localStorage ne hízzon a végtelenbe.
    function pruneRuns() {
        const prunable = Object.values(FS.runs)
            .filter(r => !r.perpetual && r.id !== RUN_DONE_ID)
            .sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
        while (prunable.length > 15) {
            const victim = prunable.shift();
            delete FS.runs[victim.id];
        }
    }

    // ─── Kezdő fixture-ök ───────────────────────────────────────
    // 1 kész + 1 örökmozgó futó run + 3 sablon (Saját/Workspace/Általános
    // fül mind kap tartalmat). A node-id-k /^[A-Za-z0-9_-]+$/ safe-ek.
    function seed() {
        if (FS.seeded) return;
        const H = 3600 * 1000;

        // "Szinkron + felirat" gráf — sablonként ÉS kész futásként is él
        const gDub = {
            schema_version: 1,
            nodes: [
                { id: 'n1', type: 'upload', config: {}, pos: { x: 40, y: 160 } },
                { id: 'n2', type: 'dub', config: { language: 'hun', preset: 'youtube' }, pos: { x: 300, y: 160 } },
                { id: 'n3', type: 'download', config: {}, pos: { x: 560, y: 160 } },
            ],
            edges: [
                { from: 'n1', from_asset: 'raw_video', to: 'n2', to_input: 'input_video' },
                { from: 'n2', from_asset: 'dubbed_video', to: 'n3', to_input: 'input_video' },
                { from: 'n2', from_asset: 'subtitle_srt', to: 'n3', to_input: 'input_subtitle' },
            ],
            meta: { name: 'Szinkron + felirat' },
        };
        // Futó fixture gráfja: upload → dub → intro_outro → download
        const gLive = {
            schema_version: 1,
            nodes: [
                { id: 'u1', type: 'upload', config: {}, pos: { x: 40, y: 160 } },
                { id: 'd1', type: 'dub', config: { language: 'hun' }, pos: { x: 300, y: 100 } },
                { id: 'b1', type: 'intro_outro', config: { theme: 'edti' }, pos: { x: 560, y: 100 } },
                { id: 'dl1', type: 'download', config: {}, pos: { x: 820, y: 160 } },
            ],
            edges: [
                { from: 'u1', from_asset: 'raw_video', to: 'd1', to_input: 'input_video' },
                { from: 'd1', from_asset: 'dubbed_video', to: 'b1', to_input: 'input_video' },
                { from: 'b1', from_asset: 'branded_video', to: 'dl1', to_input: 'input_video' },
                { from: 'd1', from_asset: 'subtitle_srt', to: 'dl1', to_input: 'input_subtitle' },
            ],
            meta: { name: 'Mélytanulás 7. — szinkron + branding' },
        };
        // PPT-narrációs sablon gráfja (2 upload: PPTX + hangminta)
        const gPpt = {
            schema_version: 1,
            nodes: [
                { id: 'n1', type: 'upload', config: {}, pos: { x: 40, y: 90 } },
                { id: 'n2', type: 'upload', config: {}, pos: { x: 40, y: 250 } },
                { id: 'n3', type: 'ppt_narrate', config: { voice: 'default' }, pos: { x: 300, y: 160 } },
                { id: 'n4', type: 'download', config: {}, pos: { x: 560, y: 160 } },
            ],
            edges: [
                { from: 'n1', from_asset: 'pptx_input', to: 'n3', to_input: 'input_pptx' },
                { from: 'n2', from_asset: 'voice_ref', to: 'n3', to_input: 'voice_ref' },
                { from: 'n3', from_asset: 'narrated_video', to: 'n4', to_input: 'input_video' },
            ],
            meta: { name: 'PPT → narrált videó' },
        };
        // Leirat + felirat sablon gráfja
        const gTrans = {
            schema_version: 1,
            nodes: [
                { id: 'n1', type: 'upload', config: {}, pos: { x: 40, y: 160 } },
                { id: 'n2', type: 'transcribe', config: {}, pos: { x: 300, y: 160 } },
                { id: 'n3', type: 'download', config: {}, pos: { x: 560, y: 160 } },
            ],
            edges: [
                { from: 'n1', from_asset: 'raw_video', to: 'n2', to_input: 'input_video' },
                { from: 'n2', from_asset: 'transcript_txt', to: 'n3', to_input: 'input_transcript' },
                { from: 'n2', from_asset: 'subtitle_srt', to: 'n3', to_input: 'input_subtitle' },
            ],
            meta: { name: 'Leirat + felirat' },
        };

        // Sablonok — graph_json JSON STRINGKÉNT (a kliens JSON.parse-olja)
        FS.templates = [
            {
                id: 'demo-tpl-1', name: 'Szinkron + felirat', visibility: 'private',
                owner: 'demo', description: 'Magyar videó → angol szinkron + SRT felirat.',
                updated_at: M.ts(Date.now() - 26 * H), graph_json: JSON.stringify(gDub),
            },
            {
                id: 'demo-tpl-2', name: 'Leirat + felirat', visibility: 'workspace',
                owner: 'demo', description: 'ASR-leirat és felirat egy körben.',
                updated_at: M.ts(Date.now() - 50 * H), graph_json: JSON.stringify(gTrans),
            },
            {
                id: 'demo-tpl-3', name: 'PPT → narrált videó', visibility: 'shared',
                owner: 'admin', description: 'PPTX jegyzetekből XTTS-narrált videó.',
                updated_at: M.ts(Date.now() - 96 * H), graph_json: JSON.stringify(gPpt),
            },
        ];

        // Kész futás (26 órája lefutott)
        FS.runs[RUN_DONE_ID] = {
            id: RUN_DONE_ID,
            name: 'Digitális technika 3. — szinkron',
            graph: gDub,
            created_at: M.ts(Date.now() - 26 * H),
            startTs: Date.now() - 26 * H,
            durationSec: 240,
            cancelledAt: null,
            perpetual: false,
            owner: 'demo',
        };
        // Örökmozgó futó run (1 perce indult, ~6 perc a köre)
        FS.runs[RUN_LIVE_ID] = {
            id: RUN_LIVE_ID,
            name: 'Mélytanulás 7. — szinkron + branding',
            graph: gLive,
            created_at: M.ts(Date.now() - 12 * 60000),
            startTs: Date.now() - 60000,
            durationSec: 360,
            cancelledAt: null,
            perpetual: true,
            owner: 'demo',
        };
        FS.seeded = true;
        M.save();
    }
    seed();

    // ════════════════════════════════════════════════════════════
    // ROUTE-OK
    // ════════════════════════════════════════════════════════════

    // ─── Node-típus paletta ─────────────────────────────────────
    M.route('GET', 'api/flow/node-types', () => ({
        node_types: NODE_TYPES,
        video_like_assets: VIDEO_LIKE,
    }));

    // ─── Sablonok ───────────────────────────────────────────────
    M.route('GET', 'api/flow/templates', () => {
        // Bare array — frissebb elöl
        return FS.templates.slice().sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
    });

    M.route('POST', 'api/flow/templates', (m, req) => {
        const b = req.body || {};
        if (!b.graph || !Array.isArray(b.graph.nodes)) {
            return M.resp(422, { detail: 'A graph mező kötelező (nodes tömbbel).' });
        }
        const id = hexId().slice(0, 8);
        FS.templates.push({
            id: id,
            name: b.name || 'Új sablon',
            visibility: b.visibility || 'private',
            owner: 'demo',
            description: b.description || null,
            updated_at: M.ts(),
            graph_json: JSON.stringify(b.graph),
        });
        M.save();
        return { status: 'created', id: id };
    });

    M.route('PUT', 'api/flow/templates/([^/]+)', (m, req) => {
        const t = FS.templates.find(x => x.id === m[1]);
        if (!t) return M.resp(404, { detail: 'Ismeretlen sablon (demo).' });
        const b = req.body || {};
        if (b.name) t.name = b.name;
        if (b.visibility) t.visibility = b.visibility;
        if (b.description !== undefined) t.description = b.description;
        if (b.graph) t.graph_json = JSON.stringify(b.graph);
        t.updated_at = M.ts();
        M.save();
        return { status: 'updated', id: t.id };
    });

    M.route('DELETE', 'api/flow/templates/([^/]+)', (m) => {
        const i = FS.templates.findIndex(x => x.id === m[1]);
        if (i === -1) return M.resp(404, { detail: 'Ismeretlen sablon (demo).' });
        FS.templates.splice(i, 1);
        M.save();
        return { status: 'deleted' };
    });

    M.route('POST', 'api/flow/templates/([^/]+)/fork', (m, req) => {
        const t = FS.templates.find(x => x.id === m[1]);
        if (!t) return M.resp(404, { detail: 'Ismeretlen sablon (demo).' });
        const id = hexId().slice(0, 8);
        FS.templates.push({
            id: id,
            name: (req.body && req.body.name) || (t.name + ' (fork)'),
            visibility: 'private',
            owner: 'demo',
            description: t.description,
            updated_at: M.ts(),
            graph_json: t.graph_json,
        });
        M.save();
        return { status: 'forked', id: id };
    });

    // ─── Futások ────────────────────────────────────────────────

    // Indítás — a beküldött gráfot 1:1 visszhangozzuk (a node_id-knek
    // egyezniük KELL a canvas id-ivel a státusz-festéshez).
    M.route('POST', 'api/flow/runs', (m, req) => {
        const b = req.body || {};
        if (!b.graph || !Array.isArray(b.graph.nodes) || b.graph.nodes.length === 0) {
            return M.resp(422, { detail: 'Üres vagy hiányzó graph — adj hozzá node-okat.' });
        }
        const id = hexId();
        FS.runs[id] = {
            id: id,
            name: b.name || 'Flow',
            graph: b.graph,
            created_at: M.ts(),
            startTs: Date.now(),
            durationSec: 55 + Math.floor(Math.random() * 35),
            cancelledAt: null,
            perpetual: false,
            owner: 'demo',
            input_file_paths: b.input_file_paths || [],
        };
        pruneRuns();
        M.save();
        // A kliens CSAK a flow_run_id-t olvassa (és .slice(0,8)-at hív rá)
        return { flow_run_id: id, status: 'accepted' };
    });

    // Lista — 3s-onként pollozva. Bare array, frissebb elöl.
    M.route('GET', 'api/flow/runs', (m, req) => {
        let limit = parseInt(req.query.get('limit') || '20', 10);
        if (!isFinite(limit) || limit <= 0) limit = 20;
        const runs = Object.values(FS.runs).sort((a, b) => {
            if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1;
            return (b.startTs || 0) - (a.startTs || 0);
        });
        return runs.slice(0, limit).map(runView);
    });

    // Run-detail — a Klónoz akció hívja: pre-parsed graph OBJEKTUM megy.
    M.route('GET', 'api/flow/runs/([^/]+)', (m) => {
        const run = FS.runs[m[1]];
        if (!run) return M.resp(404, { detail: 'Ismeretlen flow-run (demo).' });
        const v = runView(run);
        v.graph = run.graph;             // objektum — a kliens ezt preferálja
        v.graph_json = JSON.stringify(run.graph); // kompatibilitási string
        return v;
    });

    // Asset-lista — a run-sor "Letöltés" gombja és a download-node
    // props-panelje hívja. A download_url-ok RELATÍV statikus fájlok
    // (a <a href>-et a mock nem tudja elfogni).
    M.route('GET', 'api/flow/runs/([^/]+)/assets', (m) => {
        const run = FS.runs[m[1]];
        if (!run) return M.resp(404, { detail: 'Ismeretlen flow-run (demo).' });
        const v = runView(run);
        return {
            flow_run_id: run.id,
            status: v.status,
            assets: buildAssets(run),
        };
    });

    // Megszakítás — a kliens a 404-et is sikernek veszi, a body-t nem olvassa.
    M.route('POST', 'api/flow/runs/([^/]+)/cancel', (m) => {
        const run = FS.runs[m[1]];
        if (!run) return M.resp(404, { detail: 'Ismeretlen flow-run (demo).' });
        const finished = (Date.now() - run.startTs) / 1000 >= (run.durationSec || 60);
        if (!finished && !run.cancelledAt) {
            run.cancelledAt = Date.now();
            M.save();
        }
        return { status: 'cancelled' };
    });

    // Node-retry — a futás óráját a node szintjének kezdetére tekerjük
    // vissza, így a node (és minden utána jövő) újra végigfut.
    M.route('POST', 'api/flow/runs/([^/]+)/nodes/([^/]+)/retry', (m) => {
        const run = FS.runs[m[1]];
        if (!run) return M.resp(404, { detail: 'Ismeretlen flow-run (demo).' });
        const sch = schedule(run);
        const b = sch.bounds[sch.lvl[m[2]] || 0] || [0, 0];
        run.cancelledAt = null;
        run.startTs = Date.now() - Math.floor(b[0] * 1000);
        M.save();
        return { status: 'requeued', node_id: m[2] };
    });

    M.route('DELETE', 'api/flow/runs/([^/]+)', (m) => {
        const run = FS.runs[m[1]];
        if (!run) return M.resp(404, { detail: 'Ismeretlen flow-run (demo).' });
        delete FS.runs[m[1]];
        M.save();
        return { status: 'deleted' };
    });

    // ─── Quick-combo (quick_combo.js — más oldalakról hívott) ───
    // Kész job-ra fűzött mini-flow: forrás-node → lánc → download.
    // A kliens csak a flow_run_id-t olvassa (.slice(0,8)).
    M.route('POST', 'api/flow/quick-combo', (m, req) => {
        const b = req.body || {};
        const chain = Array.isArray(b.chain_after) ? b.chain_after : [];
        const srcType = b.source_node_type || 'dub';
        const nodes = [{ id: 'src', type: srcType, config: {}, pos: { x: 40, y: 140 } }];
        const edges = [];
        let prevId = 'src';
        let prevType = srcType;
        let x = 300;
        chain.forEach((c, i) => {
            const id = 'qc' + (i + 1);
            const type = (c && c.type) || 'intro_outro';
            nodes.push({ id: id, type: type, config: (c && c.config) || {}, pos: { x: x, y: 140 } });
            edges.push({ from: prevId, from_asset: primaryVideoOutput(prevType), to: id, to_input: 'input_video' });
            prevId = id;
            prevType = type;
            x += 260;
        });
        nodes.push({ id: 'dl', type: 'download', config: {}, pos: { x: x, y: 140 } });
        edges.push({ from: prevId, from_asset: primaryVideoOutput(prevType), to: 'dl', to_input: 'input_video' });
        const chainLabel = chain.map(c => (c && c.type) || '?').join(' + ') || 'folytatás';
        const id = hexId();
        FS.runs[id] = {
            id: id,
            name: 'Gyors folytatás: ' + chainLabel,
            graph: { schema_version: 1, nodes: nodes, edges: edges, meta: { name: 'Gyors folytatás: ' + chainLabel } },
            created_at: M.ts(),
            startTs: Date.now(),
            durationSec: 40 + Math.floor(Math.random() * 25),
            cancelledAt: null,
            perpetual: false,
            owner: 'demo',
            source_job_id: b.source_job_id || null,
        };
        pruneRuns();
        M.save();
        return { flow_run_id: id, status: 'accepted' };
    });
})();
