const elements = {
  count: document.querySelector("#cart-count"),
  empty: document.querySelector("#empty-state"),
  grid: document.querySelector("#cart-grid"),
  meta: document.querySelector("#cart-meta"),
  mount: document.querySelector("#player"),
  nowPlaying: document.querySelector("#now-playing-title"),
  random: document.querySelector("#random-cart"),
  runtimeLight: document.querySelector(".runtime-light"),
  search: document.querySelector("#cart-search"),
  status: document.querySelector("#runtime-status"),
  template: document.querySelector("#cart-card-template"),
};

const state = {
  carts: [],
  visible: [],
  player: undefined,
  selectedId: undefined,
  selectionGeneration: 0,
};

function setStatus(message, light = "idle") {
  elements.status.textContent = message;
  elements.runtimeLight.dataset.runtimeLight = light;
}

function normalized(value) {
  return value.toLocaleLowerCase().normalize("NFKD");
}

function updateCount() {
  elements.count.textContent = state.visible.length === state.carts.length
    ? String(state.carts.length)
    : `${state.visible.length}/${state.carts.length}`;
  elements.random.disabled = state.visible.length === 0;
}

function updateSelectedCards() {
  for (const card of elements.grid.querySelectorAll(".cart-card")) {
    const selected = card.dataset.cartId === state.selectedId;
    card.dataset.selected = String(selected);
    card.setAttribute("aria-pressed", String(selected));
  }
}

function renderCards() {
  const fragment = document.createDocumentFragment();
  for (const cart of state.visible) {
    const card = elements.template.content.firstElementChild.cloneNode(true);
    card.dataset.cartId = cart.id;
    card.dataset.selected = String(cart.id === state.selectedId);
    card.setAttribute("aria-label", `Play ${cart.title}`);
    card.setAttribute("aria-pressed", String(cart.id === state.selectedId));
    const image = card.querySelector("img");
    const placeholder = card.querySelector(".cart-card__placeholder");
    if (cart.thumbnailUrl === null) {
      image.remove();
      placeholder.hidden = false;
    } else {
      image.src = cart.thumbnailUrl;
      placeholder.hidden = true;
    }
    card.querySelector(".cart-card__rank").textContent = cart.rank === null
      ? "P8"
      : `#${String(cart.rank).padStart(3, "0")}`;
    card.querySelector("strong").textContent = cart.title;
    card.querySelector("small").textContent = `${cart.format.toUpperCase()} · ${Math.ceil(cart.bytes / 1024)} KB`;
    fragment.append(card);
  }
  elements.grid.replaceChildren(fragment);
  elements.empty.hidden = state.visible.length !== 0;
  updateCount();
}

function filterCarts() {
  const query = normalized(elements.search.value.trim());
  state.visible = query === ""
    ? state.carts
    : state.carts.filter((cart) => normalized(`${cart.title} ${cart.displayName}`).includes(query));
  renderCards();
}

async function selectCart(cart, { focusCanvas = true } = {}) {
  if (cart === undefined) return;
  const generation = ++state.selectionGeneration;
  state.selectedId = cart.id;
  updateSelectedCards();
  elements.nowPlaying.textContent = cart.title;
  elements.meta.textContent = `${cart.displayName} · ${cart.format.toUpperCase()} · ${Math.ceil(cart.bytes / 1024)} KB`;
  setStatus("Reading local cartridge…", "loading");
  document.body.dataset.progress = "cart-fetch";
  try {
    const response = await fetch(cart.cartUrl);
    if (!response.ok) throw new Error(`Unable to read cartridge: HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (generation !== state.selectionGeneration) return;
    setStatus("Loading cartridge…", "loading");
    document.body.dataset.progress = "cart-load";
    await state.player.loadCart(bytes, { displayName: cart.displayName });
    if (generation !== state.selectionGeneration) return;
    await state.player.start();
    history.replaceState(null, "", `?cart=${encodeURIComponent(cart.id)}`);
    if (focusCanvas) {
      state.player.canvas.focus({ preventScroll: true });
    } else {
      elements.grid.querySelector(`[data-cart-id="${CSS.escape(cart.id)}"]`)
        ?.focus({ preventScroll: true });
    }
  } catch (error) {
    if (generation !== state.selectionGeneration) return;
    setStatus(error instanceof Error ? error.message : String(error), "fault");
    document.body.dataset.progress = "recoverable-error";
  }
}

function moveCardFocus(current, direction) {
  const cards = [...elements.grid.querySelectorAll(".cart-card")];
  const index = cards.indexOf(current);
  if (index < 0) return;
  const columns = getComputedStyle(elements.grid).gridTemplateColumns.split(" ").length;
  const offsets = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columns, ArrowDown: columns };
  const next = Math.max(0, Math.min(cards.length - 1, index + offsets[direction]));
  cards[next]?.focus();
}

async function boot() {
  const [catalogResponse, manifestResponse] = await Promise.all([
    fetch("/api/carts"),
    fetch("/release/manifest.json"),
  ]);
  if (!catalogResponse.ok) throw new Error(`Catalog unavailable: HTTP ${catalogResponse.status}`);
  if (!manifestResponse.ok) throw new Error(`Player manifest unavailable: HTTP ${manifestResponse.status}`);
  const catalog = await catalogResponse.json();
  const manifest = await manifestResponse.json();
  if (catalog.schemaVersion !== 1 || !Array.isArray(catalog.carts)) {
    throw new Error("Unsupported local catalog");
  }
  const playerStylesheet = document.createElement("link");
  playerStylesheet.rel = "stylesheet";
  playerStylesheet.href = new URL(manifest.artifacts.styles.path, new URL("/release/", location.href)).href;
  const galleryStylesheet = document.querySelector('link[href="/gallery.css"]');
  document.head.insertBefore(playerStylesheet, galleryStylesheet);
  const playerModule = await import(
    new URL(manifest.artifacts.main.path, new URL("/release/", location.href)).href
  );
  state.player = await playerModule.createPico8WebPlayer({ root: elements.mount });
  state.player.on("state", (event) => {
    const light = event.state === "faulted"
      ? "fault"
      : ["running", "audio-blocked"].includes(event.state) ? "playing" : "idle";
    setStatus(event.message, light);
  });
  state.player.on("frame", () => {
    document.body.dataset.status = "complete";
    document.body.dataset.progress = "playing";
    setStatus("Running", "playing");
  });
  state.player.on("fault", (event) => {
    setStatus(`${event.error.code}: ${event.error.message}`, "fault");
    document.body.dataset.progress = "recoverable-error";
  });
  state.carts = catalog.carts;
  state.visible = state.carts;
  renderCards();
  document.body.dataset.status = "ready";
  document.body.dataset.progress = "choose-cart";
  setStatus("Ready — choose a cartridge", "ready");

  const requested = new URLSearchParams(location.search).get("cart");
  if (requested !== null && state.carts.some((cart) => cart.id === requested)) {
    document.querySelector(`[data-cart-id="${CSS.escape(requested)}"]`)?.focus();
  }
}

elements.search.addEventListener("input", filterCarts);
elements.search.addEventListener("keydown", (event) => {
  if (event.key === "ArrowDown") {
    event.preventDefault();
    elements.grid.querySelector(".cart-card")?.focus();
  }
});
elements.grid.addEventListener("click", (event) => {
  const card = event.target.closest(".cart-card");
  if (card === null) return;
  void selectCart(
    state.carts.find((cart) => cart.id === card.dataset.cartId),
    { focusCanvas: event.detail !== 0 },
  );
});
elements.grid.addEventListener("keydown", (event) => {
  if (!(event.target instanceof HTMLButtonElement) || !event.key.startsWith("Arrow")) return;
  event.preventDefault();
  moveCardFocus(event.target, event.key);
});
elements.random.addEventListener("click", () => {
  const cart = state.visible[Math.floor(Math.random() * state.visible.length)];
  void selectCart(cart);
});
document.addEventListener("keydown", (event) => {
  if (event.key === "/" && !(event.target instanceof HTMLInputElement)) {
    event.preventDefault();
    elements.search.focus();
  }
});
window.addEventListener("pagehide", (event) => {
  if (!event.persisted) void state.player?.dispose();
});

boot().catch((error) => {
  setStatus(error instanceof Error ? error.message : String(error), "fault");
  document.body.dataset.status = "error";
  document.body.dataset.progress = "boot-error";
});
