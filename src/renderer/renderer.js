"use strict";
{
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const { fmtB, fmtT, pct } = Analyzer; // khai báo trong ../core/analyzer.js
const api = window.api;

// ---------- tab ----------
function showTab(name) {
  for (const t of ["check", "repair"]) {
    $("#t-" + t).setAttribute("aria-selected", String(t === name));
    $("#p-" + t).hidden = t !== name;
  }
}
$("#t-check").addEventListener("click", () => showTab("check"));
$("#t-repair").addEventListener("click", () => showTab("repair"));

// ---------- kiểm tra ----------
let items = []; // { id, path, name, size, r?, jobId?, f?, label? }
let queue = [], running = null, seq = 0;
const stateCls = { ok: "s-ok", blank: "s-blank", bad: "s-bad", out: "s-out" };
const stateTxt = { ok: "xem được", blank: "bị xóa trống", bad: "dữ liệu hỏng", out: "nằm ngoài file" };

function niceStep(d) { for (const s of [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200]) if (d / s <= 7) return s; return 14400; }
function ruler(d) {
  const st = niceStep(d), out = [];
  for (let t = 0, i = 0; t <= d + 1e-6; t += st, i++) {
    const p = t / d * 100;
    if (t > 0 && (p > 89 || d - t < st * 0.75)) break;
    out.push(`<span class="tick${i === 0 ? " first" : ""}${i % 2 ? " minor" : ""}" style="left:${p}%">${fmtT(t)}</span>`);
  }
  out.push(`<span class="tick last" style="left:100%">${fmtT(d)}</span>`);
  return out.join("");
}
function cellBg([d, f]) {
  const a = d * 100, b = (d + f) * 100;
  return `linear-gradient(to top,var(--ok) 0 ${a}%,var(--bad) ${a}% ${b}%,var(--zero) ${b}% 100%)`;
}
function headline(r) {
  if (!r.level && r.duration) return `Tốt, xem được trọn ${fmtT(r.duration)}`;
  if (r.segments && r.segments.length && r.duration) return r.playable > 0 ? `Chỉ xem được ${fmtT(r.playable)} trên ${fmtT(r.duration)}` : "Không còn đoạn nào xem được";
  if (r.sonyData) return `Mất chỉ mục, còn ${pct(r.dataPct)} dữ liệu khôi phục được`;
  if (r.level) return r.dataPct != null ? `Mất chỉ mục, còn ${pct(r.dataPct)} dữ liệu` : "Không đọc được file";
  return "Tốt";
}
function codecName(m) {
  if (!m || !m.codec) return null;
  const mb = (m.codec.match(/^(?:AVC|HEVC)(\d+)/) || [])[1];
  const fam = /HEVC/.test(m.codec) ? "H.265" : /AVC/.test(m.codec) ? "H.264" : m.codec;
  const cs = /422/.test(m.codec) ? "4:2:2 10-bit" : /420/.test(m.codec) ? "4:2:0" : "";
  return [fam, cs, mb ? mb + " Mbps" : ""].filter(Boolean).join(", ");
}
const dt = (s) => { const m = s && s.match(/(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)/); return m ? `${m[3]}/${m[2]}/${m[1]} ${m[4]}:${m[5]}:${m[6]}` : s; };

function card(it) {
  if (!it.r) {
    const w = ((it.f || 0) * 100).toFixed(1);
    return `<article class="clip" id="c${it.id}"><div class="chead"><div><h3>${esc(it.name)}</h3><div class="spec">${esc(fmtB(it.size || 0))}</div></div><button data-cancel="${it.id}">Hủy</button></div>
      <div class="prog"><i id="p${it.id}" style="width:${w}%"></i></div><div class="small" id="l${it.id}">${esc(it.label || "Đang chờ…")}</div></article>`;
  }
  const r = it.r, v = (r.tracks || []).find((t) => t.kind === "vide"), m = r.meta;
  const spec = [fmtB(r.size), v && v.w ? `${v.w}×${v.h}` : null, v ? v.codec : null, m && m.fps ? m.fps : null].filter(Boolean).join(" · ");
  const badge = !r.level ? "Tốt" : r.level === 2 ? "Có lỗi nhẹ" : "Hỏng";
  const segs = r.segments && r.segments.length && r.duration
    ? r.segments.map((s) => `<div class="seg ${stateCls[s.state]}" title="${fmtT(s.t0)}–${fmtT(s.t1)} ${stateTxt[s.state]}" style="left:${s.t0 / r.duration * 100}%;width:${Math.max(0.25, (s.t1 - s.t0) / r.duration * 100)}%"></div>`).join("")
    : `<div class="noidx">Không có chỉ mục nên không dựng được dòng thời gian. Xem bản đồ dữ liệu bên dưới.</div>`;
  const ranges = r.segments && r.segments.length > 1
    ? `<div class="ranges">${r.segments.map((s) => `<span><i class="dot ${stateCls[s.state]}"></i>${fmtT(s.t0)}–${fmtT(s.t1)} ${stateTxt[s.state]}</span>`).join("")}</div>` : `<div style="height:10px"></div>`;
  const figs = [
    r.duration ? [fmtT(r.duration), "Thời lượng theo chỉ mục"] : ["—", "Thời lượng (mất chỉ mục)"],
    r.duration ? [fmtT(r.playable || 0), "Còn xem được"] : null,
    r.dataPct != null ? [pct(r.dataPct), r.full ? "Dữ liệu thật (quét kỹ)" : "Dữ liệu thật (quét nhanh)"] : null,
    r.dataPct != null ? [pct((r.ffPct || 0) + (r.zeroPct || 0)), "Byte trống"] : null,
    r.bitrate ? [Math.round(r.bitrate / 1e6) + " Mbps", "Bitrate hình"] : null
  ].filter(Boolean).map(([b, s]) => `<div class="fig"><b>${esc(b)}</b><span>${esc(s)}</span></div>`).join("");
  const rows = [
    m && ["Máy quay", `${m.model || ""}${m.serial ? " (số seri " + m.serial + ")" : ""}`],
    m && m.lens && ["Ống kính", m.lens],
    m && m.created && ["Thời gian quay", `${dt(m.created)}${m.updated ? " → " + dt(m.updated).slice(11) : ""}`],
    m && ["Định dạng ghi", `${codecName(m) || ""}${m.gamma ? " · " + m.gamma : ""}`],
    v && ["Hình", `${v.codec} ${v.w || "?"}×${v.h || "?"}, ${v.count || "?"} khung`],
    r.audio && ["Âm thanh", `${r.audio.ch} kênh, ${r.audio.bits}-bit, ${r.audio.rate / 1000} kHz (${r.audio.codec})`],
    r.chunks && ["Cụm dữ liệu hình", `${r.chunks - r.badChunks}/${r.chunks} cụm tốt`],
    ["Đường dẫn", it.path],
    ["Kích thước", `${fmtB(r.size)} (${r.size.toLocaleString("vi-VN")} byte)`],
    r.boxes && r.boxes.length && ["Cấu trúc", r.boxes.map((b) => b.type + (b.cut ? " (cụt)" : "")).join(" → ")]
  ].filter(Boolean);
  return `<article class="clip lv${r.level || 0}" id="c${it.id}">
    <div class="chead"><div><h3>${esc(r.name)}</h3><div class="spec">${esc(spec)}</div></div><span class="badge">${badge}</span></div>
    <p class="verdict">${esc(headline(r))}</p>
    <div class="track">${segs}</div>
    ${r.duration ? `<div class="ruler">${ruler(r.duration)}</div>` : ""}
    ${ranges}
    ${r.map && r.map.length ? `<div class="bytes" title="Bản đồ dữ liệu theo vị trí trong file">${r.map.map((c) => `<i style="background:${cellBg(c)}"></i>`).join("")}</div>
    <div class="cap"><span>Vị trí trong file: đầu</span><span>cuối (${esc(fmtB(r.size))})</span></div>` : ""}
    <div class="figs">${figs}</div>
    <div class="two">
      <div><h4>Lỗi phát hiện</h4>${r.issues.length ? `<ul>${r.issues.map((i) => `<li>${esc(i.t)}</li>`).join("")}</ul>` : '<p style="margin:0">Không thấy lỗi.</p>'}</div>
      <div><h4>Nên làm gì</h4><ul>${r.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul></div>
    </div>
    <details><summary>Thông tin máy quay và kỹ thuật</summary><table><tbody>${rows.map(([a, b]) => `<tr><td>${esc(a)}</td><td>${esc(b)}</td></tr>`).join("")}</tbody></table></details>
    <div class="acts">
      ${r.sonyData ? `<button class="pri" data-fix="${it.id}">Khôi phục file này…</button>` : ""}
      <button data-reveal="${it.id}">Hiện trong thư mục</button>
      <button data-copy="${it.id}">Sao chép báo cáo</button>
      <button data-del="${it.id}">Bỏ khỏi danh sách</button>
      <span class="small" id="m${it.id}" role="status"></span>
    </div>
  </article>`;
}
function render() {
  $("#list").innerHTML = items.length ? items.map(card).join("")
    : `<div class="empty">Chưa có file nào. Thả file video vào ô phía trên hoặc bấm “Chọn file…”.</div>`;
  const n = items.filter((i) => i.r).length;
  $("#count").textContent = n ? `Kết quả (${n} file)` : "Kết quả";
}
function report(r) {
  const L = [`File: ${r.name}`, `Kết luận: ${headline(r)}`, `Dung lượng: ${fmtB(r.size)}`];
  if (r.duration) L.push(`Thời lượng: ${fmtT(r.duration)}, xem được: ${fmtT(r.playable || 0)}`);
  if (r.dataPct != null) L.push(`Dữ liệu thật: ${pct(r.dataPct)}, byte trống: ${pct((r.ffPct || 0) + (r.zeroPct || 0))} (${r.full ? "quét kỹ" : "quét nhanh"})`);
  if (r.segments && r.segments.length) L.push("Các đoạn: " + r.segments.map((s) => `${fmtT(s.t0)}–${fmtT(s.t1)} ${stateTxt[s.state]}`).join("; "));
  if (r.meta) L.push(`Máy quay: ${r.meta.model || ""} ${r.meta.serial || ""}, quay lúc ${dt(r.meta.created)}`);
  r.issues.forEach((i) => L.push("Lỗi: " + i.t));
  r.notes.forEach((n) => L.push("Nên làm: " + n));
  return L.join("\n");
}

async function addPaths(paths) {
  const full = $("#full").checked;
  for (const p of paths) {
    const info = await api.fileInfo(p);
    if (!info || !info.exists) continue;
    const it = { id: ++seq, path: p, name: info.name, size: info.size };
    items.unshift(it);
    queue.push({ it, full });
  }
  render();
  next();
}
async function next() {
  if (running || !queue.length) return;
  const { it, full } = queue.shift();
  running = it;
  it.jobId = await api.start({ type: "check", file: it.path, full });
}

// ---------- khôi phục ----------
const rep = { ref: null, broken: null, out: null, outAuto: true, jobId: null, result: null };
async function setRep(key, p) {
  if (key === "out") { rep.out = p; rep.outAuto = false; }
  else {
    rep[key] = p;
    if (key === "broken" && rep.outAuto) rep.out = await api.defaultOut(p);
  }
  for (const k of ["ref", "broken", "out"]) {
    $("#" + k + "-path").textContent = rep[k] || (k === "out" ? "Tự đặt cạnh file hỏng" : "Chưa chọn");
    $("#f-" + k).classList.toggle("set", !!rep[k]);
  }
  const same = rep.ref && rep.broken && rep.ref === rep.broken;
  $("#go").disabled = !rep.ref || !rep.broken || !rep.out || !!rep.jobId || same;
  $("#go-hint").textContent = same ? "File mẫu và file hỏng phải là hai file khác nhau."
    : rep.jobId ? "Đang chạy…" : (!rep.ref || !rep.broken) ? "Chọn file mẫu và file hỏng để bắt đầu." : "File gốc chỉ được đọc, kết quả ghi ra file mới.";
}
document.querySelectorAll("[data-pick]").forEach((b) => b.addEventListener("click", async () => {
  const key = b.dataset.pick;
  if (key === "out") { const p = await api.pickSave({ defaultPath: rep.out || undefined }); if (p) setRep("out", p); return; }
  const [p] = await api.pickFiles({ title: key === "ref" ? "Chọn file mẫu (còn tốt)" : "Chọn file hỏng" });
  if (p) setRep(key, p);
}));
$("#go").addEventListener("click", async () => {
  $("#job-idle").hidden = true; $("#job-run").hidden = false; $("#job-done").hidden = true;
  $("#job-cancel").hidden = false; $("#job-log").textContent = ""; $("#job-bar").style.width = "0";
  $("#job-title").textContent = "Đang khôi phục…"; $("#job-title").className = "verdict";
  rep.result = null;
  rep.jobId = await api.start({ type: "repair", ref: rep.ref, broken: rep.broken, out: rep.out });
  setRep("ref", rep.ref);
});
$("#job-cancel").addEventListener("click", () => { if (rep.jobId) api.cancel(rep.jobId); });
$("#job-reveal").addEventListener("click", () => rep.result && api.reveal(rep.result.outFile));
$("#job-check").addEventListener("click", () => { if (rep.result) { showTab("check"); addPaths([rep.result.outFile]); } });
function logLine(t) { const el = $("#job-log"); el.textContent += t + "\n"; el.scrollTop = el.scrollHeight; }

// ---------- sự kiện từ tiến trình xử lý ----------
api.onJob((m) => {
  if (m.id === rep.jobId) {
    if (m.type === "progress") { $("#job-bar").style.width = (m.f * 100).toFixed(1) + "%"; $("#job-label").textContent = m.label; }
    else if (m.type === "log") logLine(m.text);
    else {
      rep.jobId = null; $("#job-cancel").hidden = true;
      if (m.type === "done") {
        rep.result = m.result;
        $("#job-bar").style.width = "100%";
        $("#job-title").textContent = `Xong: khôi phục được ${fmtT(m.result.seconds)}`;
        $("#job-title").className = "verdict ok-text";
        $("#job-label").textContent = `${m.result.frames} khung hình, bỏ qua ${fmtB(m.result.skippedBytes)} dữ liệu hỏng`;
        $("#job-done").hidden = false;
      } else {
        $("#job-title").textContent = m.type === "cancelled" ? "Đã hủy" : "Không khôi phục được";
        $("#job-title").className = "verdict bad-text";
        $("#job-label").textContent = m.type === "cancelled" ? "File tạm đã được xóa. File gốc không thay đổi." : m.message;
      }
      setRep("ref", rep.ref);
    }
    return;
  }
  const it = items.find((i) => i.jobId === m.id);
  if (!it) return;
  if (m.type === "progress") {
    it.f = m.f; it.label = `${m.label}… ${Math.round(m.f * 100)}%`;
    const p = document.getElementById("p" + it.id), l = document.getElementById("l" + it.id);
    if (p) p.style.width = (m.f * 100).toFixed(1) + "%";
    if (l) l.textContent = it.label;
    return;
  }
  if (m.type === "done") it.r = m.result;
  else if (m.type === "cancelled") items = items.filter((i) => i !== it);
  else it.r = { name: it.name, size: it.size || 0, level: 3, issues: [{ lv: 3, t: "Không đọc được file: " + m.message }], notes: ["Kiểm tra file có đang được copy hoặc nằm trên ổ đã rút ra không."], map: [] };
  if (running === it) running = null;
  render();
  next();
});

// ---------- nút trên từng thẻ ----------
$("#list").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  const id = +(b.dataset.cancel || b.dataset.del || b.dataset.copy || b.dataset.reveal || b.dataset.fix);
  const it = items.find((i) => i.id === id);
  if (!it) return;
  if (b.dataset.cancel) {
    const qi = queue.findIndex((q) => q.it === it);
    if (qi >= 0) { queue.splice(qi, 1); items = items.filter((i) => i !== it); render(); }
    else if (it.jobId) api.cancel(it.jobId);
  }
  if (b.dataset.del) { items = items.filter((i) => i !== it); render(); }
  if (b.dataset.reveal) api.reveal(it.path);
  if (b.dataset.fix) { setRep("broken", it.path); showTab("repair"); }
  if (b.dataset.copy) {
    const msg = document.getElementById("m" + it.id);
    navigator.clipboard.writeText(report(it.r)).then(() => { msg.textContent = "Đã sao chép."; }, () => { msg.textContent = "Không sao chép được."; });
  }
});

// ---------- kéo thả ----------
const filesFrom = (e) => [...((e.dataTransfer && e.dataTransfer.files) || [])].map((f) => api.pathFor(f)).filter(Boolean);
document.addEventListener("dragover", (e) => {
  e.preventDefault();
  const field = e.target.closest && e.target.closest(".field");
  document.querySelectorAll(".over").forEach((x) => { if (x !== field) x.classList.remove("over"); });
  if (!$("#p-check").hidden) $("#drop").classList.add("over");
  else if (field && field.dataset.key !== "out") field.classList.add("over");
});
document.addEventListener("dragleave", (e) => { if (!e.relatedTarget) document.querySelectorAll(".over").forEach((x) => x.classList.remove("over")); });
document.addEventListener("drop", (e) => {
  e.preventDefault();
  document.querySelectorAll(".over").forEach((x) => x.classList.remove("over"));
  const paths = filesFrom(e);
  if (!paths.length) return;
  if (!$("#p-check").hidden) { addPaths(paths); return; }
  const field = e.target.closest && e.target.closest(".field");
  if (field && field.dataset.key !== "out") setRep(field.dataset.key, paths[0]);
  else if (!rep.broken) setRep("broken", paths[0]);
  else if (!rep.ref) setRep("ref", paths[0]);
});

$("#pick").addEventListener("click", async () => { const p = await api.pickFiles({ multi: true, title: "Chọn file video cần kiểm tra" }); if (p.length) addPaths(p); });
try { $("#full").checked = localStorage.getItem("vc-full") === "1"; } catch (_) { /* bỏ qua */ }
$("#full").addEventListener("change", (e) => { try { localStorage.setItem("vc-full", e.target.checked ? "1" : "0"); } catch (_) { /* bỏ qua */ } });
$("#repo").addEventListener("click", () => api.openRepo());
api.onOpenFiles((paths) => { showTab("check"); addPaths(paths); });
api.info().then((i) => { $("#ver").textContent = `Video Check ${i.version} · mã nguồn mở, giấy phép MIT`; });
render();
setRep("ref", null);
}
