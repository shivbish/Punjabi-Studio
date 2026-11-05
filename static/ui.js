/* Small shared UI helpers: element lookup, toast, modals, API calls, file reading. */

export const $ = (id) => document.getElementById(id);

export function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

/* ---------- API ---------- */

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }

  /** Worth trying again later (server trouble, conflict or rate limit). */
  get retryable() {
    return this.status >= 500 || [408, 409, 429].includes(this.status);
  }
}

/** Human-readable text from any error response the server can produce. */
export async function readError(response) {
  try {
    const data = await response.json();
    const detail = data?.detail;
    if (typeof detail === "string") return detail;
    if (typeof detail?.message === "string") return detail.message;          // 409 conflict
    if (Array.isArray(detail) && typeof detail[0]?.msg === "string") return detail[0].msg; // 422
  } catch {
    // Not JSON: fall through to the generic message.
  }
  return `Server returned ${response.status}.`;
}

/** fetch + JSON. Throws ApiError for non-2xx responses; network failures stay TypeErrors. */
export async function api(url, { method = "GET", json } = {}) {
  const options = { method };
  if (json !== undefined) {
    options.headers = { "Content-Type": "application/json" };
    options.body = JSON.stringify(json);
  }
  const response = await fetch(url, options);
  if (!response.ok) throw new ApiError(await readError(response), response.status);
  return response.json();
}

/** Network errors and retryable API errors are worth another attempt. */
export function isRetryable(error) {
  return !(error instanceof ApiError) || error.retryable;
}

/* ---------- Toast ---------- */

let toastTimer = null;

export function toast(message, kind = "") {
  const el = $("toast");
  if (!el) return;
  el.textContent = message;
  el.className = "toast" + (kind ? ` ${kind}` : "");
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, kind === "error" ? 6000 : 3500);
}

/* ---------- Modals ---------- */

let cancelActive = null;

/**
 * Shared modal plumbing. `fill(body)` builds the content; `confirmValue()` is
 * what a confirm click resolves with; `cancelValue` is what Escape, Cancel and
 * a click outside resolve with. Focus returns to whatever opened the modal.
 */
function showModal({ title, okLabel, fill, confirmValue, cancelValue, initialFocus }) {
  return new Promise((resolve) => {
    cancelActive?.();   // never leave an earlier modal's promise hanging

    const modal = $("modal");
    const yes = $("modal-yes");
    const no = $("modal-no");
    const opener = document.activeElement;

    $("modal-title").textContent = title;
    const body = $("modal-body");
    body.replaceChildren();
    fill(body);
    yes.textContent = okLabel;

    function done(result) {
      if (cancelActive === cancel) cancelActive = null;
      modal.hidden = true;
      document.removeEventListener("keydown", onKey);
      yes.onclick = null;
      no.onclick = null;
      modal.onclick = null;
      opener?.focus?.();
      resolve(result);
    }
    function cancel() {
      done(cancelValue);
    }
    function onKey(event) {
      if (event.key === "Escape") cancel();
    }

    yes.onclick = () => done(confirmValue());
    no.onclick = cancel;
    modal.onclick = (event) => { if (event.target === modal) cancel(); };
    document.addEventListener("keydown", onKey);
    cancelActive = cancel;

    modal.hidden = false;
    const target = initialFocus ? initialFocus() : yes;
    target.focus();
    target.select?.();   // text inputs: select the existing value
  });
}

/**
 * Show a modal with a message and optional item groups.
 * blocks: (string | { heading: string, items: string[] })[]
 * Resolves true when confirmed, false when cancelled.
 */
export function ask(title, blocks, okLabel = "OK") {
  return showModal({
    title,
    okLabel,
    confirmValue: () => true,
    cancelValue: false,
    fill(body) {
      for (const block of blocks) {
        if (typeof block === "string") {
          const p = document.createElement("p");
          p.textContent = block;
          body.appendChild(p);
          continue;
        }
        const heading = document.createElement("div");
        heading.className = "modal-heading";
        heading.textContent = block.heading;
        body.appendChild(heading);

        const list = document.createElement("ul");
        for (const item of block.items.slice(0, 40)) {
          const li = document.createElement("li");
          li.textContent = item;
          list.appendChild(li);
        }
        if (block.items.length > 40) {
          const li = document.createElement("li");
          li.className = "muted";
          li.textContent = `…and ${block.items.length - 40} more`;
          list.appendChild(li);
        }
        body.appendChild(list);
      }
    },
  });
}

/**
 * Ask for a short piece of text. Resolves the trimmed value, or null when
 * cancelled. The caller decides what an empty string means.
 */
export function promptText(title, label, defaultValue = "", okLabel = "OK") {
  let input = null;
  return showModal({
    title,
    okLabel,
    cancelValue: null,
    confirmValue: () => input.value.trim(),
    initialFocus: () => input,
    fill(body) {
      const field = document.createElement("label");
      field.className = "field";
      const caption = document.createElement("span");
      caption.textContent = label;
      input = document.createElement("input");
      input.type = "text";
      input.value = defaultValue;
      input.autocomplete = "off";
      input.spellcheck = false;
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          $("modal-yes").click();
        }
      });
      field.append(caption, input);
      body.appendChild(field);
    },
  });
}

/* ---------- Files ---------- */

export function readFileText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("could not read file"));
    reader.readAsText(file);
  });
}

export function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoking immediately can cancel the download in Firefox and Safari.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
