// Mappa → ZIP a böngészőben, a fájlok memóriába olvasása nélkül. (UI-33)
//
// A kurzus-lap eddig JSZip-pel építette a ZIP-et: a JSZip minden bemeneti
// fájlt EGÉSZÉBEN beolvas, és a kész ZIP-et is a memóriában gyűjti — egy
// több GB-os kurzusmappánál a lap memóriája volt a korlát (egyetlen 3 GB-os
// videó egy darabban). Itt a ZIP egy Blob, ami a fejlécekből és az EREDETI
// File-objektumokból áll össze (a Blob hivatkozik rájuk, nem másol); a
// tartalmat csak a CRC-32-höz olvassuk végig, 4 MiB-os szeletekben. A
// darabolt feltöltés utána ugyanígy szeletenként olvas.
//
// Tárolt (STORE) bejegyzések: a videón a DEFLATE semmit nem nyer (mérve,
// 9/12), a kis fájlokon a néhány KB nem számít. A nevek UTF-8 jelzővel
// mennek (ékezetes mappa- és fájlnevek). ZIP64 nincs: a kurzus-ZIP korlátja
// 2 GB, a 4 GB-os / 65535 bejegyzéses ZIP-határ fölött hibát dobunk.
(function (global) {
    'use strict';

    const SLICE = 4 * 1024 * 1024;

    const CRC_TABLE = (() => {
        const t = new Uint32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
            t[n] = c >>> 0;
        }
        return t;
    })();

    function crc32Update(crc, bytes) {
        for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
        return crc;
    }

    async function crc32OfBlob(blob, onBytes) {
        let crc = 0xFFFFFFFF;
        for (let off = 0; off < blob.size; off += SLICE) {
            const buf = new Uint8Array(await blob.slice(off, off + SLICE).arrayBuffer());
            crc = crc32Update(crc, buf);
            if (onBytes) onBytes(buf.length);
        }
        return (crc ^ 0xFFFFFFFF) >>> 0;
    }

    function dosDateTime(ms) {
        const d = new Date(ms || Date.now());
        const year = Math.max(1980, d.getFullYear());
        return {
            time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
            date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
        };
    }

    /**
     * entries: [{ path: 'Kurzus/01 Bevezetés.mp4', file: File|Blob }]
     * onProgress(readBytes, totalBytes) a CRC-olvasás közben.
     * → Blob (application/zip)
     */
    async function buildStoreZip(entries, { onProgress } = {}) {
        if (entries.length > 0xFFFF) throw new Error('Túl sok fájl egy ZIP-hez (legfeljebb 65535).');
        const enc = new TextEncoder();
        const total = entries.reduce((a, e) => a + e.file.size, 0);
        const parts = [];
        const central = [];
        let offset = 0;
        let read = 0;
        for (const { path, file } of entries) {
            const name = enc.encode(String(path).replace(/\\/g, '/').replace(/^\/+/, ''));
            const crc = await crc32OfBlob(file, n => { read += n; if (onProgress) onProgress(read, total); });
            const { time, date } = dosDateTime(file.lastModified);
            if (offset + 30 + name.length + file.size > 0xFFFFFFFF) {
                throw new Error('A ZIP 4 GB fölé nőne — a kurzus-ZIP korlátja 2 GB.');
            }

            const lh = new DataView(new ArrayBuffer(30));
            lh.setUint32(0, 0x04034b50, true);   // helyi fejléc
            lh.setUint16(4, 20, true);           // kibontáshoz szükséges verzió
            lh.setUint16(6, 0x0800, true);       // UTF-8 nevek
            lh.setUint16(8, 0, true);            // STORE
            lh.setUint16(10, time, true);
            lh.setUint16(12, date, true);
            lh.setUint32(14, crc, true);
            lh.setUint32(18, file.size, true);
            lh.setUint32(22, file.size, true);
            lh.setUint16(26, name.length, true);
            lh.setUint16(28, 0, true);
            parts.push(lh.buffer, name, file);

            const ch = new DataView(new ArrayBuffer(46));
            ch.setUint32(0, 0x02014b50, true);   // központi könyvtár
            ch.setUint16(4, 20, true);
            ch.setUint16(6, 20, true);
            ch.setUint16(8, 0x0800, true);
            ch.setUint16(10, 0, true);
            ch.setUint16(12, time, true);
            ch.setUint16(14, date, true);
            ch.setUint32(16, crc, true);
            ch.setUint32(20, file.size, true);
            ch.setUint32(24, file.size, true);
            ch.setUint16(28, name.length, true);
            ch.setUint32(42, offset, true);      // a többi mező 0
            central.push(ch.buffer, name);

            offset += 30 + name.length + file.size;
        }
        const cdSize = central.reduce((a, p) => a + p.byteLength, 0);
        const eocd = new DataView(new ArrayBuffer(22));
        eocd.setUint32(0, 0x06054b50, true);
        eocd.setUint16(8, entries.length, true);
        eocd.setUint16(10, entries.length, true);
        eocd.setUint32(12, cdSize, true);
        eocd.setUint32(16, offset, true);
        return new Blob([...parts, ...central, eocd.buffer], { type: 'application/zip' });
    }

    global.ZipStore = { buildStoreZip, crc32OfBlob };
})(window);
