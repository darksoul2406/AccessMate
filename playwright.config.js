import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  use: {
    channel: "chrome",
    launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] },
  },
});
