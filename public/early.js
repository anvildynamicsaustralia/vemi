// Asks the Worker for the answers the first screen needs as soon as the page is read, while its
// scripts are still downloading, so they are waiting when the app first asks. `earlyAnswers.ts`
// hands each to the first read of its address, once. The time zone is only known here, which is
// why the page's own links cannot name today's address. Nothing here is needed: with no answer
// the app asks for itself.
//
// Two rules keep it cheap and honest. Once the app's main module has started (a return visit
// serves it from the cache, ahead of this async script) nothing is held, so a read after a write
// cannot be handed an older answer. And nobody signed in costs one request: /auth/me goes first,
// and the rest are asked for only when it says signed in, or at once when this device remembers
// a sign-in (the same marker the app keeps for an offline start).
(function () {
  if (window.vemiStarted === true) return;
  var held = {};
  window.vemiEarly = held;

  function ask(path) {
    try {
      // Read through at once, so a screen that never asks for it leaves no request open.
      var answer = fetch(path, { headers: { accept: "application/json" } }).then(function (response) {
        return response.arrayBuffer().then(function (body) {
          return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
        });
      });
      answer.catch(function () {});
      held[path] = { at: Date.now(), answer: answer };
    } catch {
      // The app asks for itself.
    }
  }

  function askRest() {
    if (window.vemiStarted === true) return;
    ["/api/tree", "/api/overview", "/api/appearance", "/api/first-run"].forEach(ask);
    try {
      var zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (typeof zone === "string" && zone !== "") ask("/api/today?tz=" + encodeURIComponent(zone));
    } catch {
      // Today's address is left to the app.
    }
  }

  var remembered = false;
  try {
    remembered = localStorage.getItem("vemi:signed-in:v1") !== null;
  } catch {
    // No storage: ask about the sign-in first.
  }

  ask("/auth/me");
  if (remembered) askRest();
  if (!held["/auth/me"]) return;
  held["/auth/me"].answer
    .then(function (response) { return response.clone().json(); })
    .then(function (me) {
      if (me && me.signedIn === true) {
        if (!remembered) askRest();
        return;
      }
      // Nobody signed in: what was asked for is a refusal, and a sign-in a moment later must not
      // be handed it. Only the first answer, about the sign-in itself, is kept.
      Object.keys(held).forEach(function (path) {
        if (path !== "/auth/me") delete held[path];
      });
    })
    .catch(function () {});
})();
