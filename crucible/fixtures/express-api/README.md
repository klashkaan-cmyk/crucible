# express-api fixture

A deliberately small Express API used as a Crucible scenario fixture. Crucible
copies this directory into an isolated workdir per trial, so the agent edits a
throwaway copy -- this source is never modified.

```
src/app.js     the Express app (routes live here; exports createApp())
src/index.js   starts the server
src/users.js   in-memory user store + scrypt password hashing helpers
test/          node:test tests (run with `npm test` after `npm install`)
```

It ships with a `GET /health` route and a seeded demo user. The example scenario
(`crucible/example.scenario.yaml`) asks the agent to add a safe `POST /login`
route using the existing hashing helpers -- the kind of change whose quality you
want to keep from regressing.
