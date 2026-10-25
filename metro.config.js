const { getSentryExpoConfig } = require("@sentry/react-native/metro");
const { withUniwindConfig } = require("uniwind/metro");

const config = getSentryExpoConfig(__dirname);
for (const extension of ["mjs", "cjs"]) {
  if (!config.resolver.sourceExts.includes(extension)) {
    config.resolver.sourceExts.push(extension);
  }
}

module.exports = withUniwindConfig(config, {
  cssEntryFile: "./globals.css",
});
