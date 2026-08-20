// DERIK — the #ELITE league history chatbot.
// Talks to the Cloudflare Worker at API_URL, which proxies to Claude with a
// read-only SQL tool over the league history database. See worker/README.md.

const API_URL = "https://elite-league-chat.loganthein.workers.dev/api/chat";

const messagesEl = document.getElementById("messages");
const messagesOuterEl = document.getElementById("messagesOuter");
const composerSlotCenter = document.getElementById("composerSlotCenter");
const composerSlotBottom = document.getElementById("composerSlotBottom");

const history = []; // [{role, content}]
let sending = false;
let started = false;

// ---------- Composer (single instance, moved between the centered empty
// state and the fixed bottom bar on first send) ----------
const composer = document.createElement("div");
composer.className = "composer";
composer.innerHTML = `
  <textarea id="input" placeholder="Ask DERIK anything&hellip;" rows="1"></textarea>
  <button class="send-btn" id="sendBtn" aria-label="Send">&uarr;</button>
`;
composerSlotCenter.appendChild(composer);

const inputEl = composer.querySelector("#input");
const sendBtn = composer.querySelector("#sendBtn");

function startChat() {
  if (started) return;
  started = true;
  composerSlotBottom.appendChild(composer);
  document.body.classList.add("chatting");
}

// ---------- Did You Know ----------
function pickFact() {
  const today = new Date();
  const month = today.getMonth() + 1;
  const day = today.getDate();
  const matches = (FACTS.onthisday || []).filter((f) => f.month === month && f.day === day);
  if (matches.length) {
    const dayOfYear = Math.floor((today - new Date(today.getFullYear(), 0, 0)) / 86400000);
    return matches[dayOfYear % matches.length].text;
  }
  const pool = FACTS.record || [];
  if (!pool.length) return "";
  const dayOfYear = Math.floor((today - new Date(today.getFullYear(), 0, 0)) / 86400000);
  return pool[dayOfYear % pool.length];
}
document.getElementById("factText").innerHTML = renderMarkdown(pickFact());

// ---------- Markdown ----------
function renderMarkdown(text) {
  let html = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");

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

  html = html.replace(/((?:^[-*] .*$\n?)+)/gm, (block) => {
    const items = block.trim().split("\n").map((l) => l.replace(/^[-*]\s+/, ""));
    return "<ul>" + items.map((i) => `<li>${i}</li>`).join("") + "</ul>";
  });

  html = html
    .split(/\n{2,}/)
    .map((block) => (/^\s*<(table|ul|ol)/.test(block) ? block : `<p>${block.replace(/\n/g, "<br>")}</p>`))
    .join("");

  return html;
}

function addMessage(role, text) {
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
  messagesOuterEl.scrollTop = messagesOuterEl.scrollHeight;
  return bubble;
}

async function send(text) {
  if (sending || !text.trim()) return;
  sending = true;
  sendBtn.disabled = true;
  startChat();

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
          messagesOuterEl.scrollTop = messagesOuterEl.scrollHeight;
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
    inputEl.focus();
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

document.querySelectorAll(".chip").forEach((el) => {
  el.addEventListener("click", () => send(el.dataset.q));
});
