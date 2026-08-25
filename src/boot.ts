const root = document.getElementById("root");

function showStartupError(reason: unknown) {
  if (!root || root.querySelector(".app")) return;
  const message = reason instanceof Error ? reason.message : String(reason || "Unknown startup error");
  root.innerHTML = `<main class="boot-screen"><span>STARTUP ERROR</span><small>${message.replace(/[<>&]/g, "")}</small></main>`;
}

window.addEventListener("error", (event) => showStartupError(event.error || event.message));
window.addEventListener("unhandledrejection", (event) => showStartupError(event.reason));
window.setTimeout(() => {
  if (!document.querySelector(".app")) showStartupError("The interface did not mount");
}, 3_000);
