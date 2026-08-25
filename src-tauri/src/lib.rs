use serde_json::Value;
use rusqlite::{params, Connection, OpenFlags};
use std::{io::{BufRead, BufReader, Read, Write}, net::TcpListener, process::{Command, Stdio}};
use tauri::{AppHandle, Emitter, Manager};

fn emit(app: &AppHandle, value: Value) { let _ = app.emit("big-agent:event", value); }

#[tauri::command]
fn toggle_fullscreen(app: AppHandle) -> Result<(), String> { let w = app.get_webview_window("main").ok_or("main window unavailable")?; let next = !w.is_fullscreen().map_err(|e| e.to_string())?; w.set_fullscreen(next).map_err(|e| e.to_string()) }
#[tauri::command]
fn exit_fullscreen(app: AppHandle) -> Result<(), String> { app.get_webview_window("main").ok_or("main window unavailable")?.set_fullscreen(false).map_err(|e| e.to_string()) }
#[tauri::command]
fn toggle_always_on_top(app: AppHandle) -> Result<(), String> { let w = app.get_webview_window("main").ok_or("main window unavailable")?; let next = !w.is_always_on_top().map_err(|e| e.to_string())?; w.set_always_on_top(next).map_err(|e| e.to_string()) }

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

fn codex_db_path() -> String {
  let root = std::env::var("CODEX_HOME").or_else(|_| std::env::var("HOME").map(|home| format!("{home}/.codex"))).unwrap_or_default();
  format!("{root}/thread_history_1.sqlite")
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

fn desktop_record_event(thread: &str, turn: &str, turn_status: &str, item_type: &str, item_json: &str, ordinal: i64) -> Value {
  let item = serde_json::from_str::<Value>(item_json).unwrap_or(Value::Null);
  let mut status = "thinking"; let mut label = "THINKING"; let mut detail = "Codex desktop task active".to_string();
  let mut files: Vec<String> = Vec::new(); let mut command: Option<String> = None;
  match item_type {
    "reasoning" => { if let Some(text) = item.get("summary").and_then(Value::as_array).and_then(|s| s.first()).and_then(Value::as_str) { detail = text.to_string(); } },
    "commandExecution" => { let text = item.get("command").and_then(Value::as_str).unwrap_or("Running command"); let testing = ["test", "vitest", "jest", "pytest", "cargo test", "go test"].iter().any(|word| text.contains(word)); status = if testing { "testing" } else { "command" }; label = if testing { "RUNNING TESTS" } else { "RUNNING" }; detail = text.to_string(); command = Some(text.to_string()); },
    "fileChange" => { status = "editing"; label = "EDITING"; files = item.get("changes").and_then(Value::as_array).map(|changes| changes.iter().filter_map(|c| c.get("path").and_then(Value::as_str).map(String::from)).collect()).unwrap_or_default(); detail = if files.is_empty() { "Updating files".into() } else { files.join("\n") }; },
    "webSearch" => { status = "searching"; label = "SEARCHING"; detail = "Searching the web".into(); },
    "agentMessage" => { status = "working"; label = "WORKING"; if let Some(text) = item.get("text").and_then(Value::as_str) { detail = text.to_string(); } },
    "userMessage" => { detail = "New request received".into(); },
    _ => {}
  }
  if turn_status == "completed" { status = "complete"; label = "DONE"; if detail == "Codex desktop task active" { detail = "Codex task complete".into(); } }
  if turn_status == "interrupted" { status = "error"; label = "STOPPED"; detail = "Codex task was interrupted".into(); }
  serde_json::json!({"version":1,"id":format!("codex-session-{turn}-{ordinal}"),"timestamp":"","kind":"activity","status":status,"label":label,"detail":detail,"files":files,"command":command,"meta":{"sessionId":turn,"threadId":thread,"sessionName":format!("Codex {}", &thread[..thread.len().min(8)])}})
}

#[tauri::command]
fn codex_desktop_sessions() -> Result<Vec<Value>, String> {
  let db = Connection::open_with_flags(codex_db_path(), OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|e| e.to_string())?;
  let mut statement = db.prepare("SELECT t.thread_id, t.turn_id, t.status, COALESCE(MAX(i.updated_at_ordinal), 0) AS latest FROM thread_turns t LEFT JOIN thread_items i ON i.thread_id = t.thread_id AND i.turn_id = t.turn_id WHERE t.status = 'inProgress' OR (t.status IN ('completed','interrupted') AND t.completed_at > unixepoch() - 300) GROUP BY t.thread_id, t.turn_id ORDER BY COALESCE(MAX(i.created_at_ms), t.started_at * 1000) DESC LIMIT 12").map_err(|e| e.to_string())?;
  let turns: Vec<(String, String, String, i64)> = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))).map_err(|e| e.to_string())?.flatten().collect();
  let mut events = Vec::new();
  for (thread, turn, turn_status, ordinal) in turns {
    let record = db.query_row("SELECT item_type, item_json FROM thread_items WHERE thread_id = ?1 AND turn_id = ?2 ORDER BY updated_at_ordinal DESC LIMIT 1", params![thread, turn], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))).ok();
    if let Some((item_type, item_json)) = record { events.push(desktop_record_event(&thread, &turn, &turn_status, &item_type, &item_json, ordinal)); }
    else { events.push(desktop_record_event(&thread, &turn, &turn_status, "", "{}", ordinal)); }
  }
  Ok(events)
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

/// Watches Codex desktop's local, structured thread ledger. This is deliberately a database/event adapter,
/// not a terminal scraper, and stays entirely on the user's machine.
fn start_codex_desktop_adapter(app: AppHandle) {
  std::thread::spawn(move || {
    let db_path = codex_db_path();
    let mut tracked: Option<(String, String)> = None; let mut cursor = 0_i64;
    loop {
      let Ok(db) = Connection::open_with_flags(&db_path, OpenFlags::SQLITE_OPEN_READ_ONLY) else { std::thread::sleep(std::time::Duration::from_millis(750)); continue };
      let current = active_codex_turn(&db);
      if current != tracked {
        tracked = current.clone(); cursor = 0;
        if let Some((thread, turn)) = &tracked {
          cursor = db.query_row("SELECT COALESCE(MAX(updated_at_ordinal), 0) FROM thread_items WHERE thread_id = ?1 AND turn_id = ?2", [thread, turn], |row| row.get(0)).unwrap_or(0);
          emit(&app, serde_json::json!({"version":1,"id":format!("codex-desktop-start-{turn}"),"timestamp":"","kind":"turn.start","status":"thinking","detail":"Codex desktop task active"}));
        }
      }
      if let Some((thread, turn)) = &tracked {
        let mut statement = match db.prepare("SELECT item_id, item_type, item_json, updated_at_ordinal FROM thread_items WHERE thread_id = ?1 AND turn_id = ?2 AND updated_at_ordinal > ?3 ORDER BY updated_at_ordinal") { Ok(s) => s, Err(_) => { std::thread::sleep(std::time::Duration::from_millis(750)); continue } };
        let rows = statement.query_map([thread.as_str(), turn.as_str(), &cursor.to_string()], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, i64>(3)?)));
        if let Ok(rows) = rows { for row in rows.flatten() { let (item_id, item_type, item_json, ordinal) = row; cursor = cursor.max(ordinal); let item = serde_json::from_str::<Value>(&item_json).unwrap_or(Value::Null); let id = format!("codex-desktop-{turn}-{item_id}-{ordinal}");
          let event = match item_type.as_str() {
            "reasoning" => item.get("summary").and_then(Value::as_array).and_then(|s| s.first()).and_then(Value::as_str).map(|detail| serde_json::json!({"version":1,"id":id,"timestamp":"","kind":"reasoning.summary","status":"thinking","detail":detail})),
            "commandExecution" => { let command = item.get("command").and_then(Value::as_str).unwrap_or("Running command"); let testing = ["test", "vitest", "jest", "pytest", "cargo test", "go test"].iter().any(|word| command.contains(word)); Some(serde_json::json!({"version":1,"id":id,"timestamp":"","kind":"command.start","status":if testing {"testing"} else {"command"},"label":if testing {"RUNNING TESTS"} else {"RUNNING"},"command":command,"exitCode":item.get("exitCode")})) },
            "fileChange" => { let files: Vec<String> = item.get("changes").and_then(Value::as_array).map(|changes| changes.iter().filter_map(|c| c.get("path").and_then(Value::as_str).map(String::from)).collect()).unwrap_or_default(); Some(serde_json::json!({"version":1,"id":id,"timestamp":"","kind":"files.changed","status":"editing","files":files})) },
            "webSearch" => Some(serde_json::json!({"version":1,"id":id,"timestamp":"","kind":"activity","status":"searching","detail":"Searching"})),
            "userMessage" => Some(serde_json::json!({"version":1,"id":id,"timestamp":"","kind":"turn.start","status":"thinking","detail":"New request received"})),
            _ => None,
          }; if let Some(event) = event { emit(&app, event); }
        }}
      }
      std::thread::sleep(std::time::Duration::from_millis(750));
    }
  });
}

pub fn run() { tauri::Builder::default().setup(|app| { start_protocol_server(app.handle().clone()); Ok(()) }).plugin(tauri_plugin_opener::init()).invoke_handler(tauri::generate_handler![toggle_fullscreen, exit_fullscreen, toggle_always_on_top, run_process, codex_desktop_snapshot, codex_desktop_sessions]).run(tauri::generate_context!()).expect("error while running BIG AGENT"); }

#[cfg(test)]
mod tests {
  use super::*;
  #[test]
  fn reads_codex_desktop_sessions() {
    let sessions = codex_desktop_sessions().expect("desktop session query should succeed");
    assert!(!sessions.is_empty(), "expected at least one active or recently completed Codex turn");
    assert!(sessions.iter().all(|event| event.pointer("/meta/sessionId").and_then(Value::as_str).is_some()));
  }
}
