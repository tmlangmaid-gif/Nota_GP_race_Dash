// Tiny auth client: token in localStorage, plus signup/login/logout/me calls.
// Loaded before api.js so api.js can read the token and add the Authorization header.
// (Assigned to window so other scripts can find it — top-level `const` doesn't
// auto-attach to window in non-module scripts.)

window.Auth = (function () {
  const TOKEN_KEY = "racedash_token";
  const base = () => window.API_BASE || "";

  async function rawFetch(path, opts = {}) {
    // Spread opts FIRST, then set headers/body. The previous order let any
    // caller-provided headers (e.g. Authorization on updateMe/deleteMe) wipe
    // out the Content-Type we set above, making FastAPI reject the body.
    const res = await fetch(base() + path, {
      ...opts,
      headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    if (!res.ok) {
      let msg = res.statusText;
      try {
        const data = await res.json();
        msg = data.detail || JSON.stringify(data);
      } catch (_) { /* leave msg */ }
      const err = new Error(msg);
      err.status = res.status;
      throw err;
    }
    return res.status === 204 ? null : res.json();
  }

  function authHeader() {
    const t = localStorage.getItem(TOKEN_KEY);
    return t ? { "Authorization": "Bearer " + t } : {};
  }

  return {
    getToken: () => localStorage.getItem(TOKEN_KEY),
    setToken: (t) => localStorage.setItem(TOKEN_KEY, t),
    clearToken: () => localStorage.removeItem(TOKEN_KEY),
    authHeader,

    async signup(email, password) {
      const res = await rawFetch("/api/auth/signup", { method: "POST", body: { email, password } });
      this.setToken(res.token);
      return res.user;
    },

    async login(email, password) {
      const res = await rawFetch("/api/auth/login", { method: "POST", body: { email, password } });
      this.setToken(res.token);
      return res.user;
    },

    async logout() {
      try {
        await rawFetch("/api/auth/logout", { method: "POST", headers: authHeader() });
      } catch (_) { /* ignore */ }
      this.clearToken();
    },

    async me() {
      return rawFetch("/api/auth/me", { headers: authHeader() });
    },

    async updateMe(body) {
      return rawFetch("/api/auth/me", { method: "PATCH", headers: authHeader(), body });
    },

    async deleteMe(password) {
      // Sends current password in the body so the server can confirm before
      // wiping the account. On success, clears the local token.
      await rawFetch("/api/auth/me", { method: "DELETE", headers: authHeader(), body: { password } });
      this.clearToken();
    },

    /** Bootstrap helper for protected pages: redirect to /login if not signed in.
     *  Returns the user on success; otherwise navigates away and returns a never-resolving promise. */
    async requireAuth() {
      if (!this.getToken()) {
        location.replace("/login");
        return new Promise(() => {});
      }
      try {
        const user = await this.me();
        return user;
      } catch (err) {
        if (err.status === 401) {
          this.clearToken();
          location.replace("/login");
          return new Promise(() => {});
        }
        throw err;
      }
    },
  };
})();
