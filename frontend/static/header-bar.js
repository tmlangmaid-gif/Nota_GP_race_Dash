// Populates the user-info portion of the page header (email + Settings link + Log out).
// Looks for a container with id="user-bar" and inserts content into it.
async function renderUserBar(user) {
  const wrap = document.getElementById("user-bar");
  if (!wrap) return;
  // Admin link only renders for admin users — server-driven via /me's is_admin.
  const adminLink = user && user.is_admin
    ? `<a href="/admin"><button class="icon-btn" title="Admin panel" style="border-color: var(--us); color: var(--us);">Admin</button></a>`
    : "";
  wrap.innerHTML = `
    <span class="muted" style="font-size: 13px;">${escapeHtmlSafe(user.email)}</span>
    ${adminLink}
    <a href="/workflow"><button class="icon-btn" title="How Race Dash works">How it works</button></a>
    <a href="/settings"><button class="icon-btn">Settings</button></a>
    <button class="icon-btn" id="logout-btn">Log out</button>
  `;
  document.getElementById("logout-btn").addEventListener("click", async () => {
    await Auth.logout();
    location.replace("/login");
  });
}

function escapeHtmlSafe(s) {
  return String(s).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])
  );
}
