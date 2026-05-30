"use strict";

// In-memory user store with safe password hashing helpers. Use these from any
// auth route you add -- never store or compare passwords in plaintext.

const { randomBytes, scryptSync, timingSafeEqual } = require("node:crypto");

/** @type {Map<string, { email: string, passwordHash: string, salt: string }>} */
const users = new Map();

function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return { salt, passwordHash: hash };
}

function verifyPassword(password, salt, passwordHash) {
  const candidate = scryptSync(password, salt, 64);
  const expected = Buffer.from(passwordHash, "hex");
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

function createUser(email, password) {
  const { salt, passwordHash } = hashPassword(password);
  users.set(email, { email, salt, passwordHash });
  return { email };
}

function findUser(email) {
  return users.get(email);
}

// Seed one user so a login route has something to authenticate against.
createUser("demo@example.com", "correct horse battery staple");

module.exports = { users, hashPassword, verifyPassword, createUser, findUser };
