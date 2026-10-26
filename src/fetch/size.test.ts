import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSize } from "./size.ts";

const cases: [string, ReturnType<typeof parseSize>][] = [
  ["1,5 kg", { amount: 1500, unit: "g" }],
  ["0,6 kg", { amount: 600, unit: "g" }],
  ["500 g", { amount: 500, unit: "g" }],
  ["500g", { amount: 500, unit: "g" }],
  ["400 gr.", { amount: 400, unit: "g" }],
  ["1 l", { amount: 1000, unit: "ml" }],
  ["1,5 ltr", { amount: 1500, unit: "ml" }],
  ["33 cl", { amount: 330, unit: "ml" }],
  ["4 dl", { amount: 400, unit: "ml" }],
  ["400 ml", { amount: 400, unit: "ml" }],
  ["3 pak", { amount: 3, unit: "stk" }],
  ["1 stk", { amount: 1, unit: "stk" }],
  ["10 stk.", { amount: 10, unit: "stk" }],
  ["4 x 125 g", { amount: 500, unit: "g" }],
  ["6x0,33 l", { amount: 1980, unit: "ml" }],
  ["ca. 1 kg", { amount: 1000, unit: "g" }],
  ["400-500 g", { amount: 400, unit: "g" }],
  ["1.000 g", { amount: 1000, unit: "g" }],
  ["1.5 kg", { amount: 1500, unit: "g" }],
  ["", null],
  ["stor", null],
  ["2 bakker", null],
];

for (const [input, expected] of cases) {
  test(`parseSize(${JSON.stringify(input)})`, () => {
    assert.deepEqual(parseSize(input), expected);
  });
}
