// The page under test: a small form whose switches toggle when the whole row is
// clicked (a real bug this project was once used to catch), a password field, and
// a button that calls an API. The page reports every toggle and call back to the
// server, so the test can check what really happened in the browser.

import http from "node:http";

const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Banner form</title>
<style>body{font:14px sans-serif;max-width:1200px;margin:24px auto} .row{margin:14px 0} label{display:block;cursor:pointer}</style></head><body>
<h1>Banner form</h1>
<div class="row"><label><input type="checkbox" role="switch"> Add CIS countries</label></div>
<div class="row"><label><input type="checkbox" role="switch"> Ad labelling</label></div>
<div class="row"><label>Password <input type="password" id="pw"></label></div>
<button id="save">Save</button> <span id="status" role="status"></span>
<script>
const report = (what) => fetch("/seen?" + what);
document.querySelectorAll("input[type=checkbox]").forEach((el, i) =>
  el.addEventListener("change", () => report("toggle=" + i + ":" + el.checked)));
document.getElementById("save").onclick = async () => {
  const res = await fetch("/api/save", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: document.getElementById("pw").value }) });
  document.getElementById("status").textContent = res.ok ? "Saved" : "Save failed";
};
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
    res.end(page);
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({ url: `http://127.0.0.1:${server.address().port}/`, seen, close: () => server.close() })),
  );
}
