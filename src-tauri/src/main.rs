fn main() {
  // WebKitGTK's DMA-BUF renderer can fail to allocate GBM buffers on some
  // Linux GPU/Wayland combinations, leaving a healthy webview entirely blank.
  // BIG AGENT is intentionally lightweight, so the reliable fallback is the
  // better default. Respect an explicit user override when one is provided.
  #[cfg(target_os = "linux")]
  if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
    std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
  }

  big_agent_lib::run()
}
