const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "../..");
const dest = path.join(__dirname, "../src/idl");
fs.mkdirSync(dest, { recursive: true });
fs.copyFileSync(
  path.join(root, "target/idl/prediction_market.json"),
  path.join(dest, "prediction_market.json")
);
fs.copyFileSync(
  path.join(root, "target/types/prediction_market.ts"),
  path.join(dest, "prediction_market.ts")
);
console.log("copied IDL into app/src/idl");
