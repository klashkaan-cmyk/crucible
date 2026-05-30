"use strict";

// Zero-extra-dependency test using node:test + node:http. A new /login route
// should come with its own test alongside this one.

const { test } = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const { createApp } = require("../src/app");

function request(server, { method = "GET", path = "/", body } = {}) {
  const { port } = server.address();
  const payload = body ? JSON.stringify(body) : undefined;
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method, path, headers: { "content-type": "application/json" } },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode, body: data }));
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test("GET /health returns ok", async () => {
  const server = createApp().listen(0);
  try {
    const res = await request(server, { path: "/health" });
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), { ok: true });
  } finally {
    server.close();
  }
});
