const { getDefaultConfig } = require("expo/metro-config");
const { withUniwindConfig } = require("uniwind/metro");

const config = getDefaultConfig(__dirname);
config.resolver.assetExts.push("pem", "p12");

module.exports = withUniwindConfig(config, {
  cssEntryFile: "./globals.css",
});
