const path = require("path");
const fs = require("fs");
const { app, BrowserWindow, Menu, ipcMain, desktopCapturer, screen } = require("electron");
const { autoUpdater } = require("electron-updater");

const dragOffsets = new Map();
const settingsPath = path.join(__dirname, "settings.json");
const schedulePath = path.join(__dirname, "schedule.json");

let petWin = null;
let calendarWin = null;
let dailyWin = null;
let aiChatWin = null;

const defaultSettings = {
  bubbleDurationMs: 1200,
  alarmDurationMs: 6000,
  pet: {
    type: "emoji",
    emoji: "🙂",
    image: "pet.gif",
    externalHtmlFile: "external-pet.html"
  },
  ai: {
    enabled: false,
    apiKey: "",
    endpoint: "https://api.openai.com/v1/chat/completions",
    model: "gpt-4o-mini"
  },
  sync: {
    enabled: false,
    apiUrl: "",
    apiToken: ""
  },
  alarms: [],
  dailyTodos: []
};

function readJson(filePath, fallback) {
  try {
    return { ...fallback, ...JSON.parse(fs.readFileSync(filePath, "utf8")) };
  } catch {
    return fallback;
  }
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
}

function localDate() {
  const now = new Date();
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0")
  ].join("-");
}

function readSettings() {
  const settings = readJson(settingsPath, defaultSettings);
  return {
    ...defaultSettings,
    ...settings,
    pet: { ...defaultSettings.pet, ...(settings.pet || {}) },
    ai: { ...defaultSettings.ai, ...(settings.ai || {}) },
    sync: { ...defaultSettings.sync, ...(settings.sync || {}) },
    alarms: Array.isArray(settings.alarms) ? settings.alarms : [],
    dailyTodos: Array.isArray(settings.dailyTodos) ? settings.dailyTodos : []
  };
}

function readScheduleLocal() {
  try {
    const data = JSON.parse(fs.readFileSync(schedulePath, "utf8"));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function saveScheduleLocal(schedule) {
  writeJson(schedulePath, schedule);
  return schedule;
}

function isSyncEnabled(settings) {
  return Boolean(settings.sync.enabled && settings.sync.apiUrl && settings.sync.apiToken);
}

async function syncApi(settings, path, options = {}) {
  const base = settings.sync.apiUrl.replace(/\/$/, "");
  const response = await fetch(base + path, {
    ...options,
    headers: {
      Authorization: `Bearer ${settings.sync.apiToken}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `Sync request failed (${response.status})`);
  }

  if (response.status === 204) {
    return null;
  }

  return response.json();
}

async function getScheduleItems() {
  const settings = readSettings();
  if (isSyncEnabled(settings)) {
    return syncApi(settings, "/todos");
  }
  return readScheduleLocal();
}

async function createScheduleItem(item) {
  const settings = readSettings();
  if (isSyncEnabled(settings)) {
    return syncApi(settings, "/todos", { method: "POST", body: JSON.stringify(item) });
  }

  const schedule = readScheduleLocal();
  const nextItem = {
    id: item.id || `${Date.now()}`,
    date: item.date || localDate(),
    time: item.time || "",
    title: item.title || "새 할일",
    memo: item.memo || "",
    done: false
  };
  saveScheduleLocal([...schedule, nextItem]);
  return nextItem;
}

async function updateScheduleItem(id, patch) {
  const settings = readSettings();
  if (isSyncEnabled(settings)) {
    return syncApi(settings, `/todos/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
  }

  const schedule = readScheduleLocal();
  const index = schedule.findIndex((next) => next.id === id);
  if (index === -1) {
    throw new Error("Schedule item not found.");
  }

  const updatedItem = {
    ...schedule[index],
    date: patch.date || schedule[index].date,
    time: patch.time ?? schedule[index].time,
    title: patch.title || schedule[index].title,
    memo: patch.memo ?? schedule[index].memo,
    done: typeof patch.done === "boolean" ? patch.done : Boolean(schedule[index].done)
  };

  schedule[index] = updatedItem;
  saveScheduleLocal(schedule);
  return updatedItem;
}

async function deleteScheduleItem(id) {
  const settings = readSettings();
  if (isSyncEnabled(settings)) {
    await syncApi(settings, `/todos/${id}`, { method: "DELETE" });
    return;
  }

  saveScheduleLocal(readScheduleLocal().filter((item) => item.id !== id));
}

async function getDailyTemplates() {
  const settings = readSettings();
  if (isSyncEnabled(settings)) {
    return syncApi(settings, "/daily");
  }
  return settings.dailyTodos;
}

async function createDailyTemplate(input) {
  const settings = readSettings();
  const title = (input && input.title) || "새 데일리 할일";
  const time = (input && input.time) || "";

  if (isSyncEnabled(settings)) {
    return syncApi(settings, "/daily", { method: "POST", body: JSON.stringify({ title, time }) });
  }

  const nextDaily = { id: `${Date.now()}`, title, time };
  writeJson(settingsPath, { ...settings, dailyTodos: [...settings.dailyTodos, nextDaily] });
  return nextDaily;
}

async function deleteDailyTemplate(id) {
  const settings = readSettings();
  if (isSyncEnabled(settings)) {
    await syncApi(settings, `/daily/${id}`, { method: "DELETE" });
    return;
  }

  writeJson(settingsPath, { ...settings, dailyTodos: settings.dailyTodos.filter((daily) => daily.id !== id) });
}

function sendSettings(win) {
  win.webContents.send("desktop-pet-settings", readSettings());
}

function broadcastSettings() {
  for (const win of [petWin, dailyWin]) {
    if (win && !win.isDestroyed()) {
      sendSettings(win);
    }
  }
}

async function broadcastSchedule() {
  let schedule;
  try {
    schedule = await getScheduleItems();
  } catch (err) {
    console.error("Failed to load schedule:", err.message);
    return;
  }

  for (const win of [petWin, calendarWin]) {
    if (win && !win.isDestroyed()) {
      win.webContents.send("desktop-pet-schedule", schedule);
    }
  }
}

async function broadcastDailyTemplates() {
  let templates;
  try {
    templates = await getDailyTemplates();
  } catch (err) {
    console.error("Failed to load daily templates:", err.message);
    return;
  }

  if (dailyWin && !dailyWin.isDestroyed()) {
    dailyWin.webContents.send("desktop-pet-daily-todos", templates);
  }
}

async function ensureDailyTodosForToday() {
  const settings = readSettings();

  if (isSyncEnabled(settings)) {
    try {
      await syncApi(settings, "/daily/instantiate", { method: "POST" });
      await broadcastSchedule();
    } catch (err) {
      console.error("Daily instantiate sync failed:", err.message);
    }
    return;
  }

  if (!settings.dailyTodos.length) {
    return;
  }

  const today = localDate();
  const schedule = readScheduleLocal();
  const existingDailyIds = new Set(
    schedule.filter((item) => item.date === today && item.dailyId).map((item) => item.dailyId)
  );

  const newItems = settings.dailyTodos
    .filter((daily) => !existingDailyIds.has(daily.id))
    .map((daily) => ({
      id: `${Date.now()}-${daily.id}`,
      date: today,
      time: daily.time || "",
      title: daily.title,
      memo: "",
      done: false,
      dailyId: daily.id
    }));

  if (newItems.length) {
    saveScheduleLocal([...schedule, ...newItems]);
    await broadcastSchedule();
  }
}

async function requestAiCompletion(settings, messages) {
  const response = await fetch(settings.ai.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${settings.ai.apiKey}`
    },
    body: JSON.stringify({
      model: settings.ai.model,
      temperature: 0.4,
      messages
    })
  });

  if (!response.ok) {
    throw new Error(`AI request failed: ${response.status}`);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content || "";
}

async function captureScreenDataUrl() {
  const primaryDisplay = screen.getPrimaryDisplay();
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: {
      width: Math.round(primaryDisplay.size.width * primaryDisplay.scaleFactor),
      height: Math.round(primaryDisplay.size.height * primaryDisplay.scaleFactor)
    }
  });

  if (!sources.length) {
    throw new Error("화면을 캡처할 수 없습니다.");
  }

  return sources[0].thumbnail.toDataURL();
}

function openSettings(win) {
  win.setSize(420, 560);
  win.webContents.send("settings-panel-open");
}

function closeSettings(win) {
  win.setSize(240, 240);
  win.webContents.send("settings-panel-close");
}

function openTodayWidget(win) {
  win.setSize(300, 380);
  win.webContents.send("today-widget-open");
}

function closeTodayWidget(win) {
  win.setSize(240, 240);
}

function openCalendar() {
  if (calendarWin && !calendarWin.isDestroyed()) {
    calendarWin.focus();
    return;
  }

  calendarWin = new BrowserWindow({
    width: 640,
    height: 720,
    minWidth: 480,
    minHeight: 560,
    title: "할일 캘린더",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  calendarWin.setMenuBarVisibility(false);
  calendarWin.loadFile("calendar.html");

  calendarWin.webContents.on("did-finish-load", () => {
    broadcastSchedule();
  });

  calendarWin.on("closed", () => {
    calendarWin = null;
  });
}

function openDailyTodos() {
  if (dailyWin && !dailyWin.isDestroyed()) {
    dailyWin.focus();
    return;
  }

  dailyWin = new BrowserWindow({
    width: 360,
    height: 480,
    minWidth: 300,
    minHeight: 360,
    title: "데일리 할일",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  dailyWin.setMenuBarVisibility(false);
  dailyWin.loadFile("daily.html");

  dailyWin.webContents.on("did-finish-load", () => {
    sendSettings(dailyWin);
    broadcastDailyTemplates();
  });

  dailyWin.on("closed", () => {
    dailyWin = null;
  });
}

function openAiChat() {
  if (aiChatWin && !aiChatWin.isDestroyed()) {
    aiChatWin.focus();
    return;
  }

  aiChatWin = new BrowserWindow({
    width: 360,
    height: 520,
    minWidth: 300,
    minHeight: 400,
    title: "AI와 대화",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  aiChatWin.setMenuBarVisibility(false);
  aiChatWin.loadFile("ai-chat.html");

  aiChatWin.on("closed", () => {
    aiChatWin = null;
  });
}

function setupAutoUpdater() {
  if (!app.isPackaged) {
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("update-downloaded", () => {
    if (petWin && !petWin.isDestroyed()) {
      petWin.webContents.send("desktop-pet-update-ready");
    }
  });

  autoUpdater.on("error", (err) => {
    console.error("Auto-update failed:", err.message);
  });

  autoUpdater.checkForUpdates().catch((err) => {
    console.error("Auto-update check failed:", err.message);
  });

  setInterval(() => {
    autoUpdater.checkForUpdates().catch((err) => {
      console.error("Auto-update check failed:", err.message);
    });
  }, 60 * 60 * 1000);
}

function createWindow() {
  const win = new BrowserWindow({
    width: 240,
    height: 240,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  petWin = win;

  win.setAlwaysOnTop(true, "screen-saver");

  win.loadFile("pet.html");

  win.webContents.on("did-finish-load", () => {
    sendSettings(win);
    broadcastSchedule();
  });

  win.on("blur", () => {
    if (win.isAlwaysOnTop()) {
      win.setAlwaysOnTop(true, "screen-saver");
    }
  });

  win.webContents.on("context-menu", () => {
    const menu = Menu.buildFromTemplate([
      { label: "설정 열기", click: () => openSettings(win) },
      { label: "할일 캘린더 열기", click: () => openCalendar() },
      { label: "데일리 할일 관리", click: () => openDailyTodos() },
      {
        label: "항상 위",
        type: "checkbox",
        checked: win.isAlwaysOnTop(),
        click: (item) => win.setAlwaysOnTop(item.checked, "screen-saver")
      },
      { type: "separator" },
      { label: "종료", click: () => app.quit() }
    ]);

    menu.popup({ window: win });
  });
}

app.whenReady().then(() => {
  createWindow();
  setupAutoUpdater();
  ensureDailyTodosForToday();
  setInterval(ensureDailyTodosForToday, 5 * 60 * 1000);

  setInterval(() => {
    const settings = readSettings();
    if (isSyncEnabled(settings)) {
      broadcastSchedule();
    }
  }, 30 * 1000);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

ipcMain.on("pet-drag-start", (event, mouse) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) {
    return;
  }

  const [x, y] = win.getPosition();
  dragOffsets.set(event.sender.id, {
    x: mouse.x - x,
    y: mouse.y - y
  });
});

ipcMain.on("pet-drag-move", (event, mouse) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const offset = dragOffsets.get(event.sender.id);
  if (!win || !offset) {
    return;
  }

  win.setPosition(Math.round(mouse.x - offset.x), Math.round(mouse.y - offset.y));
});

ipcMain.on("pet-drag-end", (event) => {
  dragOffsets.delete(event.sender.id);
});

ipcMain.on("settings-panel-close", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) {
    closeSettings(win);
  }
});

ipcMain.on("today-widget-open-request", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) {
    openTodayWidget(win);
  }
});

ipcMain.on("today-widget-close", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) {
    closeTodayWidget(win);
  }
});

ipcMain.handle("settings-read", () => readSettings());

ipcMain.handle("app-version", () => app.getVersion());

ipcMain.handle("settings-save", (event, nextSettings) => {
  const currentSettings = readSettings();
  const mergedSettings = {
    ...currentSettings,
    ...nextSettings,
    pet: { ...currentSettings.pet, ...(nextSettings.pet || {}) },
    ai: { ...currentSettings.ai, ...(nextSettings.ai || {}) },
    alarms: Array.isArray(nextSettings.alarms) ? nextSettings.alarms : currentSettings.alarms,
    dailyTodos: Array.isArray(nextSettings.dailyTodos) ? nextSettings.dailyTodos : currentSettings.dailyTodos
  };

  writeJson(settingsPath, mergedSettings);
  broadcastSettings();

  return mergedSettings;
});

ipcMain.handle("daily-todo-read", () => getDailyTemplates());

ipcMain.handle("daily-todo-add", async (event, item) => {
  const created = await createDailyTemplate(item);
  broadcastDailyTemplates();
  broadcastSettings();
  await ensureDailyTodosForToday();
  return created;
});

ipcMain.handle("daily-todo-delete", async (event, id) => {
  await deleteDailyTemplate(id);
  broadcastDailyTemplates();
  broadcastSettings();
  return getDailyTemplates();
});

ipcMain.handle("schedule-read", () => getScheduleItems());

ipcMain.handle("schedule-save", (event, schedule) => {
  const settings = readSettings();
  if (isSyncEnabled(settings)) {
    throw new Error("Bulk save is not supported in sync mode.");
  }

  const savedSchedule = saveScheduleLocal(Array.isArray(schedule) ? schedule : []);
  broadcastSchedule();
  return savedSchedule;
});

ipcMain.handle("schedule-add", async (event, item) => {
  const nextItem = await createScheduleItem(item);
  broadcastSchedule();
  return nextItem;
});

ipcMain.handle("schedule-update", async (event, item) => {
  if (!item || !item.id) {
    throw new Error("Schedule item id is required.");
  }

  const updatedItem = await updateScheduleItem(item.id, item);
  broadcastSchedule();

  return updatedItem;
});

ipcMain.handle("schedule-delete", async (event, id) => {
  await deleteScheduleItem(id);
  const schedule = await getScheduleItems();
  broadcastSchedule();
  return schedule;
});

ipcMain.handle("external-html-read", (_event, fileName) => {
  const safeName = path.basename(fileName || "");
  if (!safeName) {
    return "";
  }

  try {
    return fs.readFileSync(path.join(__dirname, safeName), "utf8");
  } catch {
    return "";
  }
});

ipcMain.handle("ai-schedule-add", async (event, text) => {
  const settings = readSettings();

  if (!settings.ai.enabled || !settings.ai.apiKey) {
    throw new Error("AI API key is not configured.");
  }

  const today = localDate();
  const schedule = await getScheduleItems();
  const existingItems = schedule.map(({ id, date, time, title }) => ({ id, date, time, title }));

  const response = await fetch(settings.ai.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${settings.ai.apiKey}`
    },
    body: JSON.stringify({
      model: settings.ai.model,
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content:
            "You manage a Korean-language personal to-do list. Convert the user's request into compact JSON only, no prose. " +
            "Schema: {\"action\":\"add\"|\"update\"|\"delete\",\"id\":\"string\",\"date\":\"YYYY-MM-DD\",\"time\":\"HH:MM\",\"title\":\"string\",\"memo\":\"string\"}. " +
            "Use action \"update\" or \"delete\" only when the request clearly refers to one of the existing to-do items listed below, and set \"id\" to that item's id exactly as given. " +
            "Use action \"add\" for a brand-new to-do and leave \"id\" empty. " +
            "For \"update\", only include the fields that should change; leave the rest empty. " +
            `Today's date is ${today}. If the time is unknown, use an empty string. ` +
            `Existing to-do items: ${JSON.stringify(existingItems)}`
        },
        { role: "user", content: text }
      ]
    })
  });

  if (!response.ok) {
    throw new Error(`AI request failed: ${response.status}`);
  }

  const data = await response.json();
  const raw = data.choices?.[0]?.message?.content || "";
  const jsonText = raw.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();
  const parsed = JSON.parse(jsonText);
  const action = ["add", "update", "delete"].includes(parsed.action) ? parsed.action : "add";

  if (action === "delete") {
    const target = schedule.find((next) => next.id === parsed.id);
    if (!target) {
      throw new Error("AI could not match an existing schedule item to delete.");
    }

    await deleteScheduleItem(parsed.id);
    const savedSchedule = await getScheduleItems();
    broadcastSchedule();
    return { action, item: target, schedule: savedSchedule };
  }

  let item;

  if (action === "update") {
    const existing = schedule.find((next) => next.id === parsed.id);
    if (!existing) {
      throw new Error("AI could not match an existing schedule item to update.");
    }

    item = await updateScheduleItem(parsed.id, {
      date: parsed.date || existing.date,
      time: parsed.time || existing.time,
      title: parsed.title || existing.title,
      memo: parsed.memo || existing.memo
    });
  } else {
    item = await createScheduleItem({
      date: parsed.date || today,
      time: parsed.time || "",
      title: parsed.title || text,
      memo: parsed.memo || ""
    });
  }

  const conflict = schedule.find(
    (next) => next.id !== item.id && next.date === item.date && item.time && next.time === item.time
  );

  const savedSchedule = await getScheduleItems();
  broadcastSchedule();

  return { action, item, conflict: conflict || null, schedule: savedSchedule };
});

ipcMain.handle("ai-capture-help", async () => {
  const settings = readSettings();

  if (!settings.ai.enabled || !settings.ai.apiKey) {
    throw new Error("AI가 설정되어 있지 않습니다. 설정 > AI 탭에서 켜주세요.");
  }

  const imageDataUrl = await captureScreenDataUrl();

  const reply = await requestAiCompletion(settings, [
    {
      role: "system",
      content:
        "You are a helpful desktop assistant looking at a screenshot of the user's screen. " +
        "Briefly describe what's on screen and offer concrete, actionable help. Respond in Korean, under 6 short lines."
    },
    {
      role: "user",
      content: [
        { type: "text", text: "이 화면을 보고 무엇을 하면 좋을지 도와줘." },
        { type: "image_url", image_url: { url: imageDataUrl } }
      ]
    }
  ]);

  return { reply };
});

ipcMain.on("ai-chat-open-request", () => {
  openAiChat();
});

ipcMain.handle("ai-chat-send", async (event, payload) => {
  const settings = readSettings();

  if (!settings.ai.enabled || !settings.ai.apiKey) {
    throw new Error("AI가 설정되어 있지 않습니다. 설정 > AI 탭에서 켜주세요.");
  }

  const history = Array.isArray(payload?.history) ? payload.history : [];
  const message = payload?.message || "";

  const messages = [
    {
      role: "system",
      content: "You are a friendly desktop pet assistant. Keep replies concise and reply in Korean unless the user writes in another language."
    },
    ...history.slice(-10).map((entry) => ({
      role: entry.role === "assistant" ? "assistant" : "user",
      content: entry.content
    })),
    { role: "user", content: message }
  ];

  const reply = await requestAiCompletion(settings, messages);
  return { reply };
});
