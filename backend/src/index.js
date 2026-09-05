const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization"
};

// Public catalog of AI providers the desktop app can offer in its settings UI.
// Contains no secrets — just endpoints/model names, so no auth is required to read it.
// Update this list (and redeploy) as providers change their free-tier model lineups.
const AI_PROVIDERS = [
  {
    id: "groq",
    label: "Groq (무료 티어)",
    signupUrl: "https://console.groq.com/keys",
    endpoint: "https://api.groq.com/openai/v1/chat/completions",
    models: ["openai/gpt-oss-120b", "openai/gpt-oss-20b", "qwen/qwen3.6-27b"],
    visionModels: ["qwen/qwen3.6-27b"]
  }
];

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS }
  });
}

function checkAuth(request, env) {
  const auth = request.headers.get("Authorization") || "";
  return env.API_TOKEN && auth === `Bearer ${env.API_TOKEN}`;
}

function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

function rowToTodo(row) {
  return {
    id: row.id,
    date: row.date,
    time: row.time,
    title: row.title,
    memo: row.memo,
    done: Boolean(row.done),
    dailyId: row.daily_id || undefined
  };
}

async function ensureDailyForToday(env) {
  const today = todayUTC();
  const { results: templates } = await env.DB.prepare("SELECT * FROM daily_templates").all();
  if (!templates.length) {
    return;
  }

  const { results: existing } = await env.DB.prepare(
    "SELECT daily_id FROM todos WHERE date = ? AND daily_id IS NOT NULL"
  )
    .bind(today)
    .all();
  const existingIds = new Set(existing.map((row) => row.daily_id));

  for (const template of templates) {
    if (existingIds.has(template.id)) {
      continue;
    }

    const id = `${Date.now()}-${template.id}`;
    await env.DB.prepare(
      "INSERT INTO todos (id, date, time, title, memo, done, daily_id) VALUES (?, ?, ?, ?, ?, 0, ?)"
    )
      .bind(id, today, template.time || "", template.title, "", template.id)
      .run();
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    if (path === "/ai-providers" && method === "GET") {
      return json(AI_PROVIDERS);
    }

    if (!checkAuth(request, env)) {
      return json({ error: "Unauthorized" }, 401);
    }

    if (path === "/daily/instantiate" && method === "POST") {
      await ensureDailyForToday(env);
      return json({ ok: true });
    }

    if (path === "/todos" && method === "GET") {
      const dateFilter = url.searchParams.get("date");
      const stmt = dateFilter
        ? env.DB.prepare("SELECT * FROM todos WHERE date = ? ORDER BY time").bind(dateFilter)
        : env.DB.prepare("SELECT * FROM todos ORDER BY date, time");
      const { results } = await stmt.all();
      return json(results.map(rowToTodo));
    }

    if (path === "/todos" && method === "POST") {
      const body = await request.json();
      const id = `${Date.now()}`;
      const item = {
        id,
        date: body.date || todayUTC(),
        time: body.time || "",
        title: body.title || "새 할일",
        memo: body.memo || ""
      };

      await env.DB.prepare(
        "INSERT INTO todos (id, date, time, title, memo, done, daily_id) VALUES (?, ?, ?, ?, ?, 0, NULL)"
      )
        .bind(item.id, item.date, item.time, item.title, item.memo)
        .run();

      return json({ ...item, done: false }, 201);
    }

    const todoMatch = path.match(/^\/todos\/([^/]+)$/);

    if (todoMatch && method === "PATCH") {
      const id = todoMatch[1];
      const existing = await env.DB.prepare("SELECT * FROM todos WHERE id = ?").bind(id).first();
      if (!existing) {
        return json({ error: "Not found" }, 404);
      }

      const body = await request.json();
      const updated = {
        date: body.date ?? existing.date,
        time: body.time ?? existing.time,
        title: body.title ?? existing.title,
        memo: body.memo ?? existing.memo,
        done: typeof body.done === "boolean" ? (body.done ? 1 : 0) : existing.done
      };

      await env.DB.prepare("UPDATE todos SET date=?, time=?, title=?, memo=?, done=? WHERE id=?")
        .bind(updated.date, updated.time, updated.title, updated.memo, updated.done, id)
        .run();

      return json(rowToTodo({ ...existing, ...updated, id }));
    }

    if (todoMatch && method === "DELETE") {
      await env.DB.prepare("DELETE FROM todos WHERE id = ?").bind(todoMatch[1]).run();
      return json({ ok: true });
    }

    if (path === "/daily" && method === "GET") {
      const { results } = await env.DB.prepare("SELECT * FROM daily_templates").all();
      return json(results);
    }

    if (path === "/daily" && method === "POST") {
      const body = await request.json();
      const id = `${Date.now()}`;
      const title = body.title || "새 데일리 할일";
      const time = body.time || "";

      await env.DB.prepare("INSERT INTO daily_templates (id, title, time) VALUES (?, ?, ?)")
        .bind(id, title, time)
        .run();

      return json({ id, title, time }, 201);
    }

    const dailyMatch = path.match(/^\/daily\/([^/]+)$/);

    if (dailyMatch && method === "DELETE") {
      await env.DB.prepare("DELETE FROM daily_templates WHERE id = ?").bind(dailyMatch[1]).run();
      return json({ ok: true });
    }

    return json({ error: "Not found" }, 404);
  }
};
