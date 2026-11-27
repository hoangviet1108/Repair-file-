"use strict";
// Cầu nối an toàn giữa giao diện và phần xử lý file (giao diện không truy cập file trực tiếp).
const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("api", {
  pickFiles: (opts) => ipcRenderer.invoke("pick-files", opts),
  pickSave: (opts) => ipcRenderer.invoke("pick-save", opts),
  defaultOut: (p) => ipcRenderer.invoke("default-out", p),
  fileInfo: (p) => ipcRenderer.invoke("file-info", p),
  start: (job) => ipcRenderer.invoke("start-job", job),
  cancel: (id) => ipcRenderer.invoke("cancel-job", id),
  reveal: (p) => ipcRenderer.invoke("reveal", p),
  openRepo: () => ipcRenderer.invoke("open-repo"),
  openUrl: (url) => ipcRenderer.invoke("open-url", url),
  updateCheck: (opts) => ipcRenderer.invoke("update-check", opts),
  updateSkip: (version) => ipcRenderer.invoke("update-skip", version),
  updateSettings: (patch) => ipcRenderer.invoke("update-settings", patch),
  info: () => ipcRenderer.invoke("app-info"),
  pathFor: (file) => webUtils.getPathForFile(file),
  onOpenFiles: (cb) => ipcRenderer.on("open-files", (_e, paths) => cb(paths)),
  onJob: (cb) => {
    const h = (_e, m) => cb(m);
    ipcRenderer.on("job-event", h);
    return () => ipcRenderer.removeListener("job-event", h);
  }
});
