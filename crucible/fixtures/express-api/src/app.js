"use strict";

// The Express app (no listen() here, so tests can import it). Add new routes
// to this file. A POST /login route does not exist yet -- that is the task.

const express = require("express");

function createApp() {
  const app = express();
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  return app;
}

module.exports = { createApp };
