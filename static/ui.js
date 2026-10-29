/* Small shared UI helpers: element lookup, toast, confirmation modal, file reading. */

export const $ = (id) => document.getElementById(id);

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

/**
 * Show a modal with a message and optional item groups.
 * blocks: string | { heading: string, items: string[] }[]
 * Resolves true when confirmed, false when cancelled.
 */
export function ask(title, blocks, okLabel = "OK") {
  return new Promise((resolve) => {
    const modal = $("modal");
    const body = $("modal-body");
    const yes = $("modal-yes");
    const no = $("modal-no");

    $("modal-title").textContent = title;
    body.replaceChildren();

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

    yes.textContent = okLabel;

    function done(result) {
      modal.hidden = true;
      document.removeEventListener("keydown", onKey);
      yes.onclick = null;
      no.onclick = null;
      modal.onclick = null;
      resolve(result);
    }
    function onKey(event) {
      if (event.key === "Escape") done(false);
    }

    yes.onclick = () => done(true);
    no.onclick = () => done(false);
    modal.onclick = (event) => { if (event.target === modal) done(false); };
    document.addEventListener("keydown", onKey);

    modal.hidden = false;
    yes.focus();
  });
}

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
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
