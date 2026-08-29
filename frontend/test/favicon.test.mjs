import { test } from "node:test";
import assert from "node:assert/strict";
import { faviconSrc } from "../js/favicon.js";

/* A row as GET /data/sites.json hands it over: the origin's URL, plus the path
   this server serves its own normalized copy from. */
const ROW = {
  name: "Example",
  url: "example.com",
  favicon: "https://cdn.example.com/favicon.ico",
  faviconPath: "/favicons/example.com-1a2b3c4d5e.png",
};

// The bug this replaced: pointing <img src> at row.favicon, which plenty of
// hosts refuse once the request comes from another domain.
test("the icon is loaded from this server, never from the site's own origin", () => {
  assert.equal(faviconSrc(ROW, ""), "/favicons/example.com-1a2b3c4d5e.png");
  assert.ok(!faviconSrc(ROW, "").includes("cdn.example.com"));
});

test("a row the server has no copy for falls back to the letter", () => {
  // No served path at all — the row has no favicon, or one the server will not
  // fetch. Either way the caller gets "" and draws the site's initial.
  assert.equal(faviconSrc({ url: "example.com" }, ""), "");
  assert.equal(faviconSrc({ url: "example.com", faviconPath: "" }, ""), "");
  assert.equal(faviconSrc(null, ""), "");
  // And the third-party URL on its own is never enough to load an image.
  assert.equal(faviconSrc({ url: "example.com", favicon: ROW.favicon }, ""), "");
});

// The rows are stored data rendered into a page, so the path is matched against
// the shape the server hands out rather than trusted.
test("only the server's own icon path is ever loaded", () => {
  const rejected = [
    "https://evil.example/favicon.png",
    "//evil.example/favicon.png",
    "javascript:alert(1)",
    "data:image/png;base64,iVBORw0K",
    "/favicons/../../etc/passwd",
    "/favicons/example.com-1a2b3c4d5e.svg",
    "/favicons/example.com.png",
    "/data/sites.json",
    "/favicons/",
  ];
  for (const faviconPath of rejected) {
    assert.equal(faviconSrc({ url: "example.com", faviconPath }, ""), "", faviconPath);
  }
});

// The icons come from the same process as /data/sites.json, so a separately
// hosted SPA has to ask that origin for them too.
test("a separately hosted SPA loads the icon from the API origin", () => {
  assert.equal(faviconSrc(ROW, "https://api.example.dev"), "https://api.example.dev" + ROW.faviconPath);
  assert.equal(faviconSrc(ROW, "https://api.example.dev/"), "https://api.example.dev" + ROW.faviconPath);
  assert.equal(faviconSrc(ROW, undefined), ROW.faviconPath);
});
