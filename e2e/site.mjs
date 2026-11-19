// The page under test: a small form whose switches toggle when the whole row is
// clicked (a real bug this project was once used to catch), a password field, a
// button that calls an API, and a canvas that only a screenshot can find. The page reports every toggle and call back to the
// server, so the test can check what really happened in the browser.

import http from "node:http";

const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Banner form</title>
<style>body{font:14px sans-serif;max-width:1200px;margin:24px auto} .row{margin:14px 0} label{display:block;cursor:pointer}</style></head><body>
<h1>Banner form</h1>
<div class="row"><label><input type="checkbox" role="switch"> Add CIS countries</label></div>
<div class="row"><label><input type="checkbox" role="switch"> Ad labelling</label></div>
<div class="row"><label>Password <input type="password" id="pw"></label></div>
<button id="save">Save</button> <span id="status" role="status"></span>
<canvas id="pad" width="200" height="60" style="position:absolute;left:600px;top:300px;background:#1565c0"></canvas>
<script>
const report = (what) => fetch("/seen?" + what);
document.querySelectorAll("input[type=checkbox]").forEach((el, i) =>
  el.addEventListener("change", () => report("toggle=" + i + ":" + el.checked)));
// something only eyes can find: a canvas has no place in the page tree
document.getElementById("pad").onclick = () => report("canvas");
document.getElementById("save").onclick = async () => {
  const res = await fetch("/api/save", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: document.getElementById("pw").value }) });
  document.getElementById("status").textContent = res.ok ? "Saved" : "Save failed";
};
</script></body></html>`;

// A side panel over the page with a list that scrolls on its own, and under a
// cover a second list nobody can see: scrolling must move the first one for real
// and refuse to "scroll" the second.
const items = (label) => Array.from({ length: 40 }, (_, i) => `<button style="display:block;height:40px;width:100%">${label} ${i + 1}</button>`).join("");
const panel = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Panel</title></head><body style="margin:0">
<h1>Page under the panel</h1>
<div id="buried" style="position:absolute;left:20px;top:100px;width:300px;height:300px;overflow:auto">${items("Buried")}</div>
<div id="cover" style="position:fixed;left:0;top:80px;width:400px;height:400px;background:#eee"></div>
<aside id="list" style="position:fixed;right:0;top:0;width:400px;height:600px;overflow:auto;background:#fff">${items("Notice")}</aside>
<script>
const report = (what) => fetch("/seen?" + what);
for (const id of ["list", "buried"]) {
  let told = false;
  document.getElementById(id).addEventListener("scroll", () => { if (!told) { told = true; report(id + "-scrolled"); } });
}
</script></body></html>`;

// A page too big for the model's budget, built the way real portals are: the
// header is fixed but sits at the END of the DOM, its icons have no names, and a
// "Notices" widget far down the page has the same title as the panel the bell opens.
const rows = Array.from({ length: 420 }, (_, i) => `<p><a href="#r${i}">Report line ${i + 1}</a> <span>amount ${i * 7}</span></p>`).join("");
const big = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Big</title></head><body style="margin:0;padding-top:60px">
<h1>Dashboard</h1>
${rows}
<section><h2>Notices</h2><ul><li>Old notice 1</li><li>Old notice 2</li></ul></section>
<div id="portal"><div style="position:fixed;top:0;left:0;right:0;height:50px;background:#fff">
  <button data-testid="menu-chat" style="width:36px;height:36px"><svg width="16" height="16"></svg></button>
  <button data-testid="menu-communication" style="width:36px;height:36px" onclick="openPanel()"><svg width="16" height="16"></svg></button>
  <button data-testid="menu-support" style="width:36px;height:36px"><svg width="16" height="16"></svg></button>
</div></div>
<script>
function openPanel() {
  const d = document.createElement("div");
  d.style.cssText = "position:fixed;top:50px;right:0;width:400px;height:500px;background:#fff;overflow:auto";
  d.innerHTML = "<h2>Notices</h2><ul><li>Fresh notice 1</li><li>Fresh notice 2</li></ul>";
  document.body.appendChild(d);
}
</script></body></html>`;

/** Starts the site on a free port. `seen` collects what the page reported. */
export function startSite() {
  const seen = [];
  const server = http.createServer((req, res) => {
    if (req.url.startsWith("/seen?")) {
      seen.push(decodeURIComponent(req.url.slice(6)));
      return res.end("ok");
    }
    if (req.url === "/api/save") {
      seen.push("save");
      res.writeHead(200, { "content-type": "application/json" });
      return res.end('{"ok":true}');
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(req.url === "/panel" ? panel : req.url === "/big" ? big : page);
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({ url: `http://127.0.0.1:${server.address().port}/`, seen, close: () => server.close() })),
  );
}
