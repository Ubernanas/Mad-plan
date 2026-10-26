import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { mondayOf } from "../week.ts";
import { lastValidDay, parseLeaflets, weeklyLeaflet } from "./validity.ts";

const html = readFileSync(new URL("../../fixtures/html/etilbudsavis__netto.html", import.meta.url), "utf8");

test("reads every leaflet with its validity from the chain page", () => {
  const leaflets = parseLeaflets(html);
  assert.deepEqual(leaflets.map((l) => l.label), ["Netto Nonfood AU44", "Netto uge 44", "Halloween"]);
  const week = leaflets.find((l) => l.label === "Netto uge 44")!;
  assert.equal(week.validFrom.toISOString(), "2026-10-23T22:00:00.000Z"); // Saturday 24 Oct, 00:00 local
  assert.equal(week.validUntil.toISOString(), "2026-10-30T23:00:00.000Z"); // Saturday 31 Oct, 00:00 local
});

test("picks the weekly grocery leaflet for the plan week, not nonfood or seasonal", () => {
  const leaflet = weeklyLeaflet(parseLeaflets(html), mondayOf("2026-W44"));
  assert.equal(leaflet?.label, "Netto uge 44");
});

test("its last valid day is Friday, the day before it stops at midnight", () => {
  assert.equal(lastValidDay(new Date("2026-10-30T23:00:00.000Z")), "2026-10-30");
});

test("no leaflet in force on the plan week's Monday gives null", () => {
  assert.equal(weeklyLeaflet(parseLeaflets(html), mondayOf("2026-W46")), null);
  assert.deepEqual(parseLeaflets("<html>Et øjeblik…</html>"), []);
});
