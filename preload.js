const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktopPet", {
  startDrag(mouse) {
    ipcRenderer.send("pet-drag-start", mouse);
  },
  moveDrag(mouse) {
    ipcRenderer.send("pet-drag-move", mouse);
  },
  endDrag() {
    ipcRenderer.send("pet-drag-end");
  },
  readSettings() {
    return ipcRenderer.invoke("settings-read");
  },
  getVersion() {
    return ipcRenderer.invoke("app-version");
  },
  saveSettings(settings) {
    return ipcRenderer.invoke("settings-save", settings);
  },
  readSchedule() {
    return ipcRenderer.invoke("schedule-read");
  },
  saveSchedule(schedule) {
    return ipcRenderer.invoke("schedule-save", schedule);
  },
  addSchedule(item) {
    return ipcRenderer.invoke("schedule-add", item);
  },
  updateSchedule(item) {
    return ipcRenderer.invoke("schedule-update", item);
  },
  deleteSchedule(id) {
    return ipcRenderer.invoke("schedule-delete", id);
  },
  addScheduleWithAi(text) {
    return ipcRenderer.invoke("ai-schedule-add", text);
  },
  readExternalHtml(fileName) {
    return ipcRenderer.invoke("external-html-read", fileName);
  },
  onSettingsUpdated(callback) {
    ipcRenderer.on("desktop-pet-settings", (_event, settings) => callback(settings));
  },
  onScheduleUpdated(callback) {
    ipcRenderer.on("desktop-pet-schedule", (_event, schedule) => callback(schedule));
  },
  onSettingsPanelOpen(callback) {
    ipcRenderer.on("settings-panel-open", callback);
  },
  closeSettingsPanel() {
    ipcRenderer.send("settings-panel-close");
  },
  openTodayWidget() {
    ipcRenderer.send("today-widget-open-request");
  },
  closeTodayWidget() {
    ipcRenderer.send("today-widget-close");
  },
  onTodayWidgetOpen(callback) {
    ipcRenderer.on("today-widget-open", callback);
  },
  addDailyTodo(item) {
    return ipcRenderer.invoke("daily-todo-add", item);
  },
  deleteDailyTodo(id) {
    return ipcRenderer.invoke("daily-todo-delete", id);
  },
  readDailyTodos() {
    return ipcRenderer.invoke("daily-todo-read");
  },
  onDailyTodosUpdated(callback) {
    ipcRenderer.on("desktop-pet-daily-todos", (_event, dailyTodos) => callback(dailyTodos));
  },
  captureScreenHelp() {
    return ipcRenderer.invoke("ai-capture-help");
  },
  openAiChat() {
    ipcRenderer.send("ai-chat-open-request");
  },
  sendChatMessage(message, history) {
    return ipcRenderer.invoke("ai-chat-send", { message, history });
  },
  onUpdateReady(callback) {
    ipcRenderer.on("desktop-pet-update-ready", callback);
  }
});
