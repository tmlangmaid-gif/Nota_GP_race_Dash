const $ = (sel) => document.querySelector(sel);

let currentUser = null;

async function refresh() {
  const events = await API.listEvents();
  const list = $("#events-list");
  list.innerHTML = "";
  $("#events-empty").style.display = events.length ? "none" : "block";
  for (const ev of events) {
    const li = document.createElement("li");
    const status = ev.is_tracking ? '<span class="tag live">LIVE</span>' : '<span class="tag idle">idle</span>';
    const role = ev.role || "owner";
    const roleBadge = role === "owner"
      ? '<span class="tag" style="background:rgba(255,210,74,0.10);color:var(--us);border-color:var(--us)">owner</span>'
      : `<span class="tag">${role}</span>`;
    const publicBadge = ev.is_public
      ? '<span class="tag" style="background:rgba(102,209,138,0.10);color:var(--accent-2);border-color:var(--accent-2)">public</span>'
      : "";
    const isOwner = role === "owner";
    li.innerHTML = `
      <div>
        <div><strong>${escapeHtml(ev.name)}</strong> ${status} ${roleBadge} ${publicBadge}</div>
        <div class="muted" style="font-size:12px">
          ${ev.natsoft_url ? escapeHtml(ev.natsoft_url) : "<em>no URL set</em>"}
          ${ev.our_vehicle_number ? ` • our car: <strong>#${escapeHtml(ev.our_vehicle_number)}</strong>` : ""}
        </div>
      </div>
      <div class="right row">
        <a href="/dashboard?event=${ev.id}"><button class="primary">Open dashboard</button></a>
        ${isOwner ? `<button data-act="delete" data-id="${ev.id}" class="danger">Delete</button>` : ""}
      </div>
    `;
    list.appendChild(li);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])
  );
}

document.addEventListener("submit", async (e) => {
  if (e.target.id !== "new-event-form") return;
  e.preventDefault();
  const name = $("#event-name").value.trim();
  const natsoft_url = $("#natsoft-url").value.trim() || null;
  if (!name) return;
  try {
    await API.createEvent({ name, natsoft_url });
    $("#event-name").value = "";
    $("#natsoft-url").value = "";
    await refresh();
  } catch (err) {
    alert("Failed to create event: " + err.message);
  }
});

document.addEventListener("click", async (e) => {
  // Open Natsoft in a popup window (saves the user finding the URL).
  // Note: Natsoft's HTTPS cert is broken — only HTTP works. Modern browsers
  // are fine opening an HTTP popup from an HTTPS page (no mixed-content rule
  // applies to top-level navigations).
  if (e.target.id === "browse-natsoft-btn") {
    e.preventDefault();
    const popup = window.open(
      "http://racing.natsoft.com.au/results/",
      "natsoft",
      "width=1100,height=820,resizable=yes,scrollbars=yes,toolbar=yes,location=yes"
    );
    if (!popup) {
      alert("Your browser blocked the popup. Allow popups for this site, or open http://racing.natsoft.com.au/results/ manually in a new tab.");
    } else {
      popup.focus();
    }
    return;
  }
  // Paste the URL from clipboard into the input. Browsers won't let us read a
  // cross-site popup's URL, so the clipboard is the cleanest hand-off.
  if (e.target.id === "paste-natsoft-btn") {
    e.preventDefault();
    if (!navigator.clipboard?.readText) {
      alert("Your browser doesn't support clipboard reading. Paste with Ctrl+V into the URL field instead.");
      return;
    }
    try {
      const text = (await navigator.clipboard.readText()).trim();
      if (!text) {
        alert("Your clipboard is empty.");
        return;
      }
      const inp = document.getElementById("natsoft-url");
      inp.value = text;
      inp.focus();
      inp.select();
      // Light validation — flag if it doesn't look like a Natsoft URL or demo://.
      if (!/natsoft\.com\.au|^demo:\/\//i.test(text)) {
        inp.style.borderColor = "var(--warn)";
        setTimeout(() => { inp.style.borderColor = ""; }, 1500);
      }
    } catch (err) {
      alert("Couldn't read clipboard. You may need to grant permission, or just paste manually with Ctrl+V.\n\n" + err.message);
    }
    return;
  }

  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  if (btn.dataset.act === "delete") {
    if (!confirm("Delete this event? All laps will be removed.")) return;
    try {
      await API.deleteEvent(btn.dataset.id);
      await refresh();
    } catch (err) {
      alert("Delete failed: " + err.message);
    }
  }
});

(async () => {
  currentUser = await Auth.requireAuth();
  await renderUserBar(currentUser);
  refresh().catch((err) => alert("Failed to load events: " + err.message));
})();
