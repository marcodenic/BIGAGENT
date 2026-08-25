use serde_json::Value;
use rusqlite::{params, Connection, OpenFlags};
use base64::{engine::general_purpose::STANDARD, Engine};
use std::{collections::HashMap, fs::{self, File}, io::{BufRead, BufReader, Read, Write}, net::TcpListener, path::{Path, PathBuf}, process::{Command, Stdio}, sync::{Mutex, OnceLock}};
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Default)]
struct WakeLockState(Mutex<Option<screen_wake_lock::ScreenWakeLock>>);

fn emit(app: &AppHandle, value: Value) { let _ = app.emit("big-agent:event", value); }

#[tauri::command]
fn toggle_fullscreen(app: AppHandle) -> Result<(), String> { let w = app.get_webview_window("main").ok_or("main window unavailable")?; let next = !w.is_fullscreen().map_err(|e| e.to_string())?; w.set_fullscreen(next).map_err(|e| e.to_string()) }
#[tauri::command]
fn exit_fullscreen(app: AppHandle) -> Result<(), String> { app.get_webview_window("main").ok_or("main window unavailable")?.set_fullscreen(false).map_err(|e| e.to_string()) }
#[tauri::command]
fn toggle_always_on_top(app: AppHandle) -> Result<(), String> { let w = app.get_webview_window("main").ok_or("main window unavailable")?; let next = !w.is_always_on_top().map_err(|e| e.to_string())?; w.set_always_on_top(next).map_err(|e| e.to_string()) }

#[tauri::command]
fn set_screen_awake(active: bool, state: State<'_, WakeLockState>) -> Result<(), String> {
  let mut wake_lock = state.0.lock().map_err(|_| "screen wake lock state unavailable".to_string())?;
  if active && wake_lock.is_none() {
    *wake_lock = Some(screen_wake_lock::ScreenWakeLock::acquire("BIG AGENT has active agents").map_err(|error| error.to_string())?);
  } else if !active {
    wake_lock.take();
  }
  Ok(())
}

#[tauri::command]
fn image_preview(path: String) -> Result<String, String> {
  let path = Path::new(&path);
  if !path.is_absolute() { return Err("image path must be absolute".into()); }
  let mime = match path.extension().and_then(|value| value.to_str()).unwrap_or("").to_ascii_lowercase().as_str() {
    "png" => "image/png", "jpg" | "jpeg" => "image/jpeg", "webp" => "image/webp", "gif" => "image/gif",
    "bmp" => "image/bmp", "avif" => "image/avif", _ => return Err("unsupported image format".into()),
  };
  let metadata = fs::metadata(path).map_err(|e| e.to_string())?;
  if !metadata.is_file() || metadata.len() > 16 * 1024 * 1024 { return Err("image is unavailable or too large".into()); }
  let bytes = fs::read(path).map_err(|e| e.to_string())?;
  Ok(format!("data:{mime};base64,{}", STANDARD.encode(bytes)))
}

/// Basic generic process monitor. Stdout/stderr lines are emitted as observable activity; no terminal scraping is required by adapters.
#[tauri::command]
fn run_process(app: AppHandle, command: String, args: Vec<String>) -> Result<(), String> {
  std::thread::spawn(move || {
    emit(&app, serde_json::json!({"version":1,"id":format!("process-start-{}", std::process::id()),"timestamp":"","kind":"command.start","status":"command","command":format!("{} {}", command, args.join(" "))}));
    let mut child = match Command::new(&command).args(&args).stdout(Stdio::piped()).stderr(Stdio::null()).spawn() { Ok(c) => c, Err(e) => { emit(&app, serde_json::json!({"version":1,"id":"process-launch-error","timestamp":"","kind":"error","status":"error","detail":e.to_string()})); return; } };
    if let Some(out) = child.stdout.take() { let app2 = app.clone(); std::thread::spawn(move || for line in BufReader::new(out).lines().map_while(Result::ok) { emit(&app2, serde_json::json!({"version":1,"id":format!("stdout-{}", uuidish(&line)),"timestamp":"","kind":"activity","status":"working","detail":line})); }); }
    match child.wait() { Ok(s) if s.success() => emit(&app, serde_json::json!({"version":1,"id":"process-complete","timestamp":"","kind":"complete","status":"complete","detail":"Process completed"})), Ok(s) => emit(&app, serde_json::json!({"version":1,"id":"process-error","timestamp":"","kind":"error","status":"error","detail":format!("Process exited with code {}", s.code().unwrap_or(-1)),"exitCode":s.code()})), Err(e) => emit(&app, serde_json::json!({"version":1,"id":"process-wait-error","timestamp":"","kind":"error","status":"error","detail":e.to_string()})) }
  }); Ok(())
}
fn uuidish(s: &str) -> u64 { use std::hash::{Hash, Hasher}; let mut h = std::collections::hash_map::DefaultHasher::new(); s.hash(&mut h); h.finish() }

fn codex_home() -> String {
  std::env::var("CODEX_HOME").or_else(|_| std::env::var("HOME").map(|home| format!("{home}/.codex"))).unwrap_or_default()
}

fn codex_db_path() -> String { format!("{}/thread_history_1.sqlite", codex_home()) }
fn codex_state_db_path() -> String { format!("{}/state_5.sqlite", codex_home()) }

fn thread_names() -> HashMap<String, String> {
  let Ok(file) = File::open(format!("{}/session_index.jsonl", codex_home())) else { return HashMap::new() };
  BufReader::new(file).lines().map_while(Result::ok).filter_map(|line| {
    let value = serde_json::from_str::<Value>(&line).ok()?;
    Some((value.get("id")?.as_str()?.to_string(), value.get("thread_name")?.as_str()?.to_string()))
  }).collect()
}

#[derive(Clone)]
struct RolloutContext { parent_thread: String, cwd: String, model_provider: String }

static ROLLOUT_CONTEXTS: OnceLock<Mutex<HashMap<String, RolloutContext>>> = OnceLock::new();

fn find_rollout_file(directory: &Path, thread: &str) -> Option<PathBuf> {
  for entry in fs::read_dir(directory).ok()?.flatten() {
    let path = entry.path();
    if path.is_dir() {
      if let Some(found) = find_rollout_file(&path, thread) { return Some(found); }
    } else if path.extension().and_then(|value| value.to_str()) == Some("jsonl") && path.file_name().and_then(|value| value.to_str()).is_some_and(|name| name.contains(thread)) {
      return Some(path);
    }
  }
  None
}

fn rollout_context(thread: &str) -> Option<RolloutContext> {
  let cache = ROLLOUT_CONTEXTS.get_or_init(|| Mutex::new(HashMap::new()));
  if let Some(context) = cache.lock().ok()?.get(thread).cloned() { return Some(context); }
  let path = find_rollout_file(&Path::new(&codex_home()).join("sessions"), thread)?;
  let first_line = BufReader::new(File::open(path).ok()?).lines().next()?.ok()?;
  let value = serde_json::from_str::<Value>(&first_line).ok()?;
  if value.get("type").and_then(Value::as_str) != Some("session_meta") { return None; }
  let payload = value.get("payload")?;
  let context = RolloutContext {
    parent_thread: payload.get("session_id").or_else(|| payload.get("id")).and_then(Value::as_str).unwrap_or(thread).to_string(),
    cwd: payload.get("cwd").and_then(Value::as_str).unwrap_or("").to_string(),
    model_provider: payload.get("model_provider").and_then(Value::as_str).unwrap_or("unknown").to_string(),
  };
  cache.lock().ok()?.insert(thread.to_string(), context.clone());
  Some(context)
}

fn fallback_thread_name(db: &Connection, thread: &str) -> String {
  let item_json: Option<String> = db.query_row(
    "SELECT item_json FROM thread_items WHERE thread_id = ?1 AND item_type = 'userMessage' ORDER BY rollout_ordinal LIMIT 1",
    [thread], |row| row.get(0),
  ).ok();
  let text = item_json.and_then(|raw| serde_json::from_str::<Value>(&raw).ok()).and_then(|item| {
    item.get("content")?.as_array()?.iter().find_map(|part| part.get("text").and_then(Value::as_str).map(String::from))
  }).unwrap_or_else(|| format!("Codex {}", &thread[..thread.len().min(8)]));
  let words: Vec<&str> = text.split_whitespace().filter(|word| !word.starts_with('/') && !word.starts_with("/home/")).take(5).collect();
  if words.is_empty() { format!("Codex {}", &thread[..thread.len().min(8)]) } else { words.join(" ") }
}

fn compact_tool_name(command: &str) -> String {
  let first = command.split_whitespace().next().unwrap_or("tool");
  first.rsplit('/').next().unwrap_or(first).to_string()
}

struct ThreadDisplayMeta { workstream_id: String, workstream_name: String, task_name: String, agent_name: String, model_provider: String, model: String, reasoning_effort: String }

fn thread_display_meta(state_db: Option<&Connection>, history_db: &Connection, names: &HashMap<String, String>, thread: &str) -> ThreadDisplayMeta {
  let mut workstream_id = thread.to_string();
  if let Some(db) = state_db {
    for _ in 0..12 {
      let parent: Option<String> = db.query_row("SELECT parent_thread_id FROM thread_spawn_edges WHERE child_thread_id = ?1", [&workstream_id], |row| row.get(0)).ok();
      let Some(parent) = parent else { break };
      workstream_id = parent;
    }
  }
  let rollout = rollout_context(thread);
  if workstream_id == thread {
    if let Some(parent) = rollout.as_ref().map(|context| context.parent_thread.as_str()).filter(|parent| *parent != thread) { workstream_id = parent.to_string(); }
  }
  let root_record: Option<(String, String, String, Option<String>, Option<String>)> = state_db.and_then(|db| db.query_row("SELECT title, cwd, model_provider, model, reasoning_effort FROM threads WHERE id = ?1", [&workstream_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?))).ok());
  let agent_record: Option<(Option<String>, Option<String>, String, Option<String>, Option<String>)> = state_db.and_then(|db| db.query_row("SELECT agent_nickname, agent_role, model_provider, model, reasoning_effort FROM threads WHERE id = ?1", [thread], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?))).ok());
  let task_name = root_record.as_ref().map(|record| record.0.clone()).or_else(|| names.get(&workstream_id).cloned()).unwrap_or_else(|| fallback_thread_name(history_db, &workstream_id));
  let workstream_name = root_record.as_ref().map(|record| record.1.as_str()).or_else(|| rollout.as_ref().map(|context| context.cwd.as_str())).and_then(|cwd| Path::new(cwd).file_name()).and_then(|name| name.to_str()).filter(|name| !name.is_empty()).map(String::from).unwrap_or_else(|| task_name.clone());
  let agent_name = agent_record.as_ref().and_then(|record| record.0.clone().or(record.1.clone())).unwrap_or_else(|| "Codex agent".into());
  let model_provider = agent_record.as_ref().map(|record| record.2.clone()).or_else(|| root_record.as_ref().map(|record| record.2.clone())).or_else(|| rollout.as_ref().map(|context| context.model_provider.clone())).unwrap_or_else(|| "unknown".into());
  let model = agent_record.as_ref().and_then(|record| record.3.clone()).or_else(|| root_record.as_ref().and_then(|record| record.3.clone())).unwrap_or_else(|| "unknown model".into());
  let reasoning_effort = agent_record.and_then(|record| record.4).or_else(|| root_record.and_then(|record| record.4)).unwrap_or_default();
  ThreadDisplayMeta { workstream_id, workstream_name, task_name, agent_name, model_provider, model, reasoning_effort }
}

fn active_codex_turn(db: &Connection) -> Option<(String, String)> {
  db.query_row(
    "SELECT t.thread_id, t.turn_id FROM thread_turns t WHERE t.status = 'inProgress' ORDER BY COALESCE((SELECT MAX(i.created_at_ms) FROM thread_items i WHERE i.thread_id = t.thread_id AND i.turn_id = t.turn_id), t.started_at * 1000) DESC LIMIT 1",
    [], |row| Ok((row.get(0)?, row.get(1)?))
  ).ok()
}

#[tauri::command]
fn codex_desktop_snapshot() -> Result<Value, String> {
  let db = Connection::open_with_flags(codex_db_path(), OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|e| e.to_string())?;
  let (_, turn) = active_codex_turn(&db).ok_or("No active Codex desktop task")?;
  let id = format!("codex-desktop-snapshot-{turn}-{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis());
  Ok(serde_json::json!({"version":1,"id":id,"timestamp":"","kind":"turn.start","status":"thinking","label":"THINKING","detail":"Following active Codex desktop task"}))
}

fn previous_activity_detail(db: &Connection, thread: &str, turn: &str) -> Option<String> {
  let (item_type, raw): (String, String) = db.query_row(
    "SELECT item_type, item_json FROM thread_items WHERE thread_id = ?1 AND turn_id = ?2 AND item_type NOT IN ('reasoning', 'userMessage') ORDER BY updated_at_ordinal DESC LIMIT 1",
    params![thread, turn],
    |row| Ok((row.get(0)?, row.get(1)?)),
  ).ok()?;
  let item = serde_json::from_str::<Value>(&raw).ok()?;
  match item_type.as_str() {
    "agentMessage" => item.get("text").and_then(Value::as_str).map(String::from),
    "commandExecution" => item.get("command").and_then(Value::as_str).map(String::from),
    "fileChange" => item.get("changes").and_then(Value::as_array).and_then(|changes| changes.first()).and_then(|change| change.get("path")).and_then(Value::as_str).map(|path| format!("Updated {path}")),
    "mcpToolCall" | "dynamicToolCall" => item.get("tool").and_then(Value::as_str).map(|tool| format!("Used {}", tool.rsplit("__").next().unwrap_or(tool).replace('_', " "))),
    "webSearch" => item.get("query").and_then(Value::as_str).map(|query| format!("Searched for {query}")),
    "imageGeneration" => Some("Created a design image".into()),
    "imageView" => Some("Inspected an image".into()),
    _ => None,
  }
}

fn last_agent_message(db: &Connection, thread: &str, turn: &str) -> Option<String> {
  let raw: String = db.query_row(
    "SELECT item_json FROM thread_items WHERE thread_id = ?1 AND turn_id = ?2 AND item_type = 'agentMessage' ORDER BY updated_at_ordinal DESC LIMIT 1",
    params![thread, turn],
    |row| row.get(0),
  ).ok()?;
  serde_json::from_str::<Value>(&raw).ok()?.get("text").and_then(Value::as_str).map(String::from)
}

fn desktop_record_event(thread: &str, turn: &str, turn_status: &str, item_type: &str, item_json: &str, ordinal: i64, display: &ThreadDisplayMeta, started_at: i64, completed_at: Option<i64>, fallback_detail: Option<&str>, last_message: Option<&str>) -> Value {
  let item = serde_json::from_str::<Value>(item_json).unwrap_or(Value::Null);
  let mut status = "thinking"; let mut label = "THINKING"; let mut detail = "Codex desktop task active".to_string();
  let mut files: Vec<String> = Vec::new(); let mut command: Option<String> = None; let mut tool: Option<String> = None; let mut target: Option<String> = None;
  match item_type {
    "reasoning" => { detail = item.get("summary").and_then(Value::as_array).and_then(|s| s.first()).and_then(Value::as_str).filter(|text| !text.trim().is_empty()).or(fallback_detail).unwrap_or("Planning the next step").to_string(); },
    "commandExecution" => { let text = item.get("command").and_then(Value::as_str).unwrap_or("Running command"); let testing = ["test", "vitest", "jest", "pytest", "cargo test", "go test"].iter().any(|word| text.contains(word)); let building = [" build", "compile", "pnpm build", "cargo build"].iter().any(|word| text.contains(word)); status = if testing { "testing" } else { "command" }; label = if testing { "RUNNING TESTS" } else if building { "BUILDING" } else { "RUNNING" }; detail = text.to_string(); command = Some(text.to_string()); tool = Some(compact_tool_name(text)); },
    "fileChange" => { status = "editing"; label = "EDITING"; files = item.get("changes").and_then(Value::as_array).map(|changes| changes.iter().filter_map(|c| c.get("path").and_then(Value::as_str).map(String::from)).collect()).unwrap_or_default(); detail = if files.is_empty() { "Updating files".into() } else { format!("Updating {}", files.iter().take(2).cloned().collect::<Vec<_>>().join(", ")) }; tool = Some("apply_patch".into()); target = files.first().cloned(); },
    "webSearch" => { status = "searching"; label = "SEARCHING"; detail = item.get("query").and_then(Value::as_str).map(|query| format!("Searching for {query}")).unwrap_or_else(|| "Searching the web".into()); tool = Some("web".into()); },
    "mcpToolCall" | "dynamicToolCall" => {
      let raw_tool = item.get("tool").and_then(Value::as_str).unwrap_or("tool");
      let namespace = item.get("namespace").or_else(|| item.get("server")).and_then(Value::as_str).unwrap_or("");
      let lower = raw_tool.to_ascii_lowercase();
      let failed = item.get("status").and_then(Value::as_str).is_some_and(|value| value == "failed");
      if failed { status = "working"; label = "TOOL FAILED · RETRYING"; detail = format!("{} failed; agent still running", raw_tool.rsplit("__").next().unwrap_or(raw_tool).replace('_', " ")); }
      else if lower.contains("apply_patch") || lower.contains("write") || lower.contains("edit") { status = "editing"; label = "EDITING"; }
      else if lower.contains("browser") || lower.contains("search") || namespace.contains("browser") { status = "searching"; label = "SEARCHING"; }
      else if lower.contains("imagegen") || lower.contains("image_gen") { status = "working"; label = "GENERATING"; }
      else { status = "command"; label = "USING TOOL"; }
      tool = Some(raw_tool.rsplit("__").next().unwrap_or(raw_tool).to_string());
      if !failed { detail = format!("Using {}", tool.as_deref().unwrap_or("tool").replace('_', " ")); }
      let arguments = item.get("arguments");
      target = arguments.and_then(|args| args.get("path").or_else(|| args.get("workdir")).or_else(|| args.get("target"))).and_then(Value::as_str).map(String::from);
    },
    "imageGeneration" => { status = "working"; label = "GENERATING"; detail = "Creating a design image".into(); tool = Some("imagegen".into()); },
    "imageView" => { status = "searching"; label = "INSPECTING"; target = item.get("path").and_then(Value::as_str).map(String::from); detail = target.as_deref().and_then(|path| path.rsplit('/').next()).map(|name| format!("Inspecting {name}")).unwrap_or_else(|| "Inspecting an image".into()); tool = Some("view_image".into()); },
    "agentMessage" => { status = "working"; label = "WORKING"; if let Some(text) = item.get("text").and_then(Value::as_str) { detail = text.to_string(); } },
    "userMessage" => { detail = "New request received".into(); },
    _ => {}
  }
  if turn_status == "completed" { status = "complete"; label = "DONE"; if detail == "Codex desktop task active" { detail = "Codex task complete".into(); } }
  if turn_status == "interrupted" { status = "error"; label = "STOPPED"; detail = "Codex task was interrupted".into(); }
  let kind = if status == "complete" { "complete" } else if status == "error" { "error" } else { "activity" };
  let has_reasoning_summary = item_type == "reasoning" && item.get("summary").and_then(Value::as_array).is_some_and(|summary| summary.iter().any(|value| value.as_str().is_some_and(|text| !text.trim().is_empty())));
  let activity_class = if item_type == "agentMessage" || has_reasoning_summary { "narrative" } else if matches!(item_type, "imageView" | "imageGeneration") { "visual" } else { "telemetry" };
  serde_json::json!({"version":1,"id":format!("codex-session-{turn}-{ordinal}"),"timestamp":"","kind":kind,"status":status,"label":label,"detail":detail,"files":files,"command":command,"tool":tool,"target":target,"meta":{"sessionId":thread,"turnId":turn,"threadId":thread,"workstreamId":display.workstream_id,"workstreamName":display.workstream_name,"taskName":display.task_name,"sessionName":display.agent_name,"agentName":display.agent_name,"modelProvider":display.model_provider,"model":display.model,"reasoningEffort":display.reasoning_effort,"activityClass":activity_class,"lastMessage":last_message,"startedAtMs":started_at.saturating_mul(1000),"completedAtMs":completed_at.map(|value| value.saturating_mul(1000))}})
}

#[tauri::command]
fn codex_desktop_sessions() -> Result<Vec<Value>, String> {
  let db = Connection::open_with_flags(codex_db_path(), OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|e| e.to_string())?;
  let state_db = Connection::open_with_flags(codex_state_db_path(), OpenFlags::SQLITE_OPEN_READ_ONLY).ok();
  let names = thread_names();
  let mut statement = db.prepare("WITH eligible AS (SELECT t.*, ROW_NUMBER() OVER (PARTITION BY t.thread_id ORDER BY COALESCE(t.started_at, 0) DESC, t.rollout_ordinal DESC) AS recency_rank FROM thread_turns t WHERE t.status IN ('inProgress','completed','interrupted')) SELECT t.thread_id, t.turn_id, t.status, COALESCE(MAX(i.updated_at_ordinal), 0) AS latest, COALESCE(t.started_at, unixepoch()), t.completed_at FROM eligible t LEFT JOIN thread_items i ON i.thread_id = t.thread_id AND i.turn_id = t.turn_id WHERE t.recency_rank = 1 GROUP BY t.thread_id, t.turn_id ORDER BY COALESCE(MAX(i.created_at_ms), t.started_at * 1000) DESC LIMIT 24").map_err(|e| e.to_string())?;
  let turns: Vec<(String, String, String, i64, i64, Option<i64>)> = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?))).map_err(|e| e.to_string())?.flatten().collect();
  let mut events = Vec::new();
  for (thread, turn, turn_status, ordinal, started_at, completed_at) in turns {
    let display = thread_display_meta(state_db.as_ref(), &db, &names, &thread);
    let fallback_detail = previous_activity_detail(&db, &thread, &turn);
    let last_message = last_agent_message(&db, &thread, &turn);
    let mut records: Vec<(String, String, i64)> = {
      let mut item_statement = db.prepare("SELECT item_type, item_json, updated_at_ordinal FROM thread_items WHERE thread_id = ?1 AND turn_id = ?2 ORDER BY updated_at_ordinal DESC LIMIT 5").map_err(|e| e.to_string())?;
      let records = item_statement.query_map(params![thread, turn], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))).map_err(|e| e.to_string())?.flatten().collect();
      records
    };
    let latest_image: Option<(String, String, i64)> = db.query_row(
      "SELECT item_type, item_json, updated_at_ordinal FROM thread_items WHERE thread_id = ?1 AND turn_id = ?2 AND item_type = 'imageView' ORDER BY updated_at_ordinal DESC LIMIT 1",
      params![thread, turn], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    ).ok();
    if let Some(image) = latest_image {
      if !records.iter().any(|record| record.2 == image.2) { records.push(image); }
    }
    let narrative_records: Vec<(String, String, i64)> = {
      let mut narrative_statement = db.prepare("WITH ranked AS (SELECT item_type, item_json, updated_at_ordinal, ROW_NUMBER() OVER (PARTITION BY item_type ORDER BY updated_at_ordinal DESC) rank FROM thread_items WHERE thread_id = ?1 AND turn_id = ?2 AND (item_type = 'agentMessage' OR (item_type = 'reasoning' AND json_array_length(json_extract(item_json, '$.summary')) > 0))) SELECT item_type, item_json, updated_at_ordinal FROM ranked WHERE rank = 1").map_err(|e| e.to_string())?;
      let records = narrative_statement.query_map(params![thread, turn], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))).map_err(|e| e.to_string())?.flatten().collect();
      records
    };
    for narrative in narrative_records {
      if !records.iter().any(|record| record.2 == narrative.2) { records.push(narrative); }
    }
    records.sort_by_key(|record| record.2);
    if records.is_empty() {
      events.push(desktop_record_event(&thread, &turn, &turn_status, "", "{}", ordinal, &display, started_at, completed_at, fallback_detail.as_deref(), last_message.as_deref()));
      continue;
    }
    let record_count = records.len();
    for (index, (item_type, item_json, item_ordinal)) in records.into_iter().enumerate() {
      let record_status = if index + 1 == record_count { turn_status.as_str() } else { "inProgress" };
      events.push(desktop_record_event(&thread, &turn, record_status, &item_type, &item_json, item_ordinal, &display, started_at, completed_at, fallback_detail.as_deref(), last_message.as_deref()));
    }
  }
  Ok(events)
}

/// Poll from native code so live status continues while WebKit throttles an
/// unfocused or backgrounded window. The webview only renders pushed snapshots.
fn start_codex_session_watcher(app: AppHandle) {
  std::thread::spawn(move || loop {
    if let Ok(sessions) = codex_desktop_sessions() {
      let _ = app.emit("big-agent:sessions", sessions);
    }
    std::thread::sleep(std::time::Duration::from_millis(750));
  });
}

/// Small local-only protocol bridge. POST a normalized event (or simple status event) to 127.0.0.1:19777/event.
fn start_protocol_server(app: AppHandle) {
  std::thread::spawn(move || {
    let Ok(listener) = TcpListener::bind("127.0.0.1:19777") else { return }; // one app instance owns the port
    for stream in listener.incoming() {
      let Ok(mut stream) = stream else { continue };
      let mut reader = BufReader::new(stream.try_clone().expect("stream clone")); let mut content_length = 0usize; let mut line = String::new();
      loop { line.clear(); if reader.read_line(&mut line).is_err() || line == "\r\n" { break; } if let Some((name, value)) = line.split_once(':') { if name.eq_ignore_ascii_case("content-length") { content_length = value.trim().parse().unwrap_or(0); } } }
      let mut bytes = vec![0; content_length]; let read = reader.read_exact(&mut bytes);
      let result = read.and_then(|_| serde_json::from_slice::<Value>(&bytes).map_err(std::io::Error::other)).map(|event| emit(&app, event));
      let (status, message) = if result.is_ok() { ("202 Accepted", "accepted") } else { ("400 Bad Request", "invalid JSON") };
      let response = format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{{\"status\":\"{message}\"}}"); let _ = stream.write_all(response.as_bytes());
    }
  });
}

pub fn run() { tauri::Builder::default().manage(WakeLockState::default()).setup(|app| { start_protocol_server(app.handle().clone()); start_codex_session_watcher(app.handle().clone()); Ok(()) }).plugin(tauri_plugin_opener::init()).invoke_handler(tauri::generate_handler![toggle_fullscreen, exit_fullscreen, toggle_always_on_top, set_screen_awake, image_preview, run_process, codex_desktop_snapshot, codex_desktop_sessions]).run(tauri::generate_context!()).expect("error while running BIG AGENT"); }

#[cfg(test)]
mod tests {
  use super::*;
  #[test]
  fn reads_codex_desktop_sessions() {
    let sessions = codex_desktop_sessions().expect("desktop session query should succeed");
    assert!(!sessions.is_empty(), "expected at least one active or recently completed Codex turn");
    assert!(sessions.iter().all(|event| event.pointer("/meta/sessionId").and_then(Value::as_str).is_some()));
    assert!(sessions.iter().all(|event| event.pointer("/meta/workstreamId").and_then(Value::as_str).is_some()));
    assert!(sessions.iter().all(|event| event.pointer("/meta/workstreamName").and_then(Value::as_str).is_some()));
    assert!(sessions.iter().all(|event| event.pointer("/meta/modelProvider").and_then(Value::as_str).is_some()));
    assert!(sessions.iter().all(|event| event.pointer("/meta/model").and_then(Value::as_str).is_some()));
    assert!(sessions.iter().all(|event| event.pointer("/meta/sessionId") == event.pointer("/meta/threadId")));
  }
}
