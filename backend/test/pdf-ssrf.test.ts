/**
 * The PDF renderer runs Chrome on the server, so it must not fetch internal
 * addresses that a template's image URLs point at.
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { SRC } from "./support/harness";

/* eslint-disable @typescript-eslint/no-var-requires */
const { rendererMayFetch, htmlToPdf, closePdfBrowser } = require(path.join(SRC, "lib/pdf"));

const dns: Record<string, string[]> = {
  "cdn.example.com": ["93.184.216.34"],
  "sneaky.example.com": ["10.0.0.7"],
};
const resolve = async (host: string) => {
  if (!(host in dns)) throw new Error("ENOTFOUND");
  return dns[host];
};

describe("PDF renderer request filter", () => {
  test("inline data and public web addresses are allowed", async () => {
    assert.equal(await rendererMayFetch("data:image/png;base64,iVBORw0KGgo=", resolve), true);
    assert.equal(await rendererMayFetch("https://cdn.example.com/logo.png", resolve), true);
    assert.equal(await rendererMayFetch("http://cdn.example.com/sign.png", resolve), true);
  });

  test("internal, local and non-web targets are refused", async () => {
    for (const u of [
      "http://169.254.169.254/latest/meta-data/", "http://127.0.0.1:8080/admin", "http://localhost/x.png",
      "http://[::1]/x.png", "http://10.1.2.3/x.png", "https://sneaky.example.com/logo.png", "https://db.internal/x",
      "https://cdn.example.com:6379/x", "file:///etc/passwd", "ftp://cdn.example.com/x", "about:blank#x", "chrome://settings",
    ]) {
      assert.equal(await rendererMayFetch(u, resolve), false, u);
    }
  });
});

describe("PDF renderer in Chrome", () => {
  after(async () => closePdfBrowser?.());

  test("a template pointing at an internal address renders without the server fetching it", async (t) => {
    let hits = 0;
    const server = http.createServer((_req, res) => {
      hits++;
      res.writeHead(200, { "Content-Type": "image/png" });
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as any).port;
    try {
      const html = `<html><body><h1>Offer letter</h1>
        <img src="http://127.0.0.1:${port}/logo.png">
        <img src="http://localhost:${port}/signature.png">
        <div style="background:url(http://127.0.0.1:${port}/bg.png)">x</div>
        <img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">
      </body></html>`;
      const pdf = await htmlToPdf(html, {});
      if (!pdf) {
        t.skip("Chrome is not installed on this machine");
        return;
      }
      assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
      assert.equal(hits, 0, "the internal server was never contacted");
    } finally {
      server.close();
    }
  });
});
