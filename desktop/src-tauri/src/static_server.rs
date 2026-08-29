use std::{env, fs::{self, OpenOptions}, io::{self, BufRead, BufReader, Read, Write}, net::{Ipv4Addr, Shutdown, SocketAddr, SocketAddrV4, TcpListener, TcpStream}, path::{Component, Path, PathBuf}, sync::{atomic::{AtomicBool, Ordering}, Arc}, thread, time::{Duration, Instant, SystemTime, UNIX_EPOCH}};
use tauri::{AppHandle, Runtime};

pub const DEFAULT_PORT: u16 = 17880;
const PORT_ATTEMPTS: u16 = 20;
const MAX_HEADER_BYTES: usize = 32 * 1024;
const MAX_REQUEST_BODY_BYTES: usize = 1024 * 1024;

pub struct StaticServer { stop: Arc<AtomicBool>, pub port: u16 }

impl StaticServer {
    pub fn start<R: Runtime>(app: AppHandle<R>, preferred_port: u16) -> std::io::Result<Self> {
        let (listener, port) = bind_available(preferred_port, PORT_ATTEMPTS)?;
        listener.set_nonblocking(true)?;
        let stop = Arc::new(AtomicBool::new(false));
        let thread_stop = Arc::clone(&stop);
        thread::spawn(move || while !thread_stop.load(Ordering::Relaxed) {
            match listener.accept() {
                Ok((stream, client_addr)) => {
                    if stream.set_nonblocking(false).is_ok() {
                        let connection_app = app.clone();
                        thread::spawn(move || serve(stream, client_addr, &connection_app));
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => thread::sleep(Duration::from_millis(25)),
                Err(_) => break,
            }
        });
        Ok(Self { stop, port })
    }
}

impl Drop for StaticServer { fn drop(&mut self) { self.stop.store(true, Ordering::Relaxed); } }

pub fn bind_available(preferred: u16, attempts: u16) -> std::io::Result<(TcpListener, u16)> {
    select_available(preferred, attempts, |port| TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, port)))
}

fn select_available<T>(preferred: u16, attempts: u16, mut bind: impl FnMut(u16) -> std::io::Result<T>) -> std::io::Result<(T, u16)> {
    let mut last_error = None;
    for offset in 0..attempts {
        let Some(port) = preferred.checked_add(offset) else { break };
        match bind(port) { Ok(value) => return Ok((value, port)), Err(error) => last_error = Some(error) }
    }
    Err(last_error.unwrap_or_else(|| std::io::Error::new(std::io::ErrorKind::AddrNotAvailable, "no candidate ports")))
}

/// 用户自己装的模型走这个前缀；其余路径走随包的内嵌资源。
pub const USER_MODELS_PREFIX: &str = "user-models/";

/// 把 `user-models/` 之后的相对路径解析成真实文件路径，**越界一律 None**。
///
/// `asset_path` 已经挡掉了 `..`、反斜线与百分号编码，但用户模型目录里可能存在符号链接
/// （安装时我们不跟随复制，手动放进去的却可能有）。canonicalize 之后必须仍在根目录内。
pub fn resolve_within(root: &Path, rest: &str) -> Option<PathBuf> {
    if rest.is_empty() { return None; }
    let root = root.canonicalize().ok()?;
    let target = root.join(rest).canonicalize().ok()?;
    target.starts_with(&root).then_some(target)
}

pub fn asset_path(target: &str) -> Option<String> {
    let raw = target.split(['?', '#']).next()?;
    if raw.contains('%') || raw.contains('\\') { return None; }
    let path = raw.strip_prefix('/')?;
    if !path.is_empty() && Path::new(path).components().any(|part| !matches!(part, Component::Normal(_))) { return None; }
    Some(if path.is_empty() { "index.html".to_owned() } else { path.to_owned() })
}

pub fn content_type(path: &str) -> &'static str {
    match Path::new(path).extension().and_then(|ext| ext.to_str()).unwrap_or("").to_ascii_lowercase().as_str() {
        "html" => "text/html; charset=utf-8", "css" => "text/css; charset=utf-8", "js" | "mjs" => "text/javascript; charset=utf-8",
        "json" => "application/json; charset=utf-8", "png" => "image/png", "jpg" | "jpeg" => "image/jpeg", "webp" => "image/webp",
        "svg" => "image/svg+xml", "wasm" => "application/wasm", "woff2" => "font/woff2", "wav" => "audio/wav", "ico" => "image/x-icon",
        _ => "application/octet-stream",
    }
}

#[derive(Debug)]
struct Request { method: String, target: String, keep_alive: bool }

#[derive(Debug)]
struct RequestLog {
    timestamp_ms: u128,
    method: String,
    path: String,
    status: u16,
    bytes: usize,
    duration_ms: u128,
    client_addr: String,
}

fn append_request_log(path: &Path, entry: &RequestLog) -> io::Result<()> {
    let mut file = OpenOptions::new().create(true).append(true).open(path)?;
    writeln!(file, "{}", serde_json::json!({
        "timestamp_ms": entry.timestamp_ms, "method": entry.method, "path": entry.path,
        "status": entry.status, "bytes": entry.bytes,
        "duration_ms": entry.duration_ms, "client_addr": entry.client_addr,
    }))?;
    file.flush()
}

fn read_request(reader: &mut impl BufRead) -> io::Result<Option<Request>> {
    let mut header = Vec::new();
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() { return if header.is_empty() { Ok(None) } else { Err(io::Error::new(io::ErrorKind::UnexpectedEof, "incomplete request headers")) }; }
        let take = available.iter().position(|byte| *byte == b'\n').map_or(available.len(), |index| index + 1);
        if header.len() + take > MAX_HEADER_BYTES { return Err(io::Error::new(io::ErrorKind::InvalidData, "request headers too large")); }
        header.extend_from_slice(&available[..take]);
        reader.consume(take);
        if header.ends_with(b"\r\n\r\n") || header.ends_with(b"\n\n") { break; }
    }
    let text = std::str::from_utf8(&header).map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "headers are not utf-8"))?;
    let mut lines = text.lines();
    let mut request_line = lines.next().unwrap_or_default().split_whitespace();
    let (method, target, version) = match (request_line.next(), request_line.next(), request_line.next()) {
        (Some(method), Some(target), Some(version)) if request_line.next().is_none() => (method, target, version),
        _ => return Err(io::Error::new(io::ErrorKind::InvalidData, "invalid request line")),
    };
    if version != "HTTP/1.1" && version != "HTTP/1.0" { return Err(io::Error::new(io::ErrorKind::InvalidData, "unsupported HTTP version")); }
    let mut content_length = None;
    let mut connection = None;
    for line in lines {
        if line.is_empty() { continue; }
        let (name, value) = line.split_once(':').ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "invalid header"))?;
        let value = value.trim();
        if name.eq_ignore_ascii_case("content-length") {
            let parsed = value.parse().map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "invalid content-length"))?;
            if content_length.replace(parsed).is_some() || parsed > MAX_REQUEST_BODY_BYTES { return Err(io::Error::new(io::ErrorKind::InvalidData, "invalid content-length")); }
        } else if name.eq_ignore_ascii_case("transfer-encoding") && !value.eq_ignore_ascii_case("identity") {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "transfer-encoding unsupported"));
        } else if name.eq_ignore_ascii_case("connection") { connection = Some(value); }
    }
    let content_length = content_length.unwrap_or(0);
    if io::copy(&mut reader.take(content_length as u64), &mut io::sink())? != content_length as u64 {
        return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "incomplete request body"));
    }
    let keep_alive = if version == "HTTP/1.1" { !connection.is_some_and(|value| has_token(value, "close")) } else { connection.is_some_and(|value| has_token(value, "keep-alive")) };
    Ok(Some(Request { method: method.to_owned(), target: target.to_owned(), keep_alive }))
}

fn has_token(value: &str, expected: &str) -> bool { value.split(',').any(|token| token.trim().eq_ignore_ascii_case(expected)) }

fn serve<R: Runtime>(stream: TcpStream, client_addr: SocketAddr, app: &AppHandle<R>) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(30)));
    let mut io = BufReader::new(stream);
    let log_path = env::var("AGENT_AVATAR_HTTP_LOG").map(PathBuf::from).unwrap_or_else(|_| PathBuf::from("/tmp/agent-avatar-http.log"));
    let _ = serve_connection(
        &mut io,
        |path| match path.strip_prefix(USER_MODELS_PREFIX) {
            // 用户装的模型在 app_data_dir 里，不在包内 —— .app 是只读的（见 config.rs 头注释）。
            Some(rest) => crate::config::models_dir(app).ok()
                .and_then(|root| resolve_within(&root, rest))
                .and_then(|file| fs::read(file).ok()),
            None => app.asset_resolver().get(path).map(|asset| asset.bytes),
        },
        &client_addr.to_string(),
        |entry| { let _ = append_request_log(&log_path, entry); },
    );
    // Send FIN only after every parsed request was consumed, then briefly drain any
    // bytes racing with a client-requested close so BSD does not turn close into RST.
    let _ = io.get_ref().shutdown(Shutdown::Write);
    let _ = io.get_ref().set_read_timeout(Some(Duration::from_millis(250)));
    let _ = io::copy(&mut io, &mut io::sink());
}

fn serve_connection<T: Read + Write>(
    io: &mut BufReader<T>,
    mut resolve: impl FnMut(String) -> Option<Vec<u8>>,
    client_addr: &str,
    mut log: impl FnMut(&RequestLog),
) -> io::Result<()> {
    loop {
        let request = match read_request(io) {
            Ok(Some(request)) => request,
            Ok(None) => return Ok(()),
            Err(error) => {
                if error.kind() == io::ErrorKind::InvalidData { let _ = write_response(io.get_mut(), 400, "text/plain; charset=utf-8", b"bad request", false, false); }
                return Err(error);
            }
        };
        let started = Instant::now();
        let head = request.method == "HEAD";
        let (status, mime, body) = if request.method != "GET" && !head {
            (405, "text/plain; charset=utf-8", b"method not allowed".to_vec())
        } else if let Some(path) = asset_path(&request.target) {
            match resolve(path.clone()) { Some(body) => (200, content_type(&path), body), None => (404, "text/plain; charset=utf-8", b"not found".to_vec()) }
        } else { (400, "text/plain; charset=utf-8", b"bad path".to_vec()) };
        write_response(io.get_mut(), status, mime, &body, head, request.keep_alive)?;
        log(&RequestLog {
            timestamp_ms: SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis(),
            // 只记路径，**剥掉 query**：webview URL 支持 `?token=` 覆盖（见 main.ts），
            // 而本日志默认落在 /tmp（0644，全局可读）—— 记全 target 等于把 Hermes 会话凭据明文落盘。
            method: request.method.clone(), path: request.target.split(['?', '#']).next().unwrap_or("").to_owned(), status,
            bytes: if head { 0 } else { body.len() }, duration_ms: started.elapsed().as_millis(),
            client_addr: client_addr.to_owned(),
        });
        if !request.keep_alive { return Ok(()); }
    }
}

fn write_response(stream: &mut impl Write, status: u16, mime: &str, body: &[u8], head: bool, keep_alive: bool) -> io::Result<()> {
    let reason = match status { 200 => "OK", 400 => "Bad Request", 404 => "Not Found", 405 => "Method Not Allowed", _ => "Error" };
    let connection = if keep_alive { "keep-alive" } else { "close" };
    let header = format!("HTTP/1.1 {status} {reason}\r\nContent-Type: {mime}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: {connection}\r\n\r\n", body.len());
    stream.write_all(header.as_bytes())?;
    if !head { stream.write_all(body)?; }
    stream.flush()
}

#[cfg(test)] mod tests {
    use super::*;
    struct TestIo { input: io::Cursor<Vec<u8>>, output: Vec<u8> }
    impl Read for TestIo { fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> { self.input.read(bytes) } }
    impl Write for TestIo { fn write(&mut self, bytes: &[u8]) -> io::Result<usize> { self.output.extend_from_slice(bytes); Ok(bytes.len()) } fn flush(&mut self) -> io::Result<()> { Ok(()) } }
    #[test] fn maps_content_types() { assert_eq!(content_type("texture.PNG"), "image/png"); assert_eq!(content_type("index.html"), "text/html; charset=utf-8"); assert_eq!(content_type("model.moc3"), "application/octet-stream"); assert_eq!(content_type("core.wasm"), "application/wasm"); }
    #[test] fn resolves_user_model_files_only_inside_the_models_directory() {
        let nonce = std::time::SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let base = env::temp_dir().join(format!("agent-avatar-serve-{}-{nonce}", std::process::id()));
        let root = base.join("models");  // 传进去的根；secret 要在它**外面**才算越界
        fs::create_dir_all(root.join("haru")).unwrap();
        fs::write(root.join("haru/texture.png"), b"pixels").unwrap();
        let outside = base.join("secret.txt");
        fs::write(&outside, b"nope").unwrap();
        std::os::unix::fs::symlink(&outside, root.join("haru/leak.txt")).unwrap();
        // 指向根**内部**的符号链接是正常用法，不该误伤
        std::os::unix::fs::symlink(root.join("haru/texture.png"), root.join("haru/alias.png")).unwrap();

        assert!(resolve_within(&root, "haru/texture.png").is_some());
        assert!(resolve_within(&root, "haru/alias.png").is_some(), "指向根内部的符号链接应放行");
        assert_eq!(resolve_within(&root, "haru/leak.txt"), None, "符号链接指向目录外，必须拒绝");
        assert_eq!(resolve_within(&root, "../secret.txt"), None);
        assert_eq!(resolve_within(&root, "haru/missing.png"), None);
        assert_eq!(resolve_within(&root, ""), None);
        fs::remove_dir_all(&base).unwrap();
    }
    #[test] fn rejects_path_traversal() { assert_eq!(asset_path("/"), Some("index.html".to_owned())); assert_eq!(asset_path("/models/haru/a.png?v=1"), Some("models/haru/a.png".to_owned())); assert_eq!(asset_path("/../secret"), None); assert_eq!(asset_path("/models/%2e%2e/secret"), None); assert_eq!(asset_path("models/file"), None); }
    #[test] fn drifts_to_next_available_port() { let mut calls = 0; let (value, selected) = select_available(17880, 20, |port| { calls += 1; if calls < 3 { Err(std::io::Error::new(std::io::ErrorKind::AddrInUse, "occupied")) } else { Ok(port) } }).unwrap(); assert_eq!((value, selected, calls), (17882, 17882, 3)); }
    struct ShortWriter { bytes: Vec<u8>, max_write: usize }
    impl Write for ShortWriter { fn write(&mut self, bytes: &[u8]) -> io::Result<usize> { let size = bytes.len().min(self.max_write); self.bytes.extend_from_slice(&bytes[..size]); Ok(size) } fn flush(&mut self) -> io::Result<()> { Ok(()) } }
    #[test] fn writes_complete_large_response_across_short_writes() {
        let body: Vec<u8> = (0..1_188_664).map(|index| (index % 251) as u8).collect();
        let mut writer = ShortWriter { bytes: Vec::new(), max_write: 997 };
        write_response(&mut writer, 200, "image/png", &body, false, false).unwrap();
        let separator = writer.bytes.windows(4).position(|bytes| bytes == b"\r\n\r\n").unwrap() + 4;
        let header = std::str::from_utf8(&writer.bytes[..separator]).unwrap();
        assert!(header.contains(&format!("Content-Length: {}\r\n", body.len()))); assert_eq!(&writer.bytes[separator..], body);
    }
    #[test] fn head_reports_length_without_sending_body() { let body = vec![42; 438_236]; let mut response = Vec::new(); write_response(&mut response, 200, "text/javascript; charset=utf-8", &body, true, false).unwrap(); let response = String::from_utf8(response).unwrap(); assert!(response.contains("Content-Length: 438236\r\n")); assert!(response.ends_with("\r\n\r\n")); }
    #[test] fn consumes_body_and_serves_pipelined_keep_alive_requests() {
        let input = b"POST /ignored HTTP/1.1\r\nHost: localhost\r\nContent-Length: 4\r\n\r\ndataGET /texture.png HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n";
        let mut io = BufReader::new(TestIo { input: io::Cursor::new(Vec::from(input)), output: Vec::new() }); let mut paths = Vec::new();
        serve_connection(&mut io, |path| { paths.push(path); Some(vec![7; 32]) }, "127.0.0.1:54321", |_| {}).unwrap();
        let output = String::from_utf8(io.into_inner().output).unwrap();
        assert_eq!(output.matches("HTTP/1.1 405").count(), 1); assert_eq!(output.matches("HTTP/1.1 200").count(), 1); assert!(output.contains("Connection: keep-alive")); assert!(output.contains("Connection: close")); assert_eq!(paths, ["texture.png"]);
    }
    #[test] fn rejects_oversized_headers_and_chunked_bodies() {
        let oversized = format!("GET / HTTP/1.1\r\nX: {}\r\n\r\n", "x".repeat(MAX_HEADER_BYTES));
        assert_eq!(read_request(&mut BufReader::new(oversized.as_bytes())).unwrap_err().kind(), io::ErrorKind::InvalidData);
        let chunked = b"POST / HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n";
        assert_eq!(read_request(&mut BufReader::new(&chunked[..])).unwrap_err().kind(), io::ErrorKind::InvalidData);
    }
    #[test] fn logs_each_response_with_request_and_transfer_details() {
        let input = b"GET /texture.png?token=super-secret HTTP/1.1\r\nHost: localhost\r\n\r\nHEAD /missing HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n";
        let mut io = BufReader::new(TestIo { input: io::Cursor::new(Vec::from(input)), output: Vec::new() });
        let mut logs = Vec::new();
        serve_connection(&mut io, |path| (path == "texture.png").then(|| vec![7; 32]), "127.0.0.1:54321", |entry| {
            logs.push((entry.method.clone(), entry.path.clone(), entry.status, entry.bytes, entry.client_addr.clone(), entry.timestamp_ms, entry.duration_ms));
        }).unwrap();
        assert_eq!(logs.len(), 2);
        assert_eq!(&logs[0].0, "GET"); assert_eq!(&logs[0].1, "/texture.png");  // query 被剥掉：里面可能有 token assert_eq!(logs[0].2, 200); assert_eq!(logs[0].3, 32);
        assert_eq!(&logs[1].0, "HEAD"); assert_eq!(&logs[1].1, "/missing"); assert_eq!(logs[1].2, 404); assert_eq!(logs[1].3, 0);
        assert_eq!(&logs[0].4, "127.0.0.1:54321"); assert!(logs[0].5 > 0); let _ = logs[0].6;
    }
}
