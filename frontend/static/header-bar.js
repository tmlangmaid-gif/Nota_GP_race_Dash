// Populates the user-info portion of the page header (email + Settings link + Log out).
// Looks for a container with id="user-bar" and inserts content into it.
async function renderUserBar(user) {
  const wrap = document.getElementById("user-bar");
  if (!wrap) return;
  wrap.innerHTML = `
    <span class="muted" style="font-size: 13px;">${escapeHtmlSafe(user.email)}</span>
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
