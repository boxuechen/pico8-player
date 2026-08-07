const status = document.querySelector("#release-status");
const manifestUrl = new URL("../manifest.json", import.meta.url);
let player;

try {
  const response = await fetch(manifestUrl);
  if (!response.ok) throw new Error(`Unable to load release manifest: HTTP ${response.status}`);
  const manifest = await response.json();
  const releaseRoot = new URL("./", manifestUrl);
  const stylesheet = document.createElement("link");
  stylesheet.rel = "stylesheet";
  stylesheet.href = new URL(manifest.artifacts.styles.path, releaseRoot).href;
  document.head.append(stylesheet);
  const module = await import(new URL(manifest.artifacts.main.path, releaseRoot).href);
  player = await module.createPico8WebPlayer({
    root: document.querySelector("#player"),
  });
  player.on("state", (event) => {
    status.textContent = event.message;
    document.body.dataset.progress = event.state;
  });
  const removeFrame = player.on("frame", () => {
    removeFrame();
    document.body.dataset.status = "complete";
  });
  player.on("fault", (event) => {
    status.textContent = `${event.error.code}: ${event.error.message}`;
    document.body.dataset.status = "error";
  });
  document.body.dataset.status = "ready";
  document.body.dataset.progress = "choose-cart";
} catch (error) {
  status.textContent = error instanceof Error ? error.message : String(error);
  document.body.dataset.status = "error";
}

window.addEventListener("pagehide", () => {
  void player?.dispose();
}, { once: true });
