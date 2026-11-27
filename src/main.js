"use strict";
const { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme } = require("electron");
const path = require("path");
const fs = require("fs");
const { Worker } = require("worker_threads");
const { defaultOutName } = require("./core/repair.js");

const REPO_URL = "https://github.com/vietcong69/Repair-file-";
let win = null;
const jobs = new Map();
let seq = 0;

function createWindow() {
  win = new BrowserWindow({
    width: 1180, height: 880, minWidth: 720, minHeight: 560,
    title: "Video Check",
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#0e1116" : "#ffffff",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true, nodeIntegration: false, sandbox: true
    }
  });
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
  // Không cho trang tự mở cửa sổ hay chuyển trang (ví dụ khi thả file vào sai chỗ)
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", e => e.preventDefault());
  win.on("closed", () => { win = null; pageReady = false; });
}

// File được mở bằng "Open with…", kéo lên biểu tượng app, hoặc truyền qua dòng lệnh
let pendingOpen = process.argv.slice(app.isPackaged ? 1 : 2).filter(a => !a.startsWith("-") && fs.existsSync(a) && fs.statSync(a).isFile());
let pageReady = false;
function flushOpen() {
  if (!win || !pageReady || !pendingOpen.length) return;
  win.webContents.send("open-files", pendingOpen);
  pendingOpen = [];
}
app.on("open-file", (e, p) => { e.preventDefault(); pendingOpen.push(p); flushOpen(); });

if (!app.requestSingleInstanceLock()) app.quit();
app.on("second-instance", (_e, argv) => {
  pendingOpen.push(...argv.slice(1).filter(a => !a.startsWith("-") && fs.existsSync(a) && fs.statSync(a).isFile()));
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); flushOpen(); }
});

app.whenReady().then(() => {
  createWindow();
  win.webContents.on("did-finish-load", () => { pageReady = true; flushOpen(); });
  app.on("activate", () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});
app.on("window-all-closed", () => {
  for (const j of jobs.values()) j.worker.terminate();
  if (process.platform !== "darwin") app.quit();
});

const send = (msg) => { if (win && !win.isDestroyed()) win.webContents.send("job-event", msg); };
const VIDEO_FILTERS = [
  { name: "Video", extensions: ["mp4", "MP4", "mov", "MOV", "m4v", "M4V"] },
  { name: "Tất cả file", extensions: ["*"] }
];

ipcMain.handle("pick-files", async (_e, { multi = false, title } = {}) => {
  const r = await dialog.showOpenDialog(win, {
    title, filters: VIDEO_FILTERS,
    properties: ["openFile", ...(multi ? ["multiSelections"] : [])]
  });
  return r.canceled ? [] : r.filePaths;
});

ipcMain.handle("pick-save", async (_e, { defaultPath } = {}) => {
  const r = await dialog.showSaveDialog(win, { title: "Lưu file khôi phục", defaultPath, filters: VIDEO_FILTERS });
  return r.canceled ? null : r.filePath;
});

ipcMain.handle("default-out", (_e, p) => (typeof p === "string" ? defaultOutName(p) : null));

ipcMain.handle("file-info", (_e, p) => {
  try {
    const st = fs.statSync(p);
    return st.isFile() ? { path: p, name: path.basename(p), size: st.size, exists: true } : null;
  } catch (_) { return { path: p, name: path.basename(p), exists: false }; }
});

ipcMain.handle("start-job", (_e, job) => {
  if (!job || !["check", "repair"].includes(job.type)) throw new Error("Loại việc không hợp lệ");
  const id = ++seq;
  const worker = new Worker(path.join(__dirname, "worker.js"), { workerData: job });
  jobs.set(id, { worker, job });
  worker.on("message", m => {
    send({ id, ...m });
    if (m.type === "done" || m.type === "error") jobs.delete(id);
  });
  worker.on("error", err => { send({ id, type: "error", message: String((err && err.message) || err) }); jobs.delete(id); });
  worker.on("exit", code => {
    if (jobs.has(id)) { jobs.delete(id); if (code !== 0) send({ id, type: "error", message: "Tiến trình xử lý dừng bất thường." }); }
  });
  return id;
});

ipcMain.handle("cancel-job", async (_e, id) => {
  const j = jobs.get(id);
  if (!j) return false;
  jobs.delete(id);
  await j.worker.terminate();
  if (j.job.type === "repair" && j.job.out) {
    try { fs.unlinkSync(j.job.out + ".partial"); } catch (_) { /* không có file tạm */ }
  }
  send({ id, type: "cancelled" });
  return true;
});

ipcMain.handle("reveal", (_e, p) => {
  if (typeof p === "string" && fs.existsSync(p)) shell.showItemInFolder(p);
});

ipcMain.handle("open-repo", () => shell.openExternal(require("../package.json").homepage || REPO_URL));

ipcMain.handle("app-info", () => ({ version: app.getVersion(), platform: process.platform }));
