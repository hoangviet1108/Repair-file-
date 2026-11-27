// Bo phan tich file MP4/MOV - chay duoc trong trinh duyet va Node.
// analyze(src, opts) voi src = {size, name, read(offset, length) -> Promise<Uint8Array>}
const Analyzer = (() => {
  const u16 = (b, o) => (b[o] << 8) | b[o + 1];
  const u32 = (b, o) => b[o] * 16777216 + ((b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]);
  const u64 = (b, o) => u32(b, o) * 4294967296 + u32(b, o + 4);
  const fcc = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
  const okFcc = t => /^[A-Za-z0-9 _\-©.]{4}$/.test(t);
  const TOP = new Set(["ftyp", "mdat", "moov", "free", "skip", "wide", "uuid", "meta", "pnot", "udta", "moof", "mfra", "styp", "sidx", "PICT", "junk"]);
  const CONT = new Set(["moov", "trak", "mdia", "minf", "stbl", "edts", "dinf", "udta"]);

  // Phan loai mot khoi byte: "ff" (xoa trong kieu flash), "zero" hoac "data"
  function classify(b) {
    const n = b.length;
    if (!n) return "data";
    let ff = 0, z = 0;
    const step = n > 65536 ? 4 : 1;
    let cnt = 0;
    for (let i = 0; i < n; i += step) {
      const v = b[i];
      if (v === 255) ff++; else if (v === 0) z++;
      cnt++;
    }
    if (ff >= cnt * 0.99) return "ff";
    if (z >= cnt * 0.99) return "zero";
    return "data";
  }

  async function walkTop(src) {
    const boxes = [];
    let pos = 0, problem = null;
    while (pos + 8 <= src.size) {
      const h = await src.read(pos, 16);
      let sz = u32(h, 0);
      const t = fcc(h, 4);
      let hl = 8;
      if (!okFcc(t) || (!TOP.has(t) && boxes.length === 0)) {
        const c = classify(await src.read(pos, Math.min(4096, src.size - pos)));
        problem = { at: pos, kind: c === "data" ? "rac" : c };
        break;
      }
      if (sz === 1) { sz = u64(h, 8); hl = 16; }
      else if (sz === 0) sz = src.size - pos;
      if (sz < hl) { problem = { at: pos, kind: "sai_kich_thuoc", type: t }; break; }
      const box = { type: t, at: pos, size: sz, hl };
      if (pos + sz > src.size) { box.cut = pos + sz - src.size; boxes.push(box); break; }
      boxes.push(box);
      pos += sz;
    }
    return { boxes, problem };
  }

  function parseMoov(m) {
    const out = { tracks: [] };
    const kids = (s, e, f) => {
      while (s + 8 <= e) {
        let sz = u32(m, s), hl = 8;
        if (sz === 1) { sz = u64(m, s + 8); hl = 16; }
        if (sz < 8 || s + sz > e) break;
        f(fcc(m, s + 4), s + hl, s + sz, s);
        s += sz;
      }
    };
    const walk = (s, e, tr) => kids(s, e, (t, b, end) => {
      if (t === "trak") { const nt = { codec: "?", kind: "?" }; out.tracks.push(nt); walk(b, end, nt); return; }
      if (CONT.has(t)) { walk(b, end, tr); return; }
      const v = m[b];
      if (t === "mvhd") { out.ts = u32(m, b + (v ? 20 : 12)); out.dur = v ? u64(m, b + 24) : u32(m, b + 16); }
      if (!tr) return;
      if (t === "mdhd") { tr.ts = u32(m, b + (v ? 20 : 12)); tr.dur = v ? u64(m, b + 24) : u32(m, b + 16); }
      if (t === "hdlr" && tr.kind === "?") tr.kind = fcc(m, b + 8); // MOV co them hdlr 'url '/'alis' trong minf
      if (t === "stsd") {
        const e0 = b + 8;
        tr.codec = fcc(m, e0 + 4);
        if (tr.kind === "vide") { tr.w = u16(m, e0 + 32); tr.h = u16(m, e0 + 34); }
        if (tr.kind === "soun") { tr.ch = u16(m, e0 + 24); tr.bits = u16(m, e0 + 26); tr.rate = u32(m, e0 + 32) / 65536; }
      }
      if (t === "stts") { const n = u32(m, b + 4); tr.stts = []; for (let i = 0; i < n; i++) tr.stts.push([u32(m, b + 8 + 8 * i), u32(m, b + 12 + 8 * i)]); }
      if (t === "stsc") { const n = u32(m, b + 4); tr.stsc = []; for (let i = 0; i < n; i++) tr.stsc.push([u32(m, b + 8 + 12 * i), u32(m, b + 12 + 12 * i)]); }
      if (t === "stsz") { tr.fixed = u32(m, b + 4); tr.count = u32(m, b + 8); if (!tr.fixed) { tr.sizes = new Array(tr.count); for (let i = 0; i < tr.count; i++) tr.sizes[i] = u32(m, b + 12 + 4 * i); } }
      if (t === "stco" || t === "co64") { const n = u32(m, b + 4); tr.co = new Array(n); for (let i = 0; i < n; i++) tr.co[i] = t === "co64" ? u64(m, b + 8 + 8 * i) : u32(m, b + 8 + 4 * i); }
      if (t === "stss") tr.keys = u32(m, b + 4);
    });
    walk(0, m.length, null);
    return out;
  }

  // Danh sach cum (chunk) cua track: [offset, so mau dau, so mau, do dai byte]
  function chunksOf(tr) {
    const res = [];
    if (!tr.co || !tr.stsc) return res;
    let sample = 0;
    for (let c = 0; c < tr.co.length; c++) {
      let spc = tr.stsc[0][1];
      for (const [first, n] of tr.stsc) if (c + 1 >= first) spc = n;
      let len = 0;
      if (tr.fixed) len = tr.fixed * spc;
      else for (let k = 0; k < spc && sample + k < tr.count; k++) len += tr.sizes[sample + k];
      res.push([tr.co[c], sample, spc, len]);
      sample += spc;
    }
    return res;
  }

  function sampleTimes(tr) {
    const t = [];
    let acc = 0;
    for (const [c, d] of tr.stts || []) for (let i = 0; i < c; i++) { t.push(acc); acc += d; }
    t.push(acc);
    return t;
  }

  function sonyMeta(text) {
    if (!text || text.indexOf("NonRealTimeMeta") < 0) return null;
    const g = (re) => { const x = text.match(re); return x ? x[1] : null; };
    return {
      model: g(/<Device[^>]*modelName="([^"]+)"/), serial: g(/<Device[^>]*serialNo="([^"]+)"/),
      lens: g(/<Lens[^>]*modelName="([^"]+)"/), created: g(/<CreationDate value="([^"]+)"/),
      updated: g(/lastUpdate="([^"]+)"/), codec: g(/videoCodec="([^"]+)"/), fps: g(/captureFps="([^"]+)"/),
      gamma: g(/CaptureGammaEquation" value="([^"]+)"/)
    };
  }
  const latin = b => { let s = ""; for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode.apply(null, b.subarray(i, i + 8192)); return s; };

  async function analyze(src, opts = {}) {
    const prog = opts.progress || (() => {});
    const R = { name: src.name, size: src.size, issues: [], notes: [] };
    if (src.size < 16) { R.issues.push({ lv: 3, t: "File rỗng hoặc quá nhỏ" }); R.level = 3; return R; }

    // 1. Cau truc
    prog(0.02, "Đọc cấu trúc");
    const top = await walkTop(src);
    R.boxes = top.boxes.map(b => ({ type: b.type, at: b.at, size: b.size, cut: b.cut || 0 }));
    const has = t => top.boxes.find(b => b.type === t);
    if (top.problem && top.problem.at === 0)
      R.issues.push({ lv: 3, t: top.problem.kind === "ff" ? "Phần đầu file bị xóa trống (byte FF)" : top.problem.kind === "zero" ? "Phần đầu file bị xóa trống (byte 00)" : "Phần đầu file không phải MP4/MOV hợp lệ" });
    else if (top.problem) R.issues.push({ lv: 2, t: "Cấu trúc file bị đứt tại " + fmtB(top.problem.at) });
    const mdat = has("mdat");
    if (mdat && mdat.cut) R.issues.push({ lv: 3, t: "File bị cắt cụt: thiếu " + fmtB(mdat.cut) + " dữ liệu cuối (ghi dở / copy dở)" });

    // 2. Chi muc moov
    let moovBox = has("moov");
    let mv = null;
    if (moovBox && !moovBox.cut) {
      const raw = await src.read(moovBox.at + moovBox.hl, moovBox.size - moovBox.hl);
      mv = parseMoov(raw);
    } else {
      R.issues.push({ lv: 3, t: "Mất chỉ mục (moov) – trình phát không đọc được file" });
    }

    // 3. Metadata Sony
    const tailLen = Math.min(src.size, 262144);
    const tail = await src.read(src.size - tailLen, tailLen);
    let meta = sonyMeta(latin(tail));
    if (!meta && has("meta")) { const mb = has("meta"); meta = sonyMeta(latin(await src.read(mb.at, Math.min(mb.size, 65536)))); }
    R.meta = meta;

    // 4. Kiem tra du lieu tung cum hinh
    if (mv) {
      const vt = mv.tracks.find(t => t.kind === "vide");
      const at = mv.tracks.find(t => t.kind === "soun");
      R.duration = mv.ts ? mv.dur / mv.ts : null;
      R.tracks = mv.tracks.map(t => ({ kind: t.kind, codec: t.codec, w: t.w, h: t.h, ch: t.ch, rate: t.rate, count: t.count }));
      if (vt) {
        const ch = chunksOf(vt), times = sampleTimes(vt);
        const ts = vt.ts || 1;
        let out = 0, bad = 0;
        const segs = [];
        const nal = vt.codec === "avc1" || vt.codec === "avc3" || vt.codec === "hvc1" || vt.codec === "hev1";
        for (let i = 0; i < ch.length; i++) {
          const [off, s0, n, len] = ch[i];
          let state = "ok";
          if (off + len > src.size) { state = "out"; out++; }
          else {
            const a = await src.read(off, 32);
            const midOff = off + Math.floor(len / 2);
            const b = await src.read(midOff, 32);
            const blank = classify(a) !== "data" || classify(b) !== "data";
            let badNal = false;
            if (nal && !blank) { const L = u32(a, 0); badNal = (a[4] & 0x80) !== 0 || L === 0 || L > (vt.fixed || (vt.sizes ? vt.sizes[s0] : len)); }
            if (blank) state = "blank"; else if (badNal) state = "bad";
          }
          if (state !== "ok") bad++;
          const t0 = times[s0] / ts, t1 = times[Math.min(s0 + n, times.length - 1)] / ts;
          const last = segs[segs.length - 1];
          if (last && last.state === state) last.t1 = t1; else segs.push({ state, t0, t1 });
          if (i % 64 === 0) { prog(0.05 + 0.35 * i / ch.length, "Kiểm tra dữ liệu hình"); if (opts.cancelled && opts.cancelled()) throw new Error("huy"); }
        }
        R.segments = segs;
        R.chunks = ch.length; R.badChunks = bad;
        R.playable = segs.filter(s => s.state === "ok").reduce((a, s) => a + s.t1 - s.t0, 0);
        const totalBytes = ch.reduce((a, c) => a + c[3], 0);
        R.bitrate = R.duration ? totalBytes * 8 / R.duration : null;
        if (out) R.issues.push({ lv: 3, t: "Chỉ mục trỏ ra ngoài file ở " + out + " cụm (file bị cắt cụt)" });
        if (bad - out > 0) R.issues.push({ lv: 3, t: "Dữ liệu hình bị xóa trống/hỏng ở " + (bad - out) + "/" + ch.length + " cụm" });
      }
      if (at && at.rate) R.audio = { ch: at.ch, bits: at.bits, rate: at.rate, codec: at.codec };
    }

    // 5. Ban do byte
    const cells = opts.cells || 240;
    const map = new Array(cells).fill(null).map(() => ({ ff: 0, zero: 0, data: 0 }));
    let tot = { ff: 0, zero: 0, data: 0 };
    if (opts.full) {
      const B = 8 << 20, sub = 1 << 20;
      for (let pos = 0; pos < src.size; pos += B) {
        const buf = await src.read(pos, Math.min(B, src.size - pos));
        for (let s = 0; s < buf.length; s += sub) {
          const part = buf.subarray(s, Math.min(s + sub, buf.length));
          const c = classify(part);
          const cell = Math.min(cells - 1, Math.floor((pos + s) / src.size * cells));
          map[cell][c] += part.length; tot[c] += part.length;
        }
        prog(0.4 + 0.6 * pos / src.size, "Quét toàn bộ file");
        if (opts.cancelled && opts.cancelled()) throw new Error("huy");
      }
    } else {
      const N = cells * 3;
      const len = Math.max(1, Math.min(65536, Math.floor(src.size / N))); // file nho: doc doan ngan hon
      for (let i = 0; i < N; i++) {
        const off = Math.floor((src.size - len) * i / Math.max(1, N - 1));
        const part = await src.read(Math.max(0, off), len);
        const c = classify(part);
        const cell = Math.min(cells - 1, Math.floor(off / src.size * cells));
        map[cell][c] += 1; tot[c] += 1;
        if (i % 30 === 0) { prog(0.4 + 0.6 * i / N, "Quét nhanh vùng dữ liệu"); if (opts.cancelled && opts.cancelled()) throw new Error("huy"); }
      }
    }
    R.full = !!opts.full;
    for (let i = 0; i < cells; i++) { // o khong co mau nao: lay theo o ben canh
      const m = map[i];
      if (!(m.ff + m.zero + m.data)) Object.assign(m, map[i > 0 ? i - 1 : Math.min(cells - 1, 1)]);
    }
    R.map = map.map(m => { const s = m.ff + m.zero + m.data || 1; return [+(m.data / s).toFixed(3), +(m.ff / s).toFixed(3), +(m.zero / s).toFixed(3)]; });
    const ts = tot.ff + tot.zero + tot.data || 1;
    R.dataPct = tot.data / ts; R.ffPct = tot.ff / ts; R.zeroPct = tot.zero / ts;
    if (!mv && R.ffPct + R.zeroPct > 0.01) R.issues.push({ lv: 3, t: "Khoảng " + pct(R.ffPct + R.zeroPct) + " dung lượng file là byte trống" });

    // 6. Dau hieu Sony XAVC (de khoi phuc khi mat chi muc)
    if (!mv) {
      // tim mau metadata rtmd cua Sony trong 8 MB dau file
      const head = await src.read(0, Math.min(src.size, 8 << 20));
      for (let i = 0; i + 32 <= head.length; i++) {
        if (head[i] === 0 && head[i + 1] === 0x1c && head[i + 2] === 1 && head[i + 3] === 0 &&
            head[i + 8] === 0xf0 && head[i + 9] === 1 && head[i + 28] === 6 && head[i + 29] === 0x0e &&
            head[i + 30] === 0x2b && head[i + 31] === 0x34) { R.sonyData = true; break; }
      }
      if (R.sonyData) R.notes.push("Phát hiện dữ liệu Sony XAVC còn đúng cấu trúc – có thể dựng lại chỉ mục bằng công cụ khoi_phuc_xavc.py và một file mẫu cùng máy.");
    }

    // 7. Ket luan
    const worst = R.issues.reduce((a, i) => Math.max(a, i.lv), 0);
    R.level = worst;
    if (!worst) R.notes.push("Cấu trúc và dữ liệu đều ổn. Nếu vẫn không phát được, hãy thử VLC hoặc DaVinci Resolve (một số trình phát không hỗ trợ H.264 4:2:2 10-bit).");
    if (mv && R.segments && R.badChunks && R.playable > 0) R.notes.push("Có thể cắt riêng các đoạn còn xem được (" + fmtT(R.playable) + ").");
    if ((R.ffPct > 0.02 || (R.badChunks && mv)) ) R.notes.push("Phần dữ liệu bị xóa trống không khôi phục được từ chính file này – chỉ còn cách tìm bản gốc trên thẻ, thẻ thứ hai, proxy hoặc bản sao khác.");
    prog(1, "Xong");
    return R;
  }

  function fmtB(n) { const u = ["B", "KB", "MB", "GB", "TB"]; let i = 0; while (n >= 1000 && i < 4) { n /= 1000; i++; } return String(i ? n.toFixed(n < 10 ? 2 : 1) : n).replace(".", ",") + " " + u[i]; }
  function fmtT(s) { s = Math.max(0, s); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = Math.floor(s % 60); return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(x).padStart(2, "0"); }
  function pct(x) { return x <= 0 ? "0%" : (x * 100).toFixed(x < 0.1 ? 1 : 0).replace(".", ",") + "%"; }
  return { analyze, classify, fmtB, fmtT, pct };
})();
if (typeof module !== "undefined") module.exports = Analyzer;
