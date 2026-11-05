const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("jobAgent", {
  version: "1.4.0",
  platform: process.platform,
});
