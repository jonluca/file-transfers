const { getDefaultConfig } = require("expo/metro-config");
const { withUniwindConfig } = require("uniwind/metro");

const config = getDefaultConfig(__dirname);
config.resolver.assetExts.push("pem", "p12");
for (const extension of ["mjs", "cjs"]) {
  if (!config.resolver.sourceExts.includes(extension)) {
    config.resolver.sourceExts.push(extension);
  }
}

module.exports = withUniwindConfig(config, {
  cssEntryFile: "./globals.css",
});
