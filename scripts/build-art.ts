// Makes the page's icons and fonts: npm run build-art
// Flaticon PNGs (512 px) become small WebP copies in public/art/, the icons drawn
// for the app (art/drawn/*.svg) are copied as they are, and the two fonts are
// copied from their npm packages so the page needs no font service and works offline.
// Run it again after adding icons; the output is committed, so deploys need no build step.

import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";

const PNG_DIR = join("Kawaii png", "png");
const OUT = join("public", "art");
const SIZE = 320; // shown at up to ~140 px; sharp enough on phone screens

/** Icon name in the page → Flaticon file. */
const PNGS: Record<string, string> = {
  chicken: "026-chicken.png",
  steak: "021-steak.png",
  potato: "015-potato.png",
  onion: "013-onion.png",
  carrot: "020-carrot.png",
  pepper: "005-pepper.png",
  broccoli: "002-broccoli.png",
  rice: "019-rice-bowl.png",
  tomato: "017-tomato.png",
  beans: "011-beans.png",
  garlic: "006-garlic.png",
  egg: "025-boiled-egg.png",
  cucumber: "007-cucumber.png",
  mushroom: "012-mushroom.png",
  zucchini: "018-zucchini.png",
  corn: "001-corn.png",
  peas: "009-peas.png",
  aubergine: "010-aubergine.png",
  olive: "004-olive.png",
  pumpkin: "003-pumpkin.png",
  beet: "008-beet.png",
  radish: "016-radish.png",
  salad: "003-salad.png",
  milk: "017-milk-bottle.png",
  shrimp: "016-fried-shrimp.png",
  ramen: "013-ramen.png",
  sandwich: "015-sandwich.png",
  taco: "005-taco.png",
  burger: "009-burger.png",
  pot: "022-cooking.png",
  pan: "023-stir-fry.png",
};

/** Drawn for the app in the same style. */
const SVGS = ["fish", "lemon", "coconut", "basket", "fridge", "snowflake"];

const FONTS: Record<string, string> = {
  "fredoka-500.woff2": "@fontsource/fredoka/files/fredoka-latin-500-normal.woff2",
  "fredoka-600.woff2": "@fontsource/fredoka/files/fredoka-latin-600-normal.woff2",
  "nunito-600.woff2": "@fontsource/nunito/files/nunito-latin-600-normal.woff2",
  "nunito-700.woff2": "@fontsource/nunito/files/nunito-latin-700-normal.woff2",
  "nunito-800.woff2": "@fontsource/nunito/files/nunito-latin-800-normal.woff2",
};

mkdirSync(OUT, { recursive: true });
for (const [name, file] of Object.entries(PNGS)) {
  const info = await sharp(join(PNG_DIR, file)).resize(SIZE, SIZE).webp({ quality: 88 }).toFile(join(OUT, `${name}.webp`));
  console.log(`${name}.webp ${(info.size / 1024).toFixed(1)} KB`);
}
for (const name of SVGS) copyFileSync(join("art", "drawn", `${name}.svg`), join(OUT, `${name}.svg`));

mkdirSync(join("public", "fonts"), { recursive: true });
for (const [out, from] of Object.entries(FONTS)) copyFileSync(join("node_modules", from), join("public", "fonts", out));
console.log(`${SVGS.length} SVG og ${Object.keys(FONTS).length} skrifter kopieret.`);
