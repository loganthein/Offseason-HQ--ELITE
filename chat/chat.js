// #ELITE League AI chat frontend.
// Talks to the Cloudflare Worker at API_URL, which proxies to Claude with a
// read-only SQL tool over the league history database. See worker/README.md.

const API_URL = "https://elite-league-chat.loganthein.workers.dev/api/chat";

const messagesEl = document.getElementById("messages");
const emptyStateEl = document.getElementById("emptyState");
const inputEl = document.getElementById("input");
const sendBtn = document.getElementById("sendBtn");

const history = []; // [{role, content}]
let sending = false;

function renderMarkdown(text) {
  let html = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  // fenced/inline code
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  // bold / italic
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");

  // simple pipe tables
  html = html.replace(/((?:^\|.*\|\s*$\n?)+)/gm, (block) => {
    const rows = block.trim().split("\n").map((r) => r.trim());
    if (rows.length < 2 || !/^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?$/.test(rows[1])) return block;
    const cells = (row) => row.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
    const head = cells(rows[0]);
    const body = rows.slice(2).map(cells);
    let t = "<table><thead><tr>" + head.map((c) => `<th>${c}</th>`).join("") + "</tr></thead><tbody>";
    for (const r of body) t += "<tr>" + r.map((c) => `<td>${c}</td>`).join("") + "</tr>";
    return t + "</tbody></table>";
  });

  // lists
  html = html.replace(/((?:^[-*] .*$\n?)+)/gm, (block) => {
    const items = block.trim().split("\n").map((l) => l.replace(/^[-*]\s+/, ""));
    return "<ul>" + items.map((i) => `<li>${i}</li>`).join("") + "</ul>";
  });

  // paragraphs: blank-line separated, but skip lines already turned into block tags
  html = html
    .split(/\n{2,}/)
    .map((block) => (/^\s*<(table|ul|ol)/.test(block) ? block : `<p>${block.replace(/\n/g, "<br>")}</p>`))
    .join("");

  return html;
}

function addMessage(role, text) {
  emptyStateEl.style.display = "none";
  const row = document.createElement("div");
  row.className = `msg ${role}`;
  const bubble = document.createElement("div");
  bubble.className = "msg-bubble";
  if (role === "user") {
    bubble.textContent = text;
  } else {
    bubble.innerHTML = renderMarkdown(text || "");
  }
  row.appendChild(bubble);
  messagesEl.appendChild(row);
  window.scrollTo(0, document.body.scrollHeight);
  return bubble;
}

async function send(text) {
  if (sending || !text.trim()) return;
  sending = true;
  sendBtn.disabled = true;

  addMessage("user", text);
  history.push({ role: "user", content: text });
  inputEl.value = "";
  inputEl.style.height = "auto";

  const assistantBubble = addMessage("assistant", "");
  const cursor = document.createElement("span");
  cursor.className = "cursor";
  assistantBubble.appendChild(cursor);

  let full = "";
  try {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: history }),
    });
    if (!res.ok || !res.body) throw new Error(`Request failed (${res.status})`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const evt = JSON.parse(line.slice(6));
        if (evt.text) {
          full += evt.text;
          assistantBubble.innerHTML = renderMarkdown(full);
          assistantBubble.appendChild(cursor);
          window.scrollTo(0, document.body.scrollHeight);
        }
      }
    }
  } catch (e) {
    full = full || "Something went wrong talking to the league database. Try again in a moment.";
    assistantBubble.innerHTML = renderMarkdown(full);
  } finally {
    cursor.remove();
    history.push({ role: "assistant", content: full });
    sending = false;
    sendBtn.disabled = false;
  }
}

sendBtn.addEventListener("click", () => send(inputEl.value));
inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send(inputEl.value);
  }
});
inputEl.addEventListener("input", () => {
  inputEl.style.height = "auto";
  inputEl.style.height = `${Math.min(inputEl.scrollHeight, 160)}px`;
});

document.querySelectorAll(".suggestion").forEach((el) => {
  el.addEventListener("click", () => send(el.dataset.q));
});
