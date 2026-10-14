// Preloaded with `node --import` into a monitor that cannot be pointed at a local
// server (applied-skills-sync reads the skill pages from a fixed learn.microsoft.com
// address): fetch() answers from the routes in the JSON file FAKE_FETCH_ROUTES,
// { "<url>": { "status": 200, "body": "..." } }. An address without a route is a
// 404 that says so on stderr, so a run never leaves the machine and a test can
// tell that it asked for something it did not set up.
import { readFileSync } from "node:fs";

const routes = JSON.parse(readFileSync(process.env.FAKE_FETCH_ROUTES, "utf8"));

globalThis.fetch = async (input) => {
  const url = String(input);
  const route = routes[url];
  if (!route) console.error(`FAKE FETCH: no route for ${url}`);
  return new Response(route ? (route.body ?? "") : "no route", {
    status: route ? (route.status ?? 200) : 404,
  });
};
